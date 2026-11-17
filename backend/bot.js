"use strict";

/**
 * Telegram Bot API client.
 * - long polling (webhook ki zaroorat nahi)
 * - /start /help /id /link /unlink /status
 * - OTP delivery + new-connection notifications
 *
 * bot.js auth.js ko require NAHI karta (cycle), isliye password verify
 * utils se hota hai.
 */

const config = require("./config");
const db = require("./database");
const u = require("./utils");

const API = "https://api.telegram.org";

let running = false;
let offset = 0;
let loopPromise = null;
let startedAt = 0;
let lastError = null;
let handled = 0;

const lastChatAt = new Map();
const CHAT_MIN_GAP = 1100;

const enabled = () => !!config.TELEGRAM_BOT_TOKEN;

function maskChat(id) {
  const s = String(id || "");
  if (s.length <= 4) return "••••";
  return "•••" + s.slice(-4);
}

async function api(method, payload, timeoutMs = 20000) {
  if (!enabled()) return { ok: false, error: "bot token missing" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      const err = (json && json.description) || `http ${res.status}`;
      lastError = err;
      return { ok: false, error: err };
    }
    return { ok: true, result: json.result };
  } catch (e) {
    lastError = e.message || String(e);
    return { ok: false, error: lastError };
  } finally {
    clearTimeout(timer);
  }
}

async function sendMessage(chatId, text, extra) {
  if (chatId === null || chatId === undefined || chatId === "") return false;
  const id = String(chatId);
  const now = Date.now();
  const gap = now - (lastChatAt.get(id) || 0);
  if (gap < CHAT_MIN_GAP) await new Promise((r) => setTimeout(r, CHAT_MIN_GAP - gap));
  lastChatAt.set(id, Date.now());

  const r = await api("sendMessage", {
    chat_id: id,
    text: String(text || "").slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(extra || {}),
  });

  if (!r.ok) {
    await api("sendMessage", {
      chat_id: id,
      text: String(text || "").replace(/<[^>]+>/g, "").slice(0, 4000),
      disable_web_page_preview: true,
    });
  }
  return r.ok;
}

async function notifyAdmins(text) {
  const ids = new Set(config.TELEGRAM_ADMIN_CHAT_IDS);
  try {
    const cur = db.panel_admins.find(
      { active: true, telegram_chat_id: { $nin: [null, ""] } },
      { projection: { telegram_chat_id: 1 } }
    );
    for await (const a of cur) ids.add(String(a.telegram_chat_id));
  } catch (_) {}
  if (!ids.size) return 0;
  await Promise.allSettled([...ids].map((id) => sendMessage(id, text)));
  return ids.size;
}

async function notifyUser(chatId, text) {
  if (!chatId) return false;
  return sendMessage(chatId, text);
}

async function sendOtp(chatId, code, label) {
  const lines = [
    "🔐 <b>TPC PANEL login code</b>",
    "",
    `<code>${u.escapeHtml(code)}</code>`,
    "",
    `Valid ${Math.round(config.OTP_TTL / 60)} min · ${u.escapeHtml(label || "account")}`,
    "Code kisi ko na do.",
  ];
  return sendMessage(chatId, lines.join("\n"));
}

function deviceLine(device) {
  const t = (device && device.telemetry) || {};
  return [
    `📱 <b>New device connected</b>`,
    "",
    `ID: <code>${u.escapeHtml(u.deviceShortId(device))}</code>`,
    `Model: ${u.escapeHtml([t.manufacturer, t.model].filter(Boolean).join(" ") || "unknown")}`,
    `Android: ${u.escapeHtml(t.android_version || "—")}`,
    `Carrier: ${u.escapeHtml(t.sim_carrier || "—")}`,
    `Version: ${u.escapeHtml(device.app_version || "—")}`,
    "",
    `<i>${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC</i>`,
  ].join("\n");
}

async function notifyNewConnection(device, owner) {
  if (!enabled() || !config.BOT_NOTIFY_CONNECTIONS) return;
  const text = deviceLine(device);
  await Promise.allSettled([
    notifyAdmins(text),
    owner && owner.telegram_chat_id
      ? sendMessage(owner.telegram_chat_id, `👤 <b>Aapki app</b>\n\n${text}`)
      : null,
  ]);
}

async function notifyDeviceOnline(device, owner) {
  if (!enabled() || !config.BOT_NOTIFY_CONNECTIONS) return;
  const text = [
    "🟢 <b>Device online</b>",
    `<code>${u.escapeHtml(u.deviceShortId(device))}</code> · ${u.escapeHtml(device.device_name || "Unknown")}`,
  ].join("\n");
  await Promise.allSettled([
    notifyAdmins(text),
    owner && owner.telegram_chat_id ? sendMessage(owner.telegram_chat_id, text) : null,
  ]);
}

// ------------------------------------------------------------- commands

async function reply(chatId, text, extra) {
  await sendMessage(chatId, text, extra);
}

async function handleStart(msg) {
  const chatId = String(msg.chat.id);
  const who = msg.from && (msg.from.username || msg.from.first_name) || "user";
  await reply(
    chatId,
    [
      `👋 <b>TPC PANEL bot</b>`,
      "",
      `Chat id: <code>${u.escapeHtml(chatId)}</code>`,
      `User: ${u.escapeHtml(who)}`,
      "",
      "Link karne ke liye:",
      "<code>/link TPC-XXXX-XXXX-XXXX apna-password</code>",
      "",
      "Commands: /link /unlink /status /id /help",
    ].join("\n")
  );
}

async function handleHelp(msg) {
  await reply(
    String(msg.chat.id),
    [
      "<b>Commands</b>",
      "<code>/link &lt;key&gt; &lt;password&gt;</code> — key ya admin account se bot jodo (OTP yahin aayega)",
      "<code>/unlink</code> — bot unlink karo (OTP band)",
      "<code>/status</code> — link status",
      "<code>/id</code> — apna chat id",
    ].join("\n")
  );
}

async function handleId(msg) {
  await reply(String(msg.chat.id), `Chat id: <code>${u.escapeHtml(String(msg.chat.id))}</code>`);
}

async function handleLink(msg, args) {
  const chatId = String(msg.chat.id);
  const key = u.normalizeKey(args[0] || "");
  const pass = String(args.slice(1).join(" ") || "");

  if (key.length < 8 || !pass) {
    await reply(chatId, "Format: <code>/link TPC-XXXX-XXXX-XXXX password</code>");
    return;
  }

  // key user?
  const doc = await u.keyDoc(key).catch(() => null);
  if (doc) {
    if (doc.blocked) return reply(chatId, "⛔ Ye key blocked hai.");
    if (!u.keyActive(doc)) return reply(chatId, "⌛ Ye key expire ho gayi hai.");
    if (!doc.password_hash) return reply(chatId, "🔑 Password set nahi hai — panel se reset karvao.");
    if (!u.verifyPassword(pass, doc.password_hash)) return reply(chatId, "❌ Password galat.");

    await db.panel_keys.updateOne(
      { _id: doc._id },
      {
        $set: {
          telegram_chat_id: chatId,
          telegram_username: (msg.from && msg.from.username) || null,
          telegram_linked_at: db.utcNow(),
        },
      }
    );
    await reply(
      chatId,
      `✅ Linked: <code>${u.escapeHtml(doc.key || key)}</code>\nAb login par OTP yahin aayega.`
    );
    u.logEvent("bot_link", { key: doc.key, chat: chatId });
    return;
  }

  // admin?
  const admin = await u.adminDoc(key).catch(() => null);
  if (admin) {
    if (!admin.active) return reply(chatId, "⛔ Ye admin disabled hai.");
    if (!u.verifyPassword(pass, admin.password_hash)) return reply(chatId, "❌ Password galat.");
    await db.panel_admins.updateOne(
      { _id: admin._id },
      {
        $set: {
          telegram_chat_id: chatId,
          telegram_username: (msg.from && msg.from.username) || null,
          telegram_linked_at: db.utcNow(),
        },
      }
    );
    await reply(chatId, `✅ Admin <code>${u.escapeHtml(admin.username)}</code> linked.`);
    u.logEvent("bot_link_admin", { username: admin.username, chat: chatId });
    return;
  }

  await reply(chatId, "❌ Key ya admin user nahi mila.");
}

async function handleUnlink(msg) {
  const chatId = String(msg.chat.id);
  const k = await db.panel_keys.updateMany(
    { telegram_chat_id: chatId },
    { $set: { telegram_chat_id: null, telegram_unlinked_at: db.utcNow() } }
  );
  const a = await db.panel_admins.updateMany(
    { telegram_chat_id: chatId },
    { $set: { telegram_chat_id: null, telegram_unlinked_at: db.utcNow() } }
  );
  const n = (k.modifiedCount || 0) + (a.modifiedCount || 0);
  await reply(chatId, n ? `✅ Unlinked (${n}).` : "Kuch linked nahi tha.");
}

async function handleStatus(msg) {
  const chatId = String(msg.chat.id);
  const key = await db.panel_keys.findOne({ telegram_chat_id: chatId });
  const admin = await db.panel_admins.findOne({ telegram_chat_id: chatId });
  if (key) return reply(chatId, `🔗 Linked to key <code>${u.escapeHtml(key.key)}</code>`);
  if (admin) return reply(chatId, `🔗 Linked to admin <code>${u.escapeHtml(admin.username)}</code>`);
  await reply(chatId, "🔓 Kuch linked nahi. <code>/link ...</code> use karo.");
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat || !msg.text) return;
  handled += 1;

  const text = String(msg.text).trim();
  if (!text.startsWith("/")) return;

  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();

  switch (cmd) {
    case "/start": return handleStart(msg);
    case "/help": return handleHelp(msg);
    case "/id": return handleId(msg);
    case "/link": return handleLink(msg, args);
    case "/unlink": return handleUnlink(msg);
    case "/status": return handleStatus(msg);
    default: return undefined;
  }
}

async function pollOnce() {
  const r = await api(
    "getUpdates",
    {
      offset: offset || undefined,
      timeout: config.BOT_POLL_TIMEOUT,
      allowed_updates: ["message", "edited_message"],
    },
    (config.BOT_POLL_TIMEOUT + 15) * 1000
  );

  if (!r.ok) {
    await new Promise((res) => setTimeout(res, 4000));
    return;
  }

  for (const update of r.result || []) {
    if (update.update_id >= offset) offset = update.update_id + 1;
    try { await handleUpdate(update); } catch (_) {}
  }
}

async function loop() {
  while (running) {
    try {
      await pollOnce();
    } catch (e) {
      lastError = e.message || String(e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function start() {
  if (!enabled()) {
    console.log("[bot] disabled (TELEGRAM_BOT_TOKEN missing)");
    return false;
  }
  if (running) return true;
  running = true;
  startedAt = Date.now();
  loopPromise = loop().catch((e) => {
    console.error("[bot] loop crash:", e.message || e);
    running = false;
  });
  console.log("[bot] polling started");
  return true;
}

async function stop() {
  running = false;
  await Promise.race([loopPromise, new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
}

async function status() {
  let me = null;
  if (enabled()) {
    const r = await api("getMe", {}, 8000);
    if (r.ok) me = { id: r.result.id, username: r.result.username };
  }
  return {
    enabled: enabled(),
    running,
    username: (me && me.username) || config.TELEGRAM_BOT_USERNAME || null,
    admin_chats: config.TELEGRAM_ADMIN_CHAT_IDS.length,
    notify_connections: config.BOT_NOTIFY_CONNECTIONS,
    otp_active: config.OTP_ACTIVE,
    handled,
    started_at: startedAt ? new Date(startedAt).toISOString() : null,
    last_error: lastError,
  };
}

module.exports = {
  enabled,
  start,
  stop,
  status,
  api,
  sendMessage,
  sendOtp,
  notifyAdmins,
  notifyUser,
  notifyNewConnection,
  notifyDeviceOnline,
  maskChat,
};