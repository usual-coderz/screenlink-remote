"use strict";

const express = require("express");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const auth = require("../auth");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

const DAY = 86400000;

function keyView(k) {
  const exp = k.expires_at;
  const expired = exp instanceof Date && exp.getTime() <= Date.now();
  const blocked = !!k.blocked;
  return {
    id: String(k._id),
    key: k.key || "",
    label: k.label || "",
    phone: k.phone || "",
    created_at: u.serializeDt(k.created_at),
    last_login_at: u.serializeDt(k.last_login_at),
    login_count: parseInt(k.login_count || 0, 10) || 0,
    expires_at: u.serializeDt(k.expires_at),
    blocked,
    expired,
    active: !blocked && !expired,
  };
}

async function keyOr404(keyId) {
  let doc;
  try {
    doc = await db.panel_keys.findOne({ _id: new db.ObjectId(String(keyId)) });
  } catch (_) {
    throw new u.HttpError(400, "Bad key id");
  }
  if (!doc) throw new u.HttpError(404, "Key not found");
  return doc;
}

function parseExpiry(s) {
  const raw = String(s || "").trim();
  if (!raw) throw new u.HttpError(400, "expires_at khali hai");
  const d = new Date(raw);
  if (isNaN(d)) throw new u.HttpError(400, "Date format galat (YYYY-MM-DD chahiye)");
  return d;
}

async function uniqueKey() {
  for (let i = 0; i < 6; i++) {
    const key = u.newKey();
    const exists = await db.panel_keys.findOne({ key_hash: u.keyHashFor(key) }, { projection: { _id: 1 } });
    if (!exists) return key;
  }
  return u.newKey();
}

router.get("/", ah(async (req, res) => {
  await auth.requireAdmin(req);

  const q = {};
  if (req.query.q && String(req.query.q).trim()) {
    const rx = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    q.$or = [{ key: rx }, { label: rx }, { phone: rx }];
  }
  if (req.query.active === "true") {
    q.blocked = { $ne: true };
    q.$and = [{ $or: [{ expires_at: null }, { expires_at: { $gt: new Date() } }] }];
  }

  const rows = await db.panel_keys.find(q).sort({ _id: -1 }).limit(500).toArray();
  res.json({ keys: rows.map(keyView) });
}));

router.post("/", ah(async (req, res) => {
  const admin = await auth.requireAdmin(req);
  const b = req.body || {};

  const days = b.days === null || b.days === undefined ? config.DEFAULT_KEY_DAYS : parseInt(b.days, 10);
  const key = await uniqueKey();
  const now = db.utcNow();

  const doc = {
    key,
    key_hash: u.keyHashFor(key),
    label: String(b.label || b.name || "").trim().slice(0, 60),
    phone: u.normalizeNumber(b.phone) || String(b.phone || "").trim().slice(0, 20),
    created_at: now,
    expires_at: Number.isFinite(days) && days > 0 ? new Date(now.getTime() + days * DAY) : null,
    blocked: false,
    login_count: 0,
    last_login_at: null,
    created_by: admin.name,
  };

  await db.panel_keys.insertOne(doc);
  u.logEvent("key_created", { key, label: doc.label }, null, admin.name);

  res.json({ status: "ok", key, expires_at: u.serializeDt(doc.expires_at), id: String(doc._id) });
}));

router.post("/:key_id/expiry", ah(async (req, res) => {
  const admin = await auth.requireAdmin(req);
  const doc = await keyOr404(req.params.key_id);
  const b = req.body || {};
  const now = new Date();

  let newExp;
  if (b.lifetime) {
    newExp = null;
  } else if (b.expires_at) {
    newExp = parseExpiry(b.expires_at);
  } else if (b.days !== null && b.days !== undefined) {
    const days = parseInt(b.days, 10);
    if (!Number.isFinite(days)) throw new u.HttpError(400, "days number chahiye");
    const cur = doc.expires_at;
    const base = cur instanceof Date && cur.getTime() > now.getTime() ? cur : now;
    newExp = new Date(base.getTime() + days * DAY);
  } else {
    newExp = null;
  }

  await db.panel_keys.updateOne(
    { _id: doc._id },
    { $set: { expires_at: newExp, expiry_updated_at: now, expiry_updated_by: admin.name } }
  );

  u.logEvent("key_expiry_set", { key: doc.key, expires_at: u.serializeDt(newExp) }, null, admin.name);
  res.json({ status: "ok", expires_at: u.serializeDt(newExp) });
}));

router.post("/:key_id/toggle", ah(async (req, res) => {
  const admin = await auth.requireAdmin(req);
  const doc = await keyOr404(req.params.key_id);
  const b = req.body || {};
  const blocked = b.blocked === undefined ? !doc.blocked : !!b.blocked;

  await db.panel_keys.updateOne({ _id: doc._id }, { $set: { blocked, blocked_at: blocked ? new Date() : null } });
  u.logEvent("key_toggle", { key: doc.key, blocked }, null, admin.name);

  res.json({ status: "ok", blocked });
}));

router.post("/:key_id/rotate", ah(async (req, res) => {
  const admin = await auth.requireAdmin(req);
  const doc = await keyOr404(req.params.key_id);

  const key = await uniqueKey();
  await db.panel_keys.updateOne(
    { _id: doc._id },
    { $set: { key, key_hash: u.keyHashFor(key), rotated_at: new Date(), rotated_by: admin.name } }
  );

  u.logEvent("key_rotated", { old: doc.key, new: key }, null, admin.name);
  res.json({ status: "ok", key });
}));

router.post("/:key_id/delete", ah(async (req, res) => {
  const admin = await auth.requireAdmin(req);
  const doc = await keyOr404(req.params.key_id);

  await db.panel_keys.deleteOne({ _id: doc._id });
  u.logEvent("key_deleted", { key: doc.key }, null, admin.name);

  res.json({ status: "ok" });
}));

module.exports = router;
module.exports.keyView = keyView;