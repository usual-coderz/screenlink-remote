"use strict";

const express = require("express");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const auth = require("../auth");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

function view(a) {
  return {
    id: String(a._id),
    username: a.username,
    active: a.active !== false,
    created_at: u.serializeDt(a.created_at),
    last_login_at: u.serializeDt(a.last_login_at),
    login_count: parseInt(a.login_count || 0, 10) || 0,
    telegram_linked: !!a.telegram_chat_id,
    telegram_masked: a.telegram_chat_id ? u.maskChatId(a.telegram_chat_id) : "",
  };
}

async function byId(id) {
  try {
    const doc = await db.panel_admins.findOne({ _id: new db.ObjectId(String(id)) });
    if (!doc) throw new u.HttpError(404, "Admin not found");
    return doc;
  } catch (e) {
    if (e instanceof u.HttpError) throw e;
    throw new u.HttpError(400, "Bad admin id");
  }
}

router.get("/", ah(async (req, res) => {
  await auth.requireAdmin(req);
  const rows = await db.panel_admins.find().sort({ _id: -1 }).limit(200).toArray();
  const envAdmins = Object.keys(config.ADMINS).map((n) => ({
    id: `env:${n}`,
    username: n,
    active: true,
    env: true,
    created_at: null,
    last_login_at: null,
    login_count: 0,
    telegram_linked: false,
    telegram_masked: "",
  }));
  res.json({ admins: [...envAdmins, ...rows.map(view)] });
}));

router.post("/", ah(async (req, res) => {
  const me = await auth.requireAdmin(req);
  const b = req.body || {};
  const username = String(b.username || "").trim();

  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw new u.HttpError(400, "username 3-32 char, sirf letters/digits/._-");
  }
  if (auth.adminMatch(username) || (await u.adminDoc(username))) {
    throw new u.HttpError(409, "Ye username already hai");
  }

  let password = String(b.password || "");
  if (!password) password = u.genPassword(12);
  const problem = u.passwordProblem(password);
  if (problem) throw new u.HttpError(400, problem);

  const doc = {
    username,
    username_lc: username.toLowerCase(),
    password_hash: u.hashPassword(password),
    active: true,
    created_at: db.utcNow(),
    created_by: me.name,
    login_count: 0,
    last_login_at: null,
    telegram_chat_id: null,
  };
  const r = await db.panel_admins.insertOne(doc);
  u.logEvent("admin_created", { username }, null, me.name);

  res.json({ status: "ok", admin: view({ ...doc, _id: r.insertedId }), password });
}));

router.post("/:id/password", ah(async (req, res) => {
  const me = await auth.requireAdmin(req);
  if (String(req.params.id).startsWith("env:")) {
    throw new u.HttpError(400, "Env admin ka password .env se badalta hai");
  }
  const doc = await byId(req.params.id);

  let password = String((req.body || {}).password || "");
  if (!password) password = u.genPassword(12);
  const problem = u.passwordProblem(password);
  if (problem) throw new u.HttpError(400, problem);

  await db.panel_admins.updateOne(
    { _id: doc._id },
    { $set: { password_hash: u.hashPassword(password), password_changed_at: db.utcNow() } }
  );
  u.logEvent("admin_password_reset", { username: doc.username }, null, me.name);
  res.json({ status: "ok", password });
}));

router.post("/:id/toggle", ah(async (req, res) => {
  const me = await auth.requireAdmin(req);
  if (String(req.params.id).startsWith("env:")) {
    throw new u.HttpError(400, "Env admin ko disable nahi kar sakte");
  }
  const doc = await byId(req.params.id);
  const active = (req.body || {}).active === undefined ? !(doc.active !== false) : !!(req.body || {}).active;

  await db.panel_admins.updateOne({ _id: doc._id }, { $set: { active } });
  u.logEvent("admin_toggle", { username: doc.username, active }, null, me.name);
  res.json({ status: "ok", active });
}));

router.post("/:id/unlink", ah(async (req, res) => {
  await auth.requireAdmin(req);
  if (String(req.params.id).startsWith("env:")) throw new u.HttpError(400, "Env admin");
  const doc = await byId(req.params.id);
  await db.panel_admins.updateOne(
    { _id: doc._id },
    { $set: { telegram_chat_id: null, telegram_unlinked_at: db.utcNow() } }
  );
  res.json({ status: "ok" });
}));

router.post("/:id/delete", ah(async (req, res) => {
  const me = await auth.requireAdmin(req);
  if (String(req.params.id).startsWith("env:")) throw new u.HttpError(400, "Env admin delete nahi hota");
  const doc = await byId(req.params.id);
  if (doc.username === me.name) throw new u.HttpError(400, "Apne aap ko delete nahi kar sakte");

  await db.panel_admins.deleteOne({ _id: doc._id });
  u.logEvent("admin_deleted", { username: doc.username }, null, me.name);
  res.json({ status: "ok" });
}));

module.exports = router;