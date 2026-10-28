"use strict";

const express = require("express");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const hub = require("../hub");
const auth = require("../auth");
const relay = require("../relay");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

function relayReady() {
  return !!(relay.TELETHON_OK && relay.relayClient && relay.relayState.authorized);
}

async function resolveChannel(cid, title) {
  let channelId = cid;
  let channelTitle = title || "";
  if (channelId && relayReady()) {
    try {
      const ent = await relay.relayClient.getEntity(u.asEntity(channelId));
      channelId = u.canonicalChannelId(ent, channelId);
      if (!channelTitle) channelTitle = ent.title || ent.username || "";
    } catch (_) {}
  }
  return { channelId, channelTitle };
}

router.get("/auto-sender", ah(async (req, res) => {
  await auth.requirePanel(req);
  const count = await db.devices.countDocuments({ "auto_sender.enabled": true }).catch(() => 0);
  res.json({
    relay_ready: relayReady(),
    telethon: relay.TELETHON_OK,
    account: relay.relayState.me,
    forward_user: relay.relayState.forward_user || config.DEFAULT_FWD_USER || "",
    channels: [...(await relay.enabledChannels())].sort(),
    devices_enabled: count,
  });
}));

router.post("/auto-sender/verify", ah(async (req, res) => {
  await auth.requirePanel(req);
  if (!relayReady()) throw new u.HttpError(400, "Pehle relay login karo (Relay page)");

  const cid = u.normChannelId((req.body || {}).channel_id);
  if (!cid) throw new u.HttpError(400, "Channel ID required");

  let ent;
  try {
    ent = await relay.relayClient.getEntity(u.asEntity(cid));
  } catch (e) {
    throw new u.HttpError(400, `Channel nahi mila: ${e.message || e}`);
  }

  const title = ent.title || ent.username || cid;
  let isAdmin = false;
  try {
    const perms = await relay.relayClient.getPermissions(ent);
    isAdmin = !!(perms && (perms.isAdmin || perms.isCreator));
  } catch (_) {}

  res.json({
    status: "ok",
    channel_id: u.canonicalChannelId(ent, cid),
    title: String(title),
    admin: isAdmin,
  });
}));

router.post("/auto-sender/test", ah(async (req, res) => {
  await auth.requirePanel(req);
  if (!relayReady()) throw new u.HttpError(400, "Relay logged in nahi hai");
  const ok = await relay.relaySendText("✅ TPC PANEL — Auto Sender test message.");
  if (!ok) throw new u.HttpError(400, "Test bheja nahi gaya — forward target check karo");
  res.json({ status: "ok" });
}));

router.post("/auto-sender/disable-all", ah(async (req, res) => {
  const admin = await auth.requirePanel(req);
  const r = await db.devices.updateMany(
    { "auto_sender.enabled": true },
    { $set: { "auto_sender.enabled": false, "auto_sender.updated_at": db.utcNow() } }
  );
  relay.invalidateChannelCache();
  u.logEvent("auto_sender_disable_all", { count: r.modifiedCount }, null, admin.name);
  res.json({ status: "ok", disabled: r.modifiedCount });
}));

router.post("/devices/:device_id/auto-sender", ah(async (req, res) => {
  const admin = await auth.requirePanel(req);
  const device = await u.getDeviceOr404(req.params.device_id);
  const b = req.body || {};
  const cur = u.autoSenderOf(device);

  const pick = (v, fallback) => (v === null || v === undefined ? fallback : v);

  const enabled = !!pick(b.enabled, cur.enabled);
  let channelId = pick(b.channel_id, cur.channel_id);
  let title = b.channel_title || cur.channel_title;
  const simSlots = pick(b.sim_slots, cur.sim_slots);
  const tgConfirm = !!pick(b.tg_confirm, cur.tg_confirm);

  channelId = channelId ? u.normChannelId(channelId) : null;

  if (channelId) {
    const r = await resolveChannel(channelId, title);
    channelId = r.channelId || channelId;
    title = r.channelTitle || title;
  }
  if (enabled && !channelId) throw new u.HttpError(400, "Enable karne ke liye Channel ID chahiye");

  const slots = u.normSlots(simSlots);
  const doc = {
    enabled,
    channel_id: channelId || null,
    channel_title: title || null,
    sim_slots: slots,
    tg_confirm: tgConfirm,
    updated_at: db.utcNow(),
  };

  await db.devices.updateOne({ _id: device._id }, { $set: { auto_sender: doc } });
  relay.invalidateChannelCache();

  const plain = {
    enabled,
    channel_id: channelId,
    channel_title: title,
    sim_slots: slots,
    tg_confirm: tgConfirm,
  };

  hub.broadcastDevice(String(device._id), { auto_sender: plain });
  u.logEvent(
    "auto_sender_update",
    { enabled, channel_id: channelId, sim_slots: slots },
    String(device._id),
    admin.name
  );

  res.json({ status: "ok", auto_sender: plain, watching: [...(await relay.enabledChannels())].sort() });
}));

module.exports = router;