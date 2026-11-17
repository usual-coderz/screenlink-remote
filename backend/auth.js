"use strict";

const crypto = require("crypto");
const config = require("./config");
const u = require("./utils");
const db = require("./database");
const bot = require("./bot");

const { HttpError } = u;

// ---------------------------------------------------------------- helpers

const constEq = u.safeEq;

const _loginFails = new Map();
let _lastSweep = 0;

function sweepFails(now = Date.now()) {
  if (now - _lastSweep < 30000) return;
  _lastSweep = now;
  const ttl = config.LOGIN_LOCK_SECONDS * 1000;
  for (const [ip, hits] of _loginFails) {
    const kept = hits.filter((t) => now - t < ttl);
    if (kept.length) _loginFails.set(ip, kept);
    else _loginFails.delete(ip);
  }
}

function recentFails(ip) {
  const now = Date.now();
  sweepFails(now);
  const ttl = config.LOGIN_LOCK_SECONDS * 1000;
  const hits = (_loginFails.get(ip) || []).filter((t) => now - t < ttl);
  if (hits.length) _loginFails.set(ip, hits);
  else _loginFails.delete(ip);
  return hits;
}

function pushFail(ip) {
  const hits = recentFails(ip);
  hits.push(Date.now());
  _loginFails.set(ip, hits);
  return hits;
}

function clearFails(ip) {
  _loginFails.delete(ip);
}

function loginThrottle(ip) {
  const hits = recentFails(ip);
  if (hits.length >= config.LOGIN_MAX_TRIES) {
    const elapsed = (Date.now() - hits[0]) / 1000;
    const wait = Math.max(1, Math.round(config.LOGIN_LOCK_SECONDS - elapsed));
    throw new HttpError(429, `Bahut zyada galat tries — ${wait}s baad try karo`);
  }
}

/** env admins (sync) */
function adminMatch(username) {
  if (!username) return null;
  const n = String(username).trim();
  if (n in config.ADMINS) return n;
  const low = n.toLowerCase();
  for (const k of Object.keys(config.ADMINS)) {
    if (k.toLowerCase() === low) return k;
  }
  return null;
}

/**
 * env admin + DB admin dono.
 * return: { kind:"env"|"db", username, id, telegram_chat_id, password_hash }
 */
async function resolveAdmin(username) {
  const env = adminMatch(username);
  if (env) {
    return {
      kind: "env",
      username: env,
      id: `env:${env}`,
      telegram_chat_id: null,
      password_hash: null,
    };
  }
  const doc = await u.adminDoc(username);
  if (!doc || !doc.active) return null;
  return {
    kind: "db",
    username: doc.username,
    id: String(doc._id),
    telegram_chat_id: doc.telegram_chat_id || null,
    password_hash: doc.password_hash,
    doc,
  };
}

function verifyAdminPassword(admin, password) {
  if (!admin) return false;
  if (admin.kind === "env") return constEq(password, config.ADMINS[admin.username] || "");
  return u.verifyPassword(password, admin.password_hash);
}

// ------------------------------------------------------------------ tokens

function sign(payload) {
  return crypto
    .createHmac("sha256", config.SESSION_SECRET)
    .update(payload)
    .digest("hex")
    .slice(0, 40);
}

function makeToken(adminId, ttl = config.TOKEN_TTL) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = `${adminId}|${exp}`;
  return Buffer.from(`${payload}|${sign(payload)}`, "utf8").toString("base64url");
}

function verifyToken(token) {
  try {
    if (!token) return null;
    const raw = Buffer.from(String(token), "base64url").toString("utf8");
    const parts = raw.split("|");
    if (parts.length < 3) return null;
    const sig = parts.pop();
    const exp = parts.pop();
    const adminId = parts.join("|");
    if (!adminId) return null;
    if (!constEq(sig, sign(`${adminId}|${exp}`))) return null;
    if (parseInt(exp, 10) < Date.now() / 1000) return null;
    return adminId;
  } catch (_) {
    return null;
  }
}

function splitIdent(ident) {
  if (!ident) return [null, null];
  const i = String(ident).indexOf(":");
  if (i > 0) {
    const role = String(ident).slice(0, i);
    const name = String(ident).slice(i + 1);
    if ((role === "admin" || role === "key") && name) return [role, name];
  }
  return ["admin", String(ident)];
}

function bearerIdentity(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.slice(0, 7).toLowerCase() === "bearer ") return verifyToken(auth.slice(7).trim());
  return null;
}

// --------------------------------------------------------------------- OTP

/**
 * OTP challenge banao + bhejo.
 * null return = OTP skip (band hai ya chat linked nahi).
 */
async function startOtp(ident, chatId, label) {
  if (!config.OTP_ACTIVE || !bot.enabled() || !chatId) return null;

  const code = u.genOtp();
  const salt = crypto.randomBytes(12).toString("base64url");
  const now = db.utcNow();

  const doc = {
    ident,
    salt,
    otp_hash: u.otpHash(code, salt),
    attempts: 0,
    used: false,
    created_at: now,
    expires_at: new Date(now.getTime() + config.OTP_TTL * 1000),
    chat_id: String(chatId),
  };

  const r = await db.login_challenges.insertOne(doc);
  const sent = await bot.sendOtp(chatId, code, label);
  if (!sent) {
    await db.login_challenges.deleteOne({ _id: r.insertedId }).catch(() => {});
    return null;
  }

  return {
    challenge: String(r.insertedId),
    masked: u.maskChatId(chatId),
    ttl: config.OTP_TTL,
    resend_after: config.OTP_RESEND_COOLDOWN,
  };
}

async function verifyOtp(challengeId, code) {
  let oid;
  try { oid = new db.ObjectId(String(challengeId)); } catch (_) { throw new HttpError(400, "Bad challenge"); }

  const doc = await db.login_challenges.findOne({ _id: oid });
  if (!doc || doc.used) throw new HttpError(400, "Code expire ho gaya — dobara login karo");
  if (doc.expires_at instanceof Date && doc.expires_at.getTime() <= Date.now()) {
    await db.login_challenges.deleteOne({ _id: doc._id }).catch(() => {});
    throw new HttpError(400, "Code expire ho gaya — dobara login karo");
  }
  if (doc.attempts >= config.OTP_MAX_ATTEMPTS) {
    throw new HttpError(429, "Bahut zyada galat code — dobara login karo");
  }

  const given = String(code || "").replace(/\D/g, "");
  if (!constEq(u.otpHash(given, doc.salt), doc.otp_hash)) {
    await db.login_challenges.updateOne({ _id: doc._id }, { $inc: { attempts: 1 } }).catch(() => {});
    throw new HttpError(401, "Code galat hai");
  }

  await db.login_challenges.updateOne(
    { _id: doc._id },
    { $set: { used: true, used_at: db.utcNow() } }
  ).catch(() => {});

  return doc.ident;
}

async function resendOtp(challengeId) {
  let oid;
  try { oid = new db.ObjectId(String(challengeId)); } catch (_) { throw new HttpError(400, "Bad challenge"); }

  const doc = await db.login_challenges.findOne({ _id: oid });
  if (!doc || doc.used) throw new HttpError(400, "Challenge khatam — dobara login karo");

  const age = (Date.now() - (doc.created_at instanceof Date ? doc.created_at.getTime() : 0)) / 1000;
  const sinceSend = (Date.now() - (doc.sent_at || doc.created_at || new Date(0)).getTime?.()) / 1000;

  if (Number.isFinite(sinceSend) && sinceSend < config.OTP_RESEND_COOLDOWN) {
    throw new HttpError(429, `Thoda ruko (${Math.ceil(config.OTP_RESEND_COOLDOWN - sinceSend)}s)`);
  }
  void age;

  const code = u.genOtp();
  const salt = crypto.randomBytes(12).toString("base64url");
  const now = db.utcNow();

  await db.login_challenges.updateOne(
    { _id: doc._id },
    {
      $set: {
        salt,
        otp_hash: u.otpHash(code, salt),
        attempts: 0,
        expires_at: new Date(now.getTime() + config.OTP_TTL * 1000),
        sent_at: now,
      },
    }
  );

  const ok = await bot.sendOtp(doc.chat_id, code, "TPC PANEL");
  if (!ok) throw new HttpError(502, "OTP bheja nahi gaya — bot check karo");

  return { ttl: config.OTP_TTL, masked: u.maskChatId(doc.chat_id) };
}

// ------------------------------------------------------------- login finish

async function completeLogin(req, ident, meta, ip) {
  req.session.adminId = ident;
  const [role, name] = splitIdent(ident);

  if (role === "key") {
    const doc = await u.keyDoc(name);
    if (doc) {
      await db.panel_keys.updateOne(
        { _id: doc._id },
        { $set: { last_login_at: db.utcNow(), last_ip: ip }, $inc: { login_count: 1 } }
      ).catch(() => {});
    }
    u.logEvent("key_login", { key: name, ip });
    return;
  }

  const admin = await resolveAdmin(name);
  if (admin && admin.kind === "db") {
    await db.panel_admins.updateOne(
      { _id: admin.doc._id },
      { $set: { last_login_at: db.utcNow(), last_ip: ip }, $inc: { login_count: 1 } }
    ).catch(() => {});
  }
  u.logEvent("admin_login", { username: name, ip }, null, name);
}

function loginPayload(ident, role, username, expiresAt) {
  return {
    status: "ok",
    role,
    username,
    token: makeToken(ident),
    expires_in: config.TOKEN_TTL,
    expires_at: u.serializeDt(expiresAt),
  };
}

// ------------------------------------------------------------------ guards

function requireApiKey(apiKey) {
  if (!config.ADMIN_API_KEY) throw new HttpError(401, "Admin API key not configured");
  if (!apiKey || !constEq(apiKey, config.ADMIN_API_KEY)) throw new HttpError(401, "Unauthorized");
}

async function requirePanel(req) {
  const ident = (req.session && req.session.adminId) || bearerIdentity(req);
  if (!ident) throw new HttpError(401, "Please log in");

  const [role, name] = splitIdent(ident);

  if (role === "admin") {
    const admin = await resolveAdmin(name);
    if (!admin) throw new HttpError(401, "Admin not recognised — dobara login karo");
    return {
      role: "admin",
      name: admin.username,
      admin_id: admin.id,
      owner_key_id: null,
      expires_at: null,
    };
  }

  const doc = (await u.keyDoc(name)) || (await u.keyDoc(String(name).replace(/-/g, "")));
  if (!doc) throw new HttpError(401, "Key not found");
  if (!u.keyActive(doc)) throw new HttpError(403, "Key expire/block ho gayi — admin se nayi lo");

  return {
    role: "key",
    name: doc.key || name,
    key_id: String(doc._id),
    owner_key_id: String(doc._id),
    expires_at: u.serializeDt(doc.expires_at),
  };
}

async function requireAdmin(req) {
  const ident = await requirePanel(req);
  if (ident.role !== "admin") throw new HttpError(403, "Sirf admin ke liye");
  return ident;
}

async function requirePanelOrKey(req) {
  try {
    return await requirePanel(req);
  } catch (_) {
    requireApiKey(req.headers["x-admin-key"] || null);
    return { role: "admin", name: "apikey", admin_id: "apikey", owner_key_id: null };
  }
}

module.exports = {
  constEq,
  recentFails,
  pushFail,
  clearFails,
  loginThrottle,
  adminMatch,
  resolveAdmin,
  verifyAdminPassword,
  makeToken,
  verifyToken,
  splitIdent,
  bearerIdentity,
  startOtp,
  verifyOtp,
  resendOtp,
  completeLogin,
  loginPayload,
  requireApiKey,
  requirePanel,
  requireAdmin,
  requirePanelOrKey,
};