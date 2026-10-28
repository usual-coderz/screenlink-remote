"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------------------------------------------------------------- .env loader
// dotenv package ke bina bhi kaam karta hai. systemd EnvironmentFile ko
// override NAHI karta (already-set vars chhode jaate hain).

function loadEnvFile(file) {
  let txt;
  try {
    txt = fs.readFileSync(file, "utf8");
  } catch (_) {
    return false;
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
  return true;
}

(function loadAll() {
  const cands = [
    path.resolve(__dirname, "..", ".env"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(__dirname, ".env"),
  ];
  const seen = new Set();
  for (const f of cands) {
    if (seen.has(f)) continue;
    seen.add(f);
    loadEnvFile(f);
  }
})();

// ---------------------------------------------------------------- config

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

// ADMIN_USERNAME/ADMIN_PASSWORD, ADMINS, ADMIN_USERS — sab support
function parseAdmins() {
  if (raw.ADMINS && typeof raw.ADMINS === "object" && !Array.isArray(raw.ADMINS)) {
    return raw.ADMINS;
  }

  const u = pick(process.env.ADMIN_USERNAME, process.env.ADMIN_USER, "");
  const p = pick(process.env.ADMIN_PASSWORD, process.env.ADMIN_PASS, "");
  if (u && p) return { [String(u).trim()]: String(p) };

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
const ADMINS = parseAdmins();

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
  SESSION_MAX_AGE: Number(
    pick(raw.SESSION_MAX_AGE, process.env.SESSION_MAX_AGE, 60 * 60 * 24 * 30)
  ),
  FORCE_SECURE: bool(pick(raw.FORCE_SECURE, process.env.COOKIE_SECURE), false),
  ADMINS,
  ADMIN_USERNAME: Object.keys(ADMINS)[0] || "",
  ADMIN_FILE: resolveAdminFile(),
  TRUST_PROXY: bool(process.env.TRUST_PROXY, true),
};

if (Object.keys(ADMINS).length === 0) {
  console.warn(
    "[env] WARN: koi admin nahi mila — .env me ADMINS=user:pass ya ADMIN_USERNAME/ADMIN_PASSWORD set karo"
  );
}
if (!SESSION_SECRET) {
  console.warn(
    "[env] WARN: SESSION_SECRET missing — random bana liya, restart pe sessions tootenge"
  );
}