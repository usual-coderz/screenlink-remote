"use strict";

const crypto = require("crypto");
const config = require("./config");
const u = require("./utils");

const { HttpError } = u;

// ---------------------------------------------------------------- helpers

function constEq(a, b) {
  try {
    const ba = Buffer.from(String(a), "utf8");
    const bb = Buffer.from(String(b), "utf8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (_) {
    return false;
  }
}

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

function checkPassword(username, password) {
  const key = adminMatch(username);
  if (!key) return null;
  return constEq(password, config.ADMINS[key]) ? key : null;
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
    const key = adminMatch(name) || name;
    if (!adminMatch(key)) throw new HttpError(401, "Admin not recognised — dobara login karo");
    return { role: "admin", name: key, expires_at: null };
  }

  const doc = (await u.keyDoc(name)) || (await u.keyDoc(String(name).replace(/-/g, "")));
  if (!doc) throw new HttpError(401, "Key not found");
  if (!u.keyActive(doc)) throw new HttpError(403, "Key expire/block ho gayi — admin se nayi lo");

  return {
    role: "key",
    name: doc.key || name,
    key_id: String(doc._id),
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
    return (await requirePanel(req)).name;
  } catch (_) {
    requireApiKey(req.headers["x-admin-key"] || null);
    return "apikey";
  }
}

function loginThrottle(ip) {
  const hits = recentFails(ip);
  if (hits.length >= config.LOGIN_MAX_TRIES) {
    const elapsed = (Date.now() - hits[0]) / 1000;
    const wait = Math.max(1, Math.round(config.LOGIN_LOCK_SECONDS - elapsed));
    throw new HttpError(429, `Bahut zyada galat tries — ${wait}s baad try karo`);
  }
}

module.exports = {
  constEq,
  recentFails,
  pushFail,
  clearFails,
  adminMatch,
  checkPassword,
  makeToken,
  verifyToken,
  splitIdent,
  bearerIdentity,
  requireApiKey,
  requirePanel,
  requireAdmin,
  requirePanelOrKey,
  loginThrottle,
  // legacy aliases
  require_admin_or_key: requirePanelOrKey,
  bearer_admin: bearerIdentity,
};