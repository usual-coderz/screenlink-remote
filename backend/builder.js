"use strict";

/**
 * APK builder bridge.
 * server.js isko import karke `router` mount karta hai aur `initUserSockets` se
 * /ws/user + /ws/app handle karta hai.
 * Agar aapka original python `backend/apk_builder` hi chalana hai to
 * BUILDER_ENGINE=python set karo — tab ye module python ko child_process se call karega.
 */

const fs = require("fs");
const path = require("path");
const { spawn: spawnProc } = require("child_process");
const express = require("express");
const config = require("./config");
const db = require("./database");
const u = require("./utils");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------------------------------------------------------------------ config

const builderConfig = {
  WORKER_MODE: process.env.BUILDER_WORKER_MODE || "inline",     // inline | external
  ENGINE: process.env.BUILDER_ENGINE || "node",                 // node | python
  MAX_CONCURRENT_BUILDS: parseInt(process.env.MAX_CONCURRENT_BUILDS || "2", 10),
  DEFAULT_VARIANT: process.env.DEFAULT_VARIANT || "prod",

  STORAGE_ROOT: process.env.STORAGE_ROOT || path.join(config.BASE_DIR, "storage"),
  BUILD_ROOT: process.env.BUILD_ROOT || path.join(config.BASE_DIR, "storage", "builds"),
  KEYSTORE_DIR: process.env.KEYSTORE_DIR || path.join(config.BASE_DIR, "storage", "keystores"),
  TEMPLATE_DIR: process.env.TEMPLATE_DIR || path.join(config.BASE_DIR, "apk_template"),
  PY_BUILDER: process.env.PY_BUILDER || "python3",

  GRADLE_BIN: process.env.GRADLE_BIN || "gradle",
  KEYTOOL_BIN: process.env.KEYTOOL_BIN || "keytool",
  APKSIGNER_BIN: process.env.APKSIGNER_BIN || "apksigner",
  ZIPALIGN_BIN: process.env.ZIPALIGN_BIN || "zipalign",
  DOCKER_BIN: process.env.DOCKER_BIN || "docker",

  USE_DOCKER: ["1", "true", "yes"].includes(String(process.env.USE_DOCKER || "").toLowerCase()),
  REQUIRE_SIGNATURE: !["0", "false", "no"].includes(String(process.env.REQUIRE_SIGNATURE || "true").toLowerCase()),
};

function ensureDirs() {
  for (const d of [builderConfig.STORAGE_ROOT, builderConfig.BUILD_ROOT, builderConfig.KEYSTORE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// -------------------------------------------------------------- build queue

class BuildQueue {
  constructor() {
    this.running = false;
    this.active = 0;
    this._timer = null;
    this.stats_data = { queued: 0, running: 0, done: 0, failed: 0 };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this._loop();
  }

  async stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
  }

  _loop() {
    if (!this.running) return;
    this._timer = setTimeout(() => this._tick().catch(() => {}).finally(() => this._loop()), 1500);
  }

  async _tick() {
    if (this.active >= builderConfig.MAX_CONCURRENT_BUILDS) return;
    const job = await db.builds.findOneAndUpdate(
      { status: "queued" },
      { $set: { status: "running", started_at: db.utcNow() } },
      { sort: { _id: 1 }, returnDocument: "after" },
    );
    if (!job) return;
    this.active += 1;
    runBuild(job)
      .catch((e) => db.builds.updateOne({ _id: job._id }, {
        $set: { status: "failed", error: String(e.message || e), finished_at: db.utcNow() },
      }).catch(() => {}))
      .finally(() => { this.active -= 1; });
  }

  async add(doc) {
    const res = await db.builds.insertOne({ ...doc, status: "queued", created_at: db.utcNow() });
    return res.insertedId;
  }

  stats() {
    return { ...this.stats_data, active: this.active, mode: builderConfig.WORKER_MODE };
  }
}

let _queue = null;
function initQueue() { if (!_queue) _queue = new BuildQueue(); return _queue; }
function getQueue() { return initQueue(); }
function bindLoop() { /* node me loop global hai — noop for parity */ }

// ------------------------------------------------------------ actual build

async function runBuild(job) {
  const workDir = path.join(builderConfig.BUILD_ROOT, String(job._id));
  fs.mkdirSync(workDir, { recursive: true });

  // python engine -> original apk_builder ko call karo
  if (builderConfig.ENGINE === "python") {
    return new Promise((resolve, reject) => {
      const p = spawnProc(builderConfig.PY_BUILDER, ["-m", "backend.apk_builder.worker", String(job._id)], {
        cwd: config.BASE_DIR, stdio: "inherit",
      });
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`python builder exit ${code}`))));
    });
  }

  // node engine -> template copy + gradle
  if (fs.existsSync(builderConfig.TEMPLATE_DIR)) {
    fs.cpSync(builderConfig.TEMPLATE_DIR, workDir, { recursive: true });
  }
  const artifact = path.join(workDir, "app", "build", "outputs", "apk", "release", "app-release.apk");

  const args = builderConfig.USE_DOCKER
    ? ["run", "--rm", "-v", `${workDir}:/w`, "-w", "/w", "gradle:8", "assembleRelease"]
    : ["assembleRelease"];

  await new Promise((resolve, reject) => {
    const p = spawnProc(builderConfig.USE_DOCKER ? builderConfig.DOCKER_BIN : builderConfig.GRADLE_BIN, args, {
      cwd: workDir, stdio: "inherit",
    });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build exit ${code}`))));
  });

  await db.builds.updateOne({ _id: job._id }, {
    $set: { status: "done", artifact, finished_at: db.utcNow() },
  });
  userHub.broadcast(String(job.userId || ""), { type: "build", status: "done", buildId: String(job._id), artifact });
}

// -------------------------------------------------------------- user rooms

class UserHub {
  constructor() { this.rooms = new Map(); }
  join(userId, ws) {
    if (!this.rooms.has(userId)) this.rooms.set(userId, new Set());
    this.rooms.get(userId).add(ws);
  }
  leave(userId, ws) {
    const s = this.rooms.get(userId);
    if (s) { s.delete(ws); if (!s.size) this.rooms.delete(userId); }
  }
  broadcast(userId, payload) {
    const s = this.rooms.get(userId);
    if (!s) return;
    const data = JSON.stringify(payload);
    for (const ws of s) { try { ws.send(data); } catch (_) {} }
  }
  userSocket(ws, req) {
    const userId = new URL(req.url, "http://x").searchParams.get("userId") || "anon";
    this.join(userId, ws);
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (String(msg.type || "").toLowerCase() === "ping") ws.send(JSON.stringify({ type: "pong" }));
      } catch (_) {}
    });
    ws.on("close", () => this.leave(userId, ws));
    ws.send(JSON.stringify({ type: "hello", server_time: db.utcNow().toISOString() }));
  }
  appSocket(ws) {
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (String(msg.type || "").toLowerCase() === "ping") ws.send(JSON.stringify({ type: "pong" }));
      } catch (_) {}
    });
  }
}

const userHub = new UserHub();

// ------------------------------------------------------------------- router

const router = express.Router();

router.get("/api/apps", ah(async (req, res) => {
  const userId = req.query.userId || null;
  const q = userId ? { userId } : {};
  res.json({ apps: await db.apps.find(q).sort({ _id: -1 }).limit(100).toArray() });
}));

router.post("/api/apps", ah(async (req, res) => {
  const b = req.body || {};
  const doc = {
    userId: b.userId || "anon",
    name: b.name || "My App",
    package: b.package || "",
    variant: b.variant || builderConfig.DEFAULT_VARIANT,
    config: b.config || {},
    created_at: db.utcNow(),
  };
  const r = await db.apps.insertOne(doc);
  res.json({ status: "ok", id: String(r.insertedId) });
}));

router.get("/api/builds", ah(async (req, res) => {
  const userId = req.query.userId || null;
  const q = userId ? { userId } : {};
  res.json({ builds: await db.builds.find(q).sort({ _id: -1 }).limit(100).toArray() });
}));

router.post("/api/builds", ah(async (req, res) => {
  const b = req.body || {};
  const id = await getQueue().add({
    userId: b.userId || "anon",
    appId: b.appId || null,
    variant: b.variant || builderConfig.DEFAULT_VARIANT,
    config: b.config || {},
  });
  res.json({ status: "ok", buildId: String(id) });
}));

router.get("/api/builds/:id", ah(async (req, res) => {
  const doc = await db.builds.findOne({ _id: new db.ObjectId(req.params.id) });
  if (!doc) throw new u.HttpError(404, "Build not found");
  res.json(u.serializeDocument(doc));
}));

router.get("/api/builds/:id/download", ah(async (req, res) => {
  const doc = await db.builds.findOne({ _id: new db.ObjectId(req.params.id) });
  if (!doc || !doc.artifact || !fs.existsSync(doc.artifact)) throw new u.HttpError(404, "APK not ready");
  res.download(doc.artifact);
}));

router.get("/api/orders", ah(async (req, res) => {
  res.json({ orders: await db.orders.find().sort({ _id: -1 }).limit(100).toArray() });
}));

router.post("/api/orders", ah(async (req, res) => {
  const r = await db.orders.insertOne({ ...(req.body || {}), created_at: db.utcNow() });
  res.json({ status: "ok", id: String(r.insertedId) });
}));

module.exports = {
  config: builderConfig,
  ensureDirs,
  bindLoop,
  initQueue,
  getQueue,
  stats: () => getQueue().stats(),
  router,
  userHub,
};