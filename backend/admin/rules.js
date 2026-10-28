"use strict";

const express = require("express");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const hub = require("../hub");
const auth = require("../auth");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

const MAX_RULES = 200;
const MAX_REPLY = 700;

async function evaluateRules(deviceId, deviceName, sender, body, kind) {
  let active;
  try {
    active = await db.rules.find({ enabled: true }).sort({ _id: 1 }).limit(50).toArray();
  } catch (_) {
    return 0;
  }

  const lower = String(body || "").toLowerCase();
  let queued = 0;

  for (const rule of active) {
    if (rule.upi_only && kind !== "upi") continue;

    const needle = String(rule.match || "").trim().toLowerCase();
    if (!needle) continue;

    let hit = false;
    if (rule.match_mode === "regex") {
      try {
        hit = new RegExp(rule.match, "i").test(body || "");
      } catch (_) {
        hit = false;
      }
    } else {
      hit = lower.includes(needle);
    }
    if (!hit) continue;

    const { amount } = u.classifySms(sender, body);
    const reply = String(rule.reply || "")
      .replace(/\{sender\}/g, sender || "")
      .replace(/\{device\}/g, deviceName || "")
      .replace(/\{amount\}/g, amount ? amount.toFixed(2) : "")
      .replace(/\{time\}/g, new Date().toISOString().slice(11, 16))
      .slice(0, MAX_REPLY);

    if (!reply) continue;

    const slots = rule.sim_slots && rule.sim_slots.length ? u.normSlots(rule.sim_slots) : [null];
    for (const slot of slots) {
      await hub.queueSms(deviceId, reply, sender, `auto:${rule.name || "rule"}`, deviceName, slot);
      queued += 1;
    }
    if (hub.hub.online(deviceId)) hub.spawn(hub.pushOutbox(deviceId));
  }

  return queued;
}

router.get("/", ah(async (req, res) => {
  await auth.requirePanel(req);
  const rows = await db.rules.find().sort({ _id: -1 }).limit(MAX_RULES).toArray();
  res.json({ rules: rows.map(u.serializeDocument) });
}));

router.post("/", ah(async (req, res) => {
  const admin = await auth.requirePanel(req);
  const b = req.body || {};

  const name = String(b.name || "").trim().slice(0, 60);
  const match = String(b.match || "").trim().slice(0, 200);
  const reply = String(b.reply || "").trim().slice(0, MAX_REPLY);

  if (!match) throw new u.HttpError(400, "match required");
  if (!reply) throw new u.HttpError(400, "reply required");
  if (b.match_mode === "regex") {
    try {
      new RegExp(match, "i");
    } catch (e) {
      throw new u.HttpError(400, `regex galat: ${e.message}`);
    }
  }

  const doc = {
    name,
    match,
    reply,
    match_mode: b.match_mode === "regex" ? "regex" : "substring",
    upi_only: !!b.upi_only,
    sim_slots: u.normSlots(b.sim_slots),
    enabled: b.enabled === undefined ? true : !!b.enabled,
    created_at: db.utcNow(),
    created_by: admin.name,
  };

  const r = await db.rules.insertOne(doc);
  u.logEvent("rule_created", { name: doc.name }, null, admin.name);

  res.json({ status: "ok", id: String(r.insertedId) });
}));

router.post("/:rule_id/toggle", ah(async (req, res) => {
  await auth.requirePanel(req);
  let rule;
  try {
    rule = await db.rules.findOne({ _id: new db.ObjectId(String(req.params.rule_id)) });
  } catch (_) {
    throw new u.HttpError(400, "Bad rule id");
  }
  if (!rule) throw new u.HttpError(404, "Rule not found");

  const newState = !(rule.enabled === undefined ? true : rule.enabled);
  await db.rules.updateOne({ _id: rule._id }, { $set: { enabled: newState, updated_at: db.utcNow() } });

  res.json({ status: "ok", enabled: newState });
}));

router.post("/:rule_id/update", ah(async (req, res) => {
  await auth.requirePanel(req);
  let rule;
  try {
    rule = await db.rules.findOne({ _id: new db.ObjectId(String(req.params.rule_id)) });
  } catch (_) {
    throw new u.HttpError(400, "Bad rule id");
  }
  if (!rule) throw new u.HttpError(404, "Rule not found");

  const b = req.body || {};
  const fields = { updated_at: db.utcNow() };
  if (b.name !== undefined) fields.name = String(b.name).trim().slice(0, 60);
  if (b.match !== undefined) fields.match = String(b.match).trim().slice(0, 200);
  if (b.reply !== undefined) fields.reply = String(b.reply).trim().slice(0, MAX_REPLY);
  if (b.upi_only !== undefined) fields.upi_only = !!b.upi_only;
  if (b.enabled !== undefined) fields.enabled = !!b.enabled;
  if (b.sim_slots !== undefined) fields.sim_slots = u.normSlots(b.sim_slots);

  await db.rules.updateOne({ _id: rule._id }, { $set: fields });
  res.json({ status: "ok" });
}));

router.post("/:rule_id/delete", ah(async (req, res) => {
  await auth.requirePanel(req);
  let oid;
  try {
    oid = new db.ObjectId(String(req.params.rule_id));
  } catch (_) {
    throw new u.HttpError(400, "Bad rule id");
  }
  await db.rules.deleteOne({ _id: oid });
  res.json({ status: "ok" });
}));

module.exports = router;
module.exports.evaluateRules = evaluateRules;