"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------------------------------------------------------------- .env loader
// config.js sabse pehle load ho sakta hai -> .env yahin padh lete hain.
// Already-set vars (systemd EnvironmentFile / shell export) override nahi hote.
(function loadEnv() {
  const cands = [
    path.resolve(__dirname, "..", ".env"),
    path.resolve(process.cwd(), ".env"),
  ];
  const seen = new Set();
  for (const f of cands) {
    if (seen.has(f)) continue;
    seen.add(f);
    let txt;
    try {
      txt = fs.readFileSync(f, "utf8");
    } catch (_) {
      continue;
    }
    for (let line of txt.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) line = line.slice(7).trim();
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
})();

const BASE_DIR = path.resolve(process.env.BASE_DIR || path.resolve(__dirname, ".."));
const SECRET_FILE = path.join(BASE_DIR, ".session_secret");

function envInt(name, def = 0) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}
function envNum(name, def = 0) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}
function envFlag(name, def = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
}
function envStr(name, def = "") {
  const v = process.env[name];
  return v === undefined || v === null || v === "" ? def : String(v);
}
/** numeric channel id -> number, username -> string, empty -> null */
function envChannel(name) {
  const v = envStr(name, "").trim();
  if (!v) return null;
  return /^-?\d+$/.test(v) ? Number(v) : v;
}
function resolveFile(cands, fallback) {
  for (const c of cands) {
    if (!c) continue;
    const abs = path.resolve(c);
    try {
      if (fs.statSync(abs).isFile()) return abs;
    } catch (_) {}
  }
  return path.resolve(fallback);
}

const config = {
  BASE_DIR,
  SECRET_FILE,
  ADMIN_FILE: resolveFile(
    [
      process.env.ADMIN_FILE,
      path.join(BASE_DIR, "admin", "index.html"),
      path.join(BASE_DIR, "frontend", "admin.html"),
      path.join(BASE_DIR, "public", "admin.html"),
      path.join(BASE_DIR, "backend", "public", "admin.html"),
      path.join(BASE_DIR, "admin.html"),
      path.join(BASE_DIR, "frontend", "index.html"),
      path.join(BASE_DIR, "public", "index.html"),
    ],
    path.join(BASE_DIR, "admin", "index.html")
  ),

  ADMIN_API_KEY: envStr("ADMIN_API_KEY", ""),
  COOKIE_NAME: envStr("COOKIE_NAME", "tpc_admin_session"),
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN || null,
  TRUST_PROXY: envFlag("TRUST_PROXY", true),

  SESSION_TTL: envInt("SESSION_TTL", 300),
  SESSION_MAX_AGE: envInt("SESSION_MAX_AGE", 60 * 60 * 24 * 30),
  TOKEN_TTL: envInt("TOKEN_TTL", 60 * 60 * 24 * 30),

  DEFAULT_KEY_DAYS: envInt("USER_TRIAL_DAYS", 30),

  ONLINE_WINDOW_SECONDS: envInt("ONLINE_WINDOW_SECONDS", 90),
  MAX_TELEMETRY_KEYS: 60,
  MAX_TELEMETRY_STRING: 300,
  MAX_WS_TEXT_BYTES: envInt("MAX_WS_TEXT_BYTES", 4_000_000),
  MAX_SMS_BODY: envInt("MAX_SMS_BODY", 1600),
  MAX_BROADCAST: envInt("MAX_BROADCAST", 500),

  WS_PING_INTERVAL: envInt("WS_PING_INTERVAL", 25),
  WS_IDLE_TIMEOUT: envInt("WS_IDLE_TIMEOUT", 120),
  OUTBOX_REPUSH_AFTER: envInt("OUTBOX_REPUSH_AFTER", 45),
  NUMBER_RETRY_AFTER: envInt("NUMBER_RETRY_AFTER", 300),

  STALE_AFTER_DAYS: envInt("DEVICE_STALE_DAYS", 7),
  IDLE_AFTER_HOURS: envInt("IDLE_AFTER_HOURS", 24),
  SEND_STUCK_AFTER: envInt("SEND_STUCK_AFTER", 180),
  EVENT_PRUNE_LIMIT: envInt("EVENT_PRUNE_LIMIT", 200000),
  TG_LOG_LIMIT: envInt("TG_LOG_LIMIT", 20000),
  ACTIVITY_LOG_LIMIT: envInt("ACTIVITY_LOG_LIMIT", 50000),

  LOGIN_MAX_TRIES: envInt("LOGIN_MAX_TRIES", 10),
  LOGIN_LOCK_SECONDS: envInt("LOGIN_LOCK_SECONDS", 120),

  KEY_ALPHABET: envStr("KEY_ALPHABET", "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"),

  TELE_API_ID: envInt("TELE_API_ID", 0),
  TELE_API_HASH: envStr("TELE_API_HASH", ""),
  TARGET_CHANNEL_ID: envChannel("TARGET_CHANNEL_ID"),
  DEFAULT_FWD_USER: envStr("DEFAULT_FWD_USER", "").trim(),
  RELAY_SESSION_FILE: envStr("RELAY_SESSION_FILE", path.join(BASE_DIR, "relay_session")),

  VERSION: envStr("APP_VERSION", "5.5.0"),
  LOG_LEVEL: envStr("LOG_LEVEL", "INFO"),
  FORCE_SECURE: envFlag("COOKIE_SECURE", false),

  // build ke waqt APK me inject hone wala public origin
  PUBLIC_BASE_URL: envStr("PUBLIC_BASE_URL", "").replace(/\/+$/, ""),

  MONGO_URL: envStr("MONGO_URL", envStr("MONGODB_URI", "mongodb://127.0.0.1:27017")),
  DB_NAME: envStr("DB_NAME", "tpc_panel"),

  UPI_KEYWORDS: ["upi", "credited", "debited", "vpa", "paid to", "received from"],
  AMOUNT_RE: /(?:rs.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
};

// ---- session secret: env -> file (atomic) -> generate ----
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
  try {
    // "wx" -> cluster me pehla writer jeeta, baaki re-read karein
    fs.writeFileSync(SECRET_FILE, v, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return [v, "generated"];
  } catch (_) {
    try {
      const existing = fs.readFileSync(SECRET_FILE, "utf8").trim();
      if (existing) return [existing, "file"];
    } catch (_) {}
    return [v, "generated"];
  }
}
const [SESSION_SECRET, SESSION_SECRET_SRC] = loadSessionSecret();
config.SESSION_SECRET = SESSION_SECRET;
config.SESSION_SECRET_SRC = SESSION_SECRET_SRC;

// rotation support — purane cookies bhi verify honge
config.SESSION_SECRET_OLD = String(process.env.SESSION_SECRET_OLD || "").trim() || null;

// ek hi canonical name + legacy fallbacks (ws.js inhe padhta hai)
config.COOKIE_NAMES = [
  ...new Set([config.COOKIE_NAME, "tpc_admin_session", "tpc_session"]),
];

// ---- admins: ADMIN_USERS / ADMINS / ADMIN_USERNAME+ADMIN_PASSWORD ----
function buildAdmins() {
  const users = {};

  const add = (u, p) => {
    u = String(u || "").trim();
    p = String(p || "");
    if (u && p) users[u] = p;
  };

  for (const src of [process.env.ADMIN_USERS, process.env.ADMINS]) {
    const raw = String(src || "").trim();
    if (!raw) continue;
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === "object" && !Array.isArray(j)) {
        for (const [k, v] of Object.entries(j)) add(k, v);
        continue;
      }
    } catch (_) {}
    for (const pair of raw.split(",")) {
      const i = pair.indexOf(":");
      if (i > -1) add(pair.slice(0, i), pair.slice(i + 1));
    }
  }

  const defU = process.env.ADMIN_USERNAME || "ivan";
  if (!(defU in users)) add(defU, process.env.ADMIN_PASSWORD || "Ahad@198612");

  return users;
}
config.ADMINS = buildAdmins();

module.exports = config;