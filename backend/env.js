"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let raw = {};
try {
  raw = require("./config") || {};
} catch (err) {
  console.warn("[env] ./config load fail — env vars se chal rahe hain:", err.message);
}

const pick = (...vals) => {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
};

const bool = (v, d) => {
  if (v === undefined || v === null || v === "") return d;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
};

const BASE_DIR = path.resolve(
  pick(raw.BASE_DIR, process.env.BASE_DIR, path.resolve(__dirname, ".."))
);

function parseAdmins() {
  if (raw.ADMINS && typeof raw.ADMINS === "object" && !Array.isArray(raw.ADMINS)) {
    return raw.ADMINS;
  }
  const s = pick(process.env.ADMINS, process.env.ADMIN_USERS, "");
  if (!s) return {};
  try {
    const j = JSON.parse(s);
    if (j && typeof j === "object" && !Array.isArray(j)) return j;
  } catch (_) {}
  const out = {};
  for (const pair of String(s).split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

function resolveAdminFile() {
  const cands = [
    raw.ADMIN_FILE,
    process.env.ADMIN_FILE,
    path.join(BASE_DIR, "frontend", "admin.html"),
    path.join(BASE_DIR, "public", "admin.html"),
    path.join(BASE_DIR, "backend", "public", "admin.html"),
    path.join(BASE_DIR, "admin.html"),
    path.join(BASE_DIR, "frontend", "index.html"),
    path.join(BASE_DIR, "public", "index.html"),
  ].filter(Boolean);

  for (const c of cands) {
    const abs = path.resolve(c);
    try {
      if (fs.statSync(abs).isFile()) return abs;
    } catch (_) {}
  }
  return path.resolve(cands[0]);
}

const SESSION_SECRET = pick(raw.SESSION_SECRET, process.env.SESSION_SECRET, "");

module.exports = {
  RAW: raw,
  BASE_DIR,
  VERSION: String(pick(raw.VERSION, process.env.APP_VERSION, "2.0.0")),
  COOKIE_NAME: String(pick(raw.COOKIE_NAME, process.env.COOKIE_NAME, "tpc_session")),
  COOKIE_DOMAIN: pick(raw.COOKIE_DOMAIN, process.env.COOKIE_DOMAIN, ""),
  SESSION_SECRET: SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  SESSION_SECRET_SRC: SESSION_SECRET
    ? (raw.SESSION_SECRET ? "config" : "env")
    : "generated",
  SESSION_MAX_AGE: Number(pick(raw.SESSION_MAX_AGE, process.env.SESSION_MAX_AGE, 60 * 60 * 24 * 30)),
  FORCE_SECURE: bool(pick(raw.FORCE_SECURE, process.env.COOKIE_SECURE), false),
  ADMINS: parseAdmins(),
  ADMIN_FILE: resolveAdminFile(),
  TRUST_PROXY: bool(process.env.TRUST_PROXY, true),
};