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
    let client;

    try {
      client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 8000,
      });

      await client.connect();

      const database = client.db(dbName);
      const collections = {};

      for (const name of COLLECTIONS) {
        collections[name] = database.collection(name);
      }

      await ensureIndexes(collections);

      const previousClient = _client;

      _client = client;
      _db = database;

      for (const name of COLLECTIONS) {
        _col[name] = collections[name];
      }

      if (previousClient && previousClient !== client) {
        await previousClient.close().catch(() => {});
      }

      console.log(`[database] Connected to ${dbName}`);

      return _db;
    } catch (err) {
      lastErr = err;

      try {
        await client?.close();
      } catch (_) {}

      console.error(
        `[database] Initialization attempt ${i}/${tries} failed:`,
        err.message
      );

      if (i < tries) {
        await sleep(delayMs);
      }
    }
  }

  throw lastErr;
}

async function ensureIndexes(collections = _col) {
  await collections.devices.createIndex({
    registration_id_hash: 1,
  });

  await collections.messages.createIndex({
    device_id: 1,
    _id: -1,
  });

  await collections.messages.createIndex({
    dedupe_key: 1,
  });

  await collections.outbox.createIndex({
    device_id: 1,
    status: 1,
  });

  await collections.panel_keys.createIndex(
    { key_hash: 1 },
    { unique: true, sparse: true }
  );

  await collections.install_fingerprints.createIndex(
    { android_id: 1 },
    {
      unique: true,
      partialFilterExpression: {
        android_id: { $type: "string" },
      },
    }
  );
}

async function checkDatabase() {
  try {
    if (!_db) {
      return {
        status: "error",
        error: "Database is not initialized",
      };
    }

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
  const result = {};

  if (!_db) {
    return result;
  }

  try {
    for (const name of ["apps", "builds", "orders"]) {
      result[name] = await _col[name].countDocuments({});
    }
  } catch (err) {
    console.error(
      "[database] Builder statistics failed:",
      err.message
    );
  }

  return result;
}

async function closeDb() {
  const client = _client;

  _client = null;
  _db = null;

  for (const name of COLLECTIONS) {
    delete _col[name];
  }

  try {
    await client?.close();
  } catch (_) {}
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