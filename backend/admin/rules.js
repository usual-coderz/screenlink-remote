"use strict";

const express = require("express");
const { ObjectId } = require("mongodb");
const db = require("../database");
const u = require("../utils");
const hub = require("../hub");
const auth = require("../auth");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

async function evaluateRules(deviceId, deviceName, sender, body, kind) {
  let active;
  try { active = await db.rules.find({ enabled: true }).limit(50).toArray(); }
  catch (_) { return 0; }

  const lower = String(body || "").toLowerCase();
  let queued = 0;

  for (const rule of active) {
    if (rule.upi_only && kind !== "upi") continue;
    const needle = String(rule.match || "").toLowerCase();
    if (!needle || !lower.includes(needle)) continue;

    const { amount } = u.classifySms(sender, body);
    const reply = String(rule.reply || "")
      .replace(/{sender}/g, sender || "")
      .replace(/{device}/g, deviceName || "")
      .replace(/{amount}/g, amount ? amount.toFixed(2) : "")
      .replace(/{time}/g, new Date().toISOString().slice(11, 16));

    await hub.queueSms(deviceId, reply, sender, `auto:${rule.name || "rule"}`, deviceName);
    queued += 1;
    if (hub.hub.online(deviceId)) hub.spawn(hub.pushOutbox(deviceId));
  }
  return queued;
}

router.get("/", ah(async (req, res) => {
  await auth.requirePanel(req);
  const rows = await db.rules.find().sort({ _id: -1 }).limit(200).toArray();
  res.json({ rules: rows.map(u.serializeDocument) });
}));

router.post("/", ah(async (req, res) => {
  const admin = await auth.requirePanel(req);
  const b = req.body || {};
  const doc = {
    name: String(b.name || "").trim(), match: String(b.match || "").trim(),
    reply: b.reply, upi_only: !!b.upi_only, enabled: true, created_at: db.utcNow(),
  };
  await db.rules.insertOne(doc);
  u.logEvent("rule_created", { name: doc.name }, null, admin.name);
  res.json({ status: "ok" });
}));

router.post("/:rule_id/toggle", ah(async (req, res) => {
  await auth.requirePanel(req);
  let rule;
  try { rule = await db.rules.findOne({ _id: new ObjectId(req.params.rule_id) }); }
  catch (_) { throw new u.HttpError(400, "Bad rule id"); }
  if (!rule) throw new u.HttpError(404, "Rule not found");
  const newState = !(rule.enabled === undefined ? true : rule.enabled);
  await db.rules.updateOne({ _id: rule._id }, { $set: { enabled: newState } });
  res.json({ status: "ok", enabled: newState });
}));

router.post("/:rule_id/delete", ah(async (req, res) => {
  await auth.requirePanel(req);
  let oid;
  try { oid = new ObjectId(req.params.rule_id); } catch (_) { throw new u.HttpError(400, "Bad rule id"); }
  await db.rules.deleteOne({ _id: oid });
  res.json({ status: "ok" });
}));

module.exports = router;
module.exports.evaluateRules = evaluateRules;