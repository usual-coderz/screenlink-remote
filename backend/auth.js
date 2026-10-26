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

function recentFails(ip) {
  const now = Date.now();
  const hits = (_loginFails.get(ip) || []).filter((t) => now - t < config.LOGIN_LOCK_SECONDS * 1000);
  _loginFails.set(ip, hits);
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
  if (username in config.ADMINS) return username;
  const low = username.toLowerCase();
  for (const k of Object.keys(config.ADMINS)) {
    if (k.toLowerCase() === low) return k;
  }
  return null;
}

// ------------------------------------------------------------------ tokens

function makeToken(adminId, ttl = config.TOKEN_TTL) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = `${adminId}|${exp}`;
  const sig = crypto.createHmac("sha256", config.SESSION_SECRET).update(payload).digest("hex").slice(0, 40);
  return Buffer.from(`${payload}|${sig}`, "utf8").toString("base64url");
}

function verifyToken(token) {
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const parts = raw.split("|");
    if (parts.length < 3) return null;
    const sig = parts.pop();
    const exp = parts.pop();
    const adminId = parts.join("|");
    const expected = crypto.createHmac("sha256", config.SESSION_SECRET)
      .update(`${adminId}|${exp}`).digest("hex").slice(0, 40);
    if (!constEq(sig, expected)) return null;
    if (parseInt(exp, 10) < Date.now() / 1000) return null;
    return adminId;
  } catch (_) {
    return null;
  }
}

function splitIdent(ident) {
  if (!ident) return [null, null];
  if (ident.includes(":")) {
    const i = ident.indexOf(":");
    const role = ident.slice(0, i);
    const name = ident.slice(i + 1);
    if ((role === "admin" || role === "key") && name) return [role, name];
  }
  return ["admin", ident];
}

function bearerIdentity(req) {
  const auth = req.headers.authorization || "";
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
  if (role === "admin") return { role: "admin", name, expires_at: null };

  const doc = (await u.keyDoc(name)) || (await u.keyDoc(name.replace(/-/g, "")));
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
  if (hits.length > config.LOGIN_MAX_TRIES) {
    const wait = Math.max(1, Math.round(config.LOGIN_LOCK_SECONDS - (Date.now() - hits[0]) / 1000));
    throw new HttpError(429, `Bahut zyada galat tries — ${wait}s baad try karo`);
  }
}

module.exports = {
  constEq,
  recentFails,
  pushFail,
  clearFails,
  adminMatch,
  makeToken,
  verifyToken,
  splitIdent,
  bearerIdentity,
  requireApiKey,
  requirePanel,
  requireAdmin,
  requirePanelOrKey,
  loginThrottle,
  require_admin_or_key: requirePanelOrKey,
  bearer_admin: bearerIdentity,
};