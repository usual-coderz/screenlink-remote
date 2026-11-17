"use strict";

const express = require("express");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const auth = require("../auth");
const bot = require("../bot");

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
    has_password: !!k.password_hash,
    telegram_linked: !!k.telegram_chat_id,
    telegram_masked: k.telegram_chat_id ? u.maskChatId(k.telegram_chat_id) : "",
    devices: parseInt(k.devices || 0, 10) || 0,
  };
}

async function keyOr404(keyId) {
  const doc = await u.keyById(keyId);
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

async function withDeviceCounts(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => String(r._id));
  const counts = new Map();
  try {
    const agg = await db.devices
      .aggregate([
        { $match: { owner_key_id: { $in: ids } } },
        { $group: { _id: "$owner_key_id", n: { $sum: 1 } } },
      ])
      .toArray();
    for (const a of agg) counts.set(String(a._id), a.n);
  } catch (_) {}
  return rows.map((r) => ({ ...r, devices: counts.get(String(r._id)) || 0 }));
}

// -------------------------------------------------------------------- self

router.get("/me", ah(async (req, res) => {
  const ident = await auth.requirePanel(req);
  if (ident.role !== "key") {
    return res.json({ role: "admin", name: ident.name, has_password: true });
  }
  const doc = await u.keyById(ident.key_id);
  if (!doc) throw new u.HttpError(404, "Key not found");
  res.json({
    role: "key",
    key: doc.key,
    label: doc.label || "",
    phone: doc.phone || "",
    expires_at: u.serializeDt(doc.expires_at),
    has_password: !!doc.password_hash,
    telegram_linked: !!doc.telegram_chat_id,
    telegram_masked: doc.telegram_chat_id ? u.maskChatId(doc.telegram_chat_id) : "",
    bot_username: config.TELEGRAM_BOT_USERNAME || null,
    otp_active: config.OTP_ACTIVE,
  });
}));

router.post("/me/password", ah(async (req, res) => {
  const ident = await auth.requirePanel(req);
  if (ident.role !== "key") throw new u.HttpError(400, "Sirf key user");

  const doc = await u.keyById(ident.key_id);
  if (!doc) throw new u.HttpError(404, "Key not found");

  const b = req.body || {};
  const current = String(b.current || "");
  const next = String(b.password || "");

  if (doc.password_hash && !u.verifyPassword(current, doc.password_hash)) {
    throw new u.HttpError(401, "Purana password galat hai");
  }
  const problem = u.passwordProblem(next);
  if (problem) throw new u.HttpError(400, problem);

  await db.panel_keys.updateOne(
    { _id: doc._id },
    { $set: { password_hash: u.hashPassword(next), password_changed_at: db.utcNow() } }
  );
  u.logEvent("key_password_self", { key: doc.key });
  res.json({ status: "ok" });
}));

router.post("/me/unlink-telegram", ah(async (req, res) => {
  const ident = await auth.requirePanel(req);
  if (ident.role !== "key") throw new u.HttpError(400, "Sirf key user");
  await db.panel_keys.updateOne(
    { _id: new db.ObjectId(ident.key_id) },
    { $set: { telegram_chat_id: null, telegram_unlinked_at: db.utcNow() } }
  );
  res.json({ status: "ok" });
}));

// ------------------------------------------------------------------- admin

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
  const withCounts = await withDeviceCounts(rows);
  res.json({ keys: withCounts.map(keyView) });
}));

router.post("/", ah(async (req, res) => {
  const admin = await auth.requireAdmin(req);
  const b = req.body || {};

  const days = b.days === null || b.days === undefined ? config.DEFAULT_KEY_DAYS : parseInt(b.days, 10);
  const key = await uniqueKey();
  const now = db.utcNow();

  let password = String(b.password || "");
  if (!password) password = u.genPassword(10);
  const problem = u.passwordProblem(password);
  if (problem) throw new u.HttpError(400, problem);

  const doc = {
    key,
    key_hash: u.keyHashFor(key),
    password_hash: u.hashPassword(password),
    label: String(b.label || b.name || "").trim().slice(0, 60),
    phone: u.normalizeNumber(b.phone) || String(b.phone || "").trim().slice(0, 20),
    created_at: now,
    expires_at: Number.isFinite(days) && days > 0 ? new Date(now.getTime() + days * DAY) : null,
    blocked: false,
    login_count: 0,
    last_login_at: null,
    telegram_chat_id: String(b.telegram_chat_id || "").trim() || null,
    created_by: admin.name,
  };

  await db.panel_keys.insertOne(doc);
  u.logEvent("key_created", { key, label: doc.label }, null, admin.name);

  res.json({
    status: "ok",
    key,
    password,
    expires_at: u.serializeDt(doc.expires_at),
    id: String(doc._id),
  });
}));

router.post("/:key_id/password", ah(async (req, res) => {
  const admin = await auth.requireAdmin(req);
  const doc = await keyOr404(req.params.key_id);

  let password = String((req.body || {}).password || "");
  if (!password) password = u.genPassword(10);
  const problem = u.passwordProblem(password);
  if (problem) throw new u.HttpError(400, problem);

  await db.panel_keys.updateOne(
    { _id: doc._id },
    { $set: { password_hash: u.hashPassword(password), password_changed_at: db.utcNow() } }
  );
  u.logEvent("key_password_reset", { key: doc.key }, null, admin.name);
  res.json({ status: "ok", password });
}));

router.post("/:key_id/telegram", ah(async (req, res) => {
  const admin = await auth.requireAdmin(req);
  const doc = await keyOr404(req.params.key_id);
  const chat = String((req.body || {}).chat_id || "").trim();

  await db.panel_keys.updateOne(
    { _id: doc._id },
    {
      $set: chat
        ? { telegram_chat_id: chat, telegram_linked_at: db.utcNow() }
        : { telegram_chat_id: null, telegram_unlinked_at: db.utcNow() },
    }
  );

  if (chat && (req.body || {}).notify) {
    await bot.sendMessage(
      chat,
      `✅ <b>TPC PANEL</b>\nIs chat par key <code>${u.escapeHtml(doc.key)}</code> ka OTP aayega.`
    );
  }
  res.json({ status: "ok" });
}));

router.post("/:key_id/expiry", ah(async (req, res) => {
  const admin = await auth.requireAdmin(req);
  const doc = await keyOr404(req.params.key_id);
  const b = req.body || {};
  const now = new Date();

  let newExp;
  if (b.lifetime) newExp = null;
  else if (b.expires_at) newExp = parseExpiry(b.expires_at);
  else if (b.days !== null && b.days !== undefined) {
    const days = parseInt(b.days, 10);
    if (!Number.isFinite(days)) throw new u.HttpError(400, "days number chahiye");
    const cur = doc.expires_at;
    const base = cur instanceof Date && cur.getTime() > now.getTime() ? cur : now;
    newExp = new Date(base.getTime() + days * DAY);
  } else newExp = null;

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
  const blocked = (req.body || {}).blocked === undefined ? !doc.blocked : !!(req.body || {}).blocked;

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