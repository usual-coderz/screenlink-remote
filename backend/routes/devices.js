"use strict";

const express = require("express");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const hub = require("../hub");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

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
    device = await db.devices.findOne({ registration_id_hash: u.hashValue(rid) });
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

// ---------------------------------------------------------------------- ack

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

module.exports = router;
module.exports.ackOutbox = ackOutbox;
module.exports.outboxCounters = outboxCounters;