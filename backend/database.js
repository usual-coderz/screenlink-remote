"use strict";

/**
 * backend/database.js
 * Hardened Mongo layer.
 *  - connect + reconnect watchdog
 *  - index failure connection ko kill nahi karta
 *  - lazy collection access (init se pehle bhi crash nahi)
 *  - DB autodetect + startup counts logging
 */

const { MongoClient, ObjectId, ReturnDocument } = require("mongodb");

let cfg = {};
try { cfg = require("./env"); } catch (_) { cfg = {}; }

const COLLECTIONS = [
  "devices",
  "messages",
  "outbox",
  "rules",
  "pairing_codes",
  "activity_logs",
  "banned_senders",
  "relay_config",
  "counters",
  "tg_logs",
  "device_events",
  "install_fingerprints",
  "panel_keys",
  "apps",
  "builds",
  "orders",
  "keystores",
];

const SKIP_DBS = new Set(["admin", "local", "config", "test"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const utcNow = () => new Date();

const state = {
  client: null,
  db: null,
  ready: false,
  connecting: null,
  attempts: 0,
  lastAttemptAt: null,
  lastError: null,
  connectedAt: null,
  dbName: null,
};

const _col = Object.create(null);
let _watchdog = null;

function envUri() {
  return (
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.MONGODB_URL ||
    process.env.DATABASE_URL ||
    "mongodb://127.0.0.1:27017"
  );
}

function envDbName() {
  return (
    process.env.DB_NAME ||
    process.env.MONGO_DB ||
    process.env.MONGODB_DB ||
    process.env.MONGO_DATABASE ||
    "tpc_panel"
  );
}

function clientOptions() {
  const uri = envUri();
  const opts = {
    serverSelectionTimeoutMS: Number(process.env.MONGO_SELECT_TIMEOUT_MS || 10000),
    connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 10000),
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 0),
    maxPoolSize: Number(process.env.MONGO_POOL_SIZE || 20),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 2),
    maxIdleTimeMS: 60000,
    retryWrites: true,
    retryReads: true,
    heartbeatFrequencyMS: 10000,
    appName: "tpc-panel",
  };
  if (/^mongodb\+srv:/.test(uri)) opts.tls = true;
  if (process.env.MONGO_TLS === "1") opts.tls = true;
  if (process.env.MONGO_TLS_INSECURE === "1") {
    opts.tls = true;
    opts.tlsAllowInvalidCertificates = true;
  }
  if (process.env.MONGO_DIRECT === "1") opts.directConnection = true;
  return opts;
}

function attachEvents(client) {
  client.on("serverHeartbeatFailed", () => { state.ready = false; });
  client.on("serverHeartbeatSucceeded", () => {
    state.ready = true;
    if (!state.connectedAt) state.connectedAt = new Date();
  });
  client.on("topologyClosed", () => { state.ready = false; });
  client.on("error", (e) => console.error("[database] client error:", e.message));
}

function coll(name) {
  if (_col[name]) return _col[name];
  if (!state.db) return null;
  _col[name] = state.db.collection(name);
  return _col[name];
}

async function createIndexSafe(c, keys, options = {}, label = "") {
  try {
    await c.createIndex(keys, options);
    return true;
  } catch (err) {
    const dup =
      err &&
      (err.code === 11000 ||
        err.codeName === "DuplicateKey" ||
        /duplicate key/i.test(err.message || ""));
    if (dup && options.unique) {
      console.warn(`[database] index ${label}: duplicate data — non-unique fallback`);
      const relaxed = { ...options };
      delete relaxed.unique;
      try {
        await c.createIndex(keys, relaxed);
        return true;
      } catch (e2) {
        console.warn(`[database] index ${label} relaxed fail: ${e2.message}`);
      }
    } else {
      console.warn(`[database] index ${label} fail: ${err.message}`);
    }
    return false;
  }
}

async function ensureIndexes() {
  const jobs = [
    ["devices", { registration_id_hash: 1 }, {}, "devices.registration_id_hash"],
    ["devices", { short_id: 1 }, { unique: true, sparse: true }, "devices.short_id"],
    ["devices", { last_seen: -1 }, {}, "devices.last_seen"],
    ["devices", { user_id: 1 }, {}, "devices.user_id"],
    ["messages", { device_id: 1, _id: -1 }, {}, "messages.device_id"],
    ["messages", { dedupe_key: 1 }, {}, "messages.dedupe_key"],
    ["messages", { created_at: -1 }, {}, "messages.created_at"],
    ["outbox", { device_id: 1, status: 1 }, {}, "outbox.device_status"],
    ["outbox", { created_at: 1 }, {}, "outbox.created_at"],
    ["panel_keys", { key_hash: 1 }, { unique: true, sparse: true }, "panel_keys.key_hash"],
    ["install_fingerprints", { android_id: 1 }, { unique: true, sparse: true }, "install_fingerprints.android_id"],
    ["banned_senders", { sender: 1 }, { unique: true, sparse: true }, "banned_senders.sender"],
    ["apps", { userId: 1, _id: -1 }, {}, "apps.userId"],
    ["builds", { status: 1, _id: 1 }, {}, "builds.queue"],
    ["builds", { userId: 1, _id: -1 }, {}, "builds.userId"],
    ["builds", { appId: 1 }, {}, "builds.appId"],
    ["orders", { appId: 1, _id: -1 }, {}, "orders.appId"],
    ["activity_logs", { created_at: -1 }, {}, "activity_logs.created_at"],
    ["device_events", { device_id: 1, _id: -1 }, {}, "device_events.device_id"],
    ["pairing_codes", { code: 1 }, { unique: true, sparse: true }, "pairing_codes.code"],
  ];

  for (const [name, keys, opts, label] of jobs) {
    const c = coll(name);
    if (!c) continue;
    await createIndexSafe(c, keys, opts, label);
  }
}

async function logCounts() {
  try {
    const parts = [];
    for (const n of ["devices", "messages", "builds", "apps", "orders", "keystores"]) {
      const c = coll(n);
      if (c) parts.push(`${n}=${await c.countDocuments({})}`);
    }
    console.log(`[database] ${state.dbName} → ${parts.join(" ")}`);
  } catch (err) {
    console.warn(`[database] counts fail: ${err.message}`);
  }
}

async function pickDatabase(client, wanted) {
  const primary = client.db(wanted);
  if (String(process.env.DB_AUTODETECT || "1") === "0") return primary;

  try {
    const cols = await primary.listCollections().toArray();
    if (cols.length) return primary;

    const info = await client.db("admin").admin().listDatabases();
    let best = null;

    for (const d of info.databases || []) {
      if (SKIP_DBS.has(d.name) || d.name === wanted) continue;
      try {
        const c = await client.db(d.name).listCollections().toArray();
        if (c.length && (!best || c.length > best.count)) {
          best = { name: d.name, count: c.length };
        }
      } catch (_) {}
    }

    if (best) {
      console.warn(
        `[database] "${wanted}" khaali hai — "${best.name}" me data mila (${best.count} collections), wahi use kar rahe hain`
      );
      return client.db(best.name);
    }
    return primary;
  } catch (err) {
    console.warn(`[database] autodetect skip: ${err.message}`);
    return primary;
  }
}

async function connectOnce() {
  const uri = envUri();
  const wanted = envDbName();
  const client = new MongoClient(uri, clientOptions());
  attachEvents(client);

  try {
    await client.connect();
    await client.db(wanted).command({ ping: 1 });

    const database = await pickDatabase(client, wanted);
    const prev = state.client;

    state.client = client;
    state.db = database;
    state.dbName = database.databaseName;

    for (const k of Object.keys(_col)) delete _col[k];
    for (const n of COLLECTIONS) _col[n] = database.collection(n);

    // index failure connection ko nahi maarta
    await ensureIndexes();

    state.ready = true;
    state.connectedAt = new Date();
    state.lastError = null;

    if (prev && prev !== client) {
      try { await prev.close(); } catch (_) {}
    }

    console.log(`[database] connected → ${state.dbName}`);
    await logCounts();
    return database;
  } catch (err) {
    try { await client.close(); } catch (_) {}
    throw err;
  }
}

async function initDbWithRetry(tries, delayMs) {
  const attempts = Number(tries || process.env.MONGO_RETRIES || 60);
  const delay = Number(delayMs || process.env.MONGO_RETRY_DELAY_MS || 2000);
  if (state.connecting) return state.connecting;

  state.connecting = (async () => {
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
      state.attempts = i;
      state.lastAttemptAt = new Date();
      try {
        return await connectOnce();
      } catch (err) {
        lastErr = err;
        state.ready = false;
        state.lastError = String(err.message || err);
        console.error(`[database] connect attempt ${i}/${attempts} fail: ${state.lastError}`);
        if (i < attempts) await sleep(delay);
      }
    }
    throw lastErr || new Error("mongo connect fail");
  })();

  try {
    return await state.connecting;
  } finally {
    state.connecting = null;
  }
}

function startWatchdog(intervalMs = Number(process.env.MONGO_WATCHDOG_MS || 15000)) {
  if (_watchdog) return;
  _watchdog = setInterval(async () => {
    if (state.connecting) return;
    try {
      if (!state.client || !state.ready) {
        await initDbWithRetry(1, 0);
      } else {
        await state.db.command({ ping: 1 });
        state.ready = true;
      }
    } catch (err) {
      state.ready = false;
      state.lastError = String(err.message || err);
    }
  }, intervalMs);
  if (_watchdog.unref) _watchdog.unref();
}

function stopWatchdog() {
  if (_watchdog) {
    clearInterval(_watchdog);
    _watchdog = null;
  }
}

function isReady() {
  return !!(state.ready && state.db);
}

function status() {
  return {
    ready: isReady(),
    db: state.dbName,
    attempts: state.attempts,
    connected_at: state.connectedAt ? state.connectedAt.toISOString() : null,
    last_error: state.lastError,
    uri: envUri().replace(/\/\/[^@/]*@/, "//***@"),
  };
}

async function checkDatabase() {
  if (!state.db) return { status: "error", error: "Database is not initialized" };
  try {
    await state.db.command({ ping: 1 });
    state.ready = true;
    return { status: "ok", db: state.db.databaseName, ready: true };
  } catch (err) {
    state.ready = false;
    state.lastError = String(err.message || err);
    return { status: "error", error: state.lastError };
  }
}

async function builderStats() {
  const result = {};
  for (const name of ["apps", "builds", "orders"]) {
    const c = coll(name);
    if (!c) continue;
    try { result[name] = await c.countDocuments({}); } catch (_) {}
  }
  return result;
}

async function closeDb() {
  stopWatchdog();
  const client = state.client;
  state.client = null;
  state.db = null;
  state.ready = false;
  for (const name of COLLECTIONS) delete _col[name];
  try { await client?.close(); } catch (_) {}
}

const getter = (name) => ({
  get: () => coll(name),
  enumerable: true,
  configurable: true,
});

module.exports = {
  ObjectId,
  ReturnDocument,
  utcNow,
  COLLECTIONS,
  initDbWithRetry,
  startWatchdog,
  stopWatchdog,
  checkDatabase,
  builderStats,
  closeDb,
  isReady,
  status,
  getCollection: coll,
  collection: coll,
  get db() { return state.db; },
  get ready() { return isReady(); },
};

for (const n of COLLECTIONS) {
  Object.defineProperty(module.exports, n, getter(n));
}