"use strict";

const express = require("express");
const db = require("../database");
const u = require("../utils");
const hub = require("../hub");
const auth = require("../auth");
const relay = require("../relay");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

router.get("/auto-sender", ah(async (req, res) => {
  await auth.requirePanel(req);
  const count = await db.devices.countDocuments({ "auto_sender.enabled": true }).catch(() => 0);
  res.json({
    relay_ready: !!(relay.relayClient && relay.relayState.authorized),
    telethon: relay.TELETHON_OK,
    account: relay.relayState.me,
    forward_user: relay.relayState.forward_user || require("../config").DEFAULT_FWD_USER || "",
    channels: [...(await relay.enabledChannels())].sort(),
    devices_enabled: count,
  });
}));

router.post("/auto-sender/verify", ah(async (req, res) => {
  await auth.requirePanel(req);
  if (!(relay.TELETHON_OK && relay.relayClient && relay.relayState.authorized)) throw new u.HttpError(400, "Pehle relay login karo (Relay page)");

  const cid = u.normChannelId((req.body || {}).channel_id);
  if (!cid) throw new u.HttpError(400, "Channel ID required");

  let ent;
  try { ent = await relay.relayClient.getEntity(u.asEntity(cid)); }
  catch (e) { throw new u.HttpError(400, `Channel nahi mila: ${e.message || e}`); }

  const title = ent.title || ent.username || cid;
  let isAdmin = false;
  try {
    const perms = await relay.relayClient.getPermissions(ent);
    isAdmin = !!(perms && (perms.isAdmin || perms.isCreator));
  } catch (_) {}

  res.json({ status: "ok", channel_id: u.canonicalChannelId(ent, cid), title: String(title), admin: isAdmin });
}));

router.post("/auto-sender/test", ah(async (req, res) => {
  await auth.requirePanel(req);
  if (!(relay.relayClient && relay.relayState.authorized)) throw new u.HttpError(400, "Relay logged in nahi hai");
  const ok = await relay.relaySendText("✅ TPC PANEL — Auto Sender test message.");
  if (!ok) throw new u.HttpError(400, "Test bheja nahi gaya — forward target check karo");
  res.json({ status: "ok" });
}));

router.post("/devices/:device_id/auto-sender", ah(async (req, res) => {
  const admin = await auth.requirePanel(req);
  const device = await u.getDeviceOr404(req.params.device_id);
  const b = req.body || {};

  const cur = u.autoSenderOf(device);
  let enabled = b.enabled === null || b.enabled === undefined ? cur.enabled : !!b.enabled;
  let channelId = b.channel_id === null || b.channel_id === undefined ? cur.channel_id : u.normChannelId(b.channel_id);
  let title = b.channel_title || cur.channel_title;
  const simSlots = b.sim_slots === null || b.sim_slots === undefined ? cur.sim_slots : u.normSlots(b.sim_slots);
  const tgConfirm = b.tg_confirm === null || b.tg_confirm === undefined ? cur.tg_confirm : !!b.tg_confirm;

  if (channelId && relay.relayClient && relay.relayState.authorized) {
    try {
      const ent = await relay.relayClient.getEntity(u.asEntity(channelId));
      channelId = u.canonicalChannelId(ent, channelId);
      if (!title) title = ent.title || ent.username || "";
    } catch (_) {}
  }
  if (enabled && !channelId) throw new u.HttpError(400, "Enable karne ke liye Channel ID chahiye");

  const doc = {
    enabled, channel_id: channelId || null, channel_title: title || null,
    sim_slots: simSlots, tg_confirm: tgConfirm, updated_at: db.utcNow(),
  };
  await db.devices.updateOne({ _id: device._id }, { $set: { auto_sender: doc } });
  relay.invalidateChannelCache();

  const plain = { enabled, channel_id: channelId, channel_title: title, sim_slots: simSlots, tg_confirm: tgConfirm };
  hub.broadcastDevice(req.params.device_id, { auto_sender: plain });
  u.logEvent("auto_sender_update", { enabled, channel_id: channelId, sim_slots: simSlots }, req.params.device_id, admin.name);

  res.json({ status: "ok", auto_sender: plain, watching: [...(await relay.enabledChannels())].sort() });
}));

module.exports = router;