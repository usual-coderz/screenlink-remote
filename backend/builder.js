"use strict";

/**
 * APK builder bridge.
 *
 * server.js isko import karke:
 *   builder.router      -> app.use(builder.router)
 *   builder.userHub.*   -> /ws/user, /ws/app upgrade handlers
 *   builder.config      -> /health/builder
 *   builder.getQueue()  -> lifespan start/stop + stats
 *   builder.preflight() -> startup par tool check
 *
 * ENGINE=python ho to original backend/apk_builder package child_process se chalta hai.
 * ENGINE=node   ho to yahin gradle (wrapper / docker) chalata hai.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn: spawnProc } = require("child_process");
const express = require("express");

const config = require("./config");
const db = require("./database");
const u = require("./utils");

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const IS_WIN = process.platform === "win32";
const WIN_EXT = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);

// ------------------------------------------------------------------ config

const builderConfig = {
  WORKER_MODE: process.env.BUILDER_WORKER_MODE || "inline", // inline | external
  ENGINE: process.env.BUILDER_ENGINE || "node", // node | python
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
  CLEAN_WORKDIR: ["1", "true", "yes"].includes(String(process.env.CLEAN_WORKDIR || "").toLowerCase()),

  BUILD_TIMEOUT_MS: parseInt(process.env.BUILD_TIMEOUT_MS || String(20 * 60 * 1000), 10),
  MAX_LOG_LINES: 500,
  QUOTA_PER_DAY: parseInt(process.env.BUILD_QUOTA_PER_DAY || "0", 10), // 0 = unlimited
};

function ensureDirs() {
  for (const d of [builderConfig.STORAGE_ROOT, builderConfig.BUILD_ROOT, builderConfig.KEYSTORE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// ----------------------------------------------------------------- helpers

const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const genSecret = () => crypto.randomBytes(24).toString("base64url");
const oid = (v) => {
  try { return new db.ObjectId(String(v)); } catch (_) { return null; }
};

// driver v4/v5/v6 dono ke saath chale
const unwrap = (r) => (r && Object.prototype.hasOwnProperty.call(r, "value") ? r.value : r);

function safeEq(a, b) {
  try {
    const ba = Buffer.from(String(a), "utf8");
    const bb = Buffer.from(String(b), "utf8");
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch (_) { return false; }
}

function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const shapeApp = (a) => ({
  appId: String(a._id),
  name: a.name || "Untitled app",
  package: a.package || "",
  variant: a.variant || builderConfig.DEFAULT_VARIANT,
  secret_last4: a.secret_last4 || "",
  builds_total: Number(a.builds_total || 0),
  created_at: a.created_at || null,
});

const shapeBuild = (b) => ({
  buildId: String(b._id),
  appId: b.appId || "",
  appName: b.appName || b.appId || "",
  status: b.status || "queued",
  variant: b.variant || builderConfig.DEFAULT_VARIANT,
  duration_ms: Number(b.duration_ms || 0),
  apk_size: Number(b.apk_size || 0),
  apk_sha256: b.apk_sha256 || "",
  log_tail: Array.isArray(b.log_tail) ? b.log_tail : [],
  error: b.error || null,
  created_at: b.created_at || null,
});

async function quota() {
  if (!builderConfig.QUOTA_PER_DAY) return { unlimited: true, daily_limit: 0, used_today: 0 };
  let used = 0;
  try { used = await db.builds.countDocuments({ created_at: { $gte: startOfDay() } }); } catch (_) {}
  return { unlimited: false, daily_limit: builderConfig.QUOTA_PER_DAY, used_today: used };
}

// ------------------------------------------------------------- tool lookup

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function whichSync(cmd) {
  if (!cmd) return null;
  cmd = String(cmd).trim();
  if (!cmd) return null;
  if (cmd.includes("/") || cmd.includes("\\")) return isFile(cmd) ? cmd : null;

  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = IS_WIN ? WIN_EXT : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      if (isFile(full)) return full;
    }
  }
  return null;
}

function ensureExec(p) {
  if (!p || IS_WIN) return p;
  try { fs.chmodSync(p, 0o755); } catch (_) {}
  return p;
}

/**
 * gradle resolve order:
 *   1. GRADLE_BIN (jab explicit path diya ho)
 *   2. build workDir / template ka gradle wrapper (gradlew | gradlew.bat)
 *   3. PATH par gradle
 * Wapas: { bin, source, shell } ya null
 */
function resolveGradle(workDir) {
  const override = String(builderConfig.GRADLE_BIN || "").trim();

  if (override && override !== "gradle") {
    const abs = whichSync(override);
    if (abs) return { bin: ensureExec(abs), source: "GRADLE_BIN", shell: IS_WIN };
  }

  const wrapperName = IS_WIN ? "gradlew.bat" : "gradlew";
  for (const dir of [workDir, builderConfig.TEMPLATE_DIR].filter(Boolean)) {
    const p = path.join(dir, wrapperName);
    if (isFile(p)) return { bin: ensureExec(p), source: "gradle-wrapper", shell: IS_WIN };
  }

  const onPath = whichSync("gradle");
  if (onPath) return { bin: onPath, source: "PATH", shell: IS_WIN };

  return null;
}

function gradleHint() {
  return (
    "gradle nahi mila. Fix options: " +
    "(a) backend/apk_template mein gradle wrapper daalo (gradlew + gradle/wrapper/gradle-wrapper.jar), " +
    "(b) system par Gradle install karo (apt/sdkman/brew), " +
    "(c) GRADLE_BIN=/abs/path/to/gradle set karo, ya " +
    "(d) USE_DOCKER=1 karke docker gradle:8 image use karo."
  );
}

function preflight() {
  const tools = { gradle: null, docker: null, java: null, python: null, keytool: null, apksigner: null, zipalign: null };
  const problems = [];

  tools.java = whichSync("java");
  tools.docker = whichSync(builderConfig.DOCKER_BIN) || whichSync("docker");
  tools.python = whichSync(builderConfig.PY_BUILDER);
  tools.keytool = whichSync(builderConfig.KEYTOOL_BIN);
  tools.apksigner = whichSync(builderConfig.APKSIGNER_BIN);
  tools.zipalign = whichSync(builderConfig.ZIPALIGN_BIN);

  const g = resolveGradle(builderConfig.TEMPLATE_DIR);
  tools.gradle = g ? { path: g.bin, source: g.source } : null;

  const templateOk = fs.existsSync(builderConfig.TEMPLATE_DIR);
  if (!templateOk) problems.push(`TEMPLATE_DIR missing: ${builderConfig.TEMPLATE_DIR}`);

  if (builderConfig.ENGINE === "python") {
    if (!tools.python) problems.push(`PY_BUILDER "${builderConfig.PY_BUILDER}" PATH par nahi mila.`);
  } else if (builderConfig.USE_DOCKER) {
    if (!tools.docker) problems.push(`USE_DOCKER=1 hai par docker binary nahi mila (DOCKER_BIN=${builderConfig.DOCKER_BIN}).`);
  } else if (!g) {
    problems.push(gradleHint());
  }

  if (builderConfig.REQUIRE_SIGNATURE && !tools.java) {
    problems.push("java nahi mila — signing / zipalign fail hoga (JDK 17 install karo).");
  }

  return {
    ok: problems.length === 0,
    platform: process.platform,
    engine: builderConfig.ENGINE,
    use_docker: builderConfig.USE_DOCKER,
    template_ok: templateOk,
    tools,
    problems,
  };
}

// ---------------------------------------------------------- process runner

function runProcess(bin, args, opts, onData, timeoutMs) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawnProc(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...opts });
    } catch (e) {
      return reject(e);
    }

    let spawnFailed = false;
    const killTimer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch (_) {}
    }, timeoutMs);

    p.stdout.on("data", onData);
    p.stderr.on("data", onData);

    p.on("error", (e) => {
      spawnFailed = true;
      clearTimeout(killTimer);
      if (e.code === "ENOENT") {
        reject(new Error(`spawn ${bin} ENOENT — binary nahi mila (resolved path: ${bin}). ${gradleHint()}`));
      } else {
        reject(e);
      }
    });

    p.on("close", (code, signal) => {
      if (spawnFailed) return;
      clearTimeout(killTimer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(bin)} exit ${code}${signal ? ` signal=${signal}` : ""}`));
    });
  });
}

function findApk(root) {
  const stack = [root];
  let fallback = null;
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".apk")) {
        if (/release/i.test(e.name)) return full;
        fallback = fallback || full;
      }
    }
  }
  return fallback;
}

// -------------------------------------------------------------- build queue

class BuildQueue {
  constructor() {
    this.running = false;
    this.active = 0;
    this._timer = null;
    this.counts = { queued: 0, running: 0, done: 0, failed: 0, canceled: 0 };
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

    let job = null;
    try {
      job = unwrap(await db.builds.findOneAndUpdate(
        { status: "queued" },
        { $set: { status: "running", started_at: db.utcNow() } },
        { sort: { _id: 1 }, returnDocument: "after" },
      ));
    } catch (_) { return; }
    if (!job) return;

    this.counts.queued = Math.max(0, this.counts.queued - 1);
    this.active += 1;
    this.counts.running = this.active;

    runBuild(job)
      .then(() => {
        this.counts.running = Math.max(0, this.counts.running - 1);
        this.counts.done += 1;
      })
      .catch(async (e) => {
        this.counts.running = Math.max(0, this.counts.running - 1);
        this.counts.failed += 1;
        try {
          await db.builds.updateOne({ _id: job._id }, {
            $set: { status: "failed", error: String(e.message || e), finished_at: db.utcNow() },
          });
        } catch (_) {}
        userHub.broadcast(String(job.userId || ""), {
          type: "build",
          data: { buildId: String(job._id), status: "failed", error: String(e.message || e) },
        });
      })
      .finally(() => { this.active = Math.max(0, this.active - 1); });
  }

  async add(doc) {
    const res = await db.builds.insertOne({
      ...doc,
      status: "queued",
      created_at: db.utcNow(),
      log_tail: [],
    });
    this.counts.queued += 1;
    return res.insertedId;
  }

  stats() {
    return {
      ...this.counts,
      active: this.active,
      mode: builderConfig.WORKER_MODE,
      engine: builderConfig.ENGINE,
      max_concurrent: builderConfig.MAX_CONCURRENT_BUILDS,
    };
  }
}

let _queue = null;
function initQueue() {
  if (!_queue) _queue = new BuildQueue();
  return _queue;
}
function getQueue() { return initQueue(); }
function bindLoop() {
  const pf = preflight();
  if (pf.ok) console.log("[builder] preflight ok — engine=%s", builderConfig.ENGINE);
  else for (const p of pf.problems) console.warn("[builder] WARN: %s", p);
  return pf;
}

// ------------------------------------------------------------ actual build

async function runBuild(job) {
  const t0 = Date.now();
  const buildId = String(job._id);
  const workDir = path.join(builderConfig.BUILD_ROOT, buildId);
  fs.mkdirSync(workDir, { recursive: true });

  const logs = [];
  let lastFlush = 0;

  const flush = async (force) => {
    const now = Date.now();
    if (!force && now - lastFlush < 1200) return;
    lastFlush = now;
    try {
      await db.builds.updateOne({ _id: job._id }, { $set: { log_tail: logs.slice(-builderConfig.MAX_LOG_LINES) } });
    } catch (_) {}
    userHub.broadcast(String(job.userId || ""), {
      type: "build",
      data: { buildId, status: "running", log_tail: logs.slice(-40) },
    });
  };

  const pushLog = (chunk) => {
    const text = String(chunk || "").replace(/\r/g, "");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      logs.push(line.slice(0, 500));
    }
    while (logs.length > builderConfig.MAX_LOG_LINES) logs.shift();
    flush(false).catch(() => {});
  };

  const log = (s) => pushLog(`[builder] ${s}`);

  const canceled = async () => {
    try {
      const cur = await db.builds.findOne({ _id: job._id }, { projection: { status: 1 } });
      return cur && cur.status === "canceled";
    } catch (_) { return false; }
  };

  log(`build ${buildId} start — engine=${builderConfig.ENGINE} variant=${job.variant || builderConfig.DEFAULT_VARIANT}`);

  try {
    if (builderConfig.ENGINE === "python") {
      // ---- python engine -> original apk_builder ko call karo ----
      const pyBin = whichSync(builderConfig.PY_BUILDER) || builderConfig.PY_BUILDER;
      log(`$ ${pyBin} -m backend.apk_builder.worker ${buildId}`);
      await runProcess(
        pyBin,
        ["-m", "backend.apk_builder.worker", buildId],
        { cwd: config.BASE_DIR, env: { ...process.env, BUILD_DIR: workDir } },
        pushLog,
        builderConfig.BUILD_TIMEOUT_MS,
      );
    } else {
      // ---- node engine -> template copy + gradle / docker ----
      if (fs.existsSync(builderConfig.TEMPLATE_DIR)) {
        log("copying template…");
        fs.cpSync(builderConfig.TEMPLATE_DIR, workDir, { recursive: true });
      } else {
        log(`template missing at ${builderConfig.TEMPLATE_DIR} (build continues)`);
      }

      const variant = String(job.variant || builderConfig.DEFAULT_VARIANT).toLowerCase();
      const task = variant === "debug" ? "assembleDebug" : "assembleRelease";

      let bin, args, opts;

      if (builderConfig.USE_DOCKER) {
        const dockerBin = whichSync(builderConfig.DOCKER_BIN) || whichSync("docker");
        if (!dockerBin) throw new Error(`docker nahi mila (USE_DOCKER=1). DOCKER_BIN=${builderConfig.DOCKER_BIN}`);

        const mount = IS_WIN ? path.resolve(workDir).replace(/\\/g, "/") : workDir;
        bin = dockerBin;
        args = ["run", "--rm", "-v", `${mount}:/w`, "-w", "/w", "gradle:8", task];
        opts = { cwd: workDir, env: { ...process.env } };
      } else {
        const g = resolveGradle(workDir);
        if (!g) throw new Error(gradleHint());

        bin = g.bin;
        args = [task];
        opts = { cwd: workDir, env: { ...process.env }, shell: g.shell };
        log(`gradle source=${g.source}`);
      }

      log(`$ ${bin} ${args.join(" ")}`);
      await runProcess(bin, args, opts, pushLog, builderConfig.BUILD_TIMEOUT_MS);
    }

    if (await canceled()) {
      log("canceled — artifact skipped");
      return;
    }

    // ---- artifact dhoondo ----
    const outRoot = path.join(workDir, "app", "build", "outputs", "apk");
    const artifact = fs.existsSync(outRoot) ? findApk(outRoot) : null;

    const patch = {
      status: "success",
      finished_at: db.utcNow(),
      duration_ms: Date.now() - t0,
      log_tail: logs.slice(-builderConfig.MAX_LOG_LINES),
    };

    if (artifact && fs.existsSync(artifact)) {
      try {
        const stable = path.join(builderConfig.BUILD_ROOT, `${buildId}.apk`);
        fs.copyFileSync(artifact, stable);
        const buf = fs.readFileSync(stable);
        patch.artifact = stable;
        patch.apk_name = path.basename(artifact);
        patch.apk_size = buf.length;
        patch.apk_sha256 = sha256hex(buf);
        log(`artifact: ${path.basename(artifact)} (${buf.length} bytes) sha256=${patch.apk_sha256.slice(0, 16)}…`);
      } catch (e) {
        log(`artifact read fail: ${e.message || e}`);
      }
    } else {
      log("warning: koi .apk output nahi mila");
    }

    await db.builds.updateOne({ _id: job._id }, { $set: patch });

    if (job.appId) {
      try { await db.apps.updateOne({ _id: oid(job.appId) }, { $inc: { builds_total: 1 } }); } catch (_) {}
    }

    userHub.broadcast(String(job.userId || ""), {
      type: "build",
      data: { buildId, status: "success", apk_size: patch.apk_size || 0, duration_ms: patch.duration_ms },
    });
    log("done");
  } finally {
    await flush(true).catch(() => {});
    if (builderConfig.CLEAN_WORKDIR) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
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
    if (!s || !s.size) return;
    const data = JSON.stringify(payload);
    for (const ws of s) { try { ws.send(data); } catch (_) {} }
  }

  common(ws, req, userId) {
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      const type = String(msg.type || "").toLowerCase();
      if (type === "ping") { try { ws.send(JSON.stringify({ type: "pong" })); } catch (_) {} return; }
      if (type === "subscribe" && msg.buildId) ws._buildId = String(msg.buildId);
    });
  }

  userSocket(ws, req) {
    const userId = new URL(req.url, "http://x").searchParams.get("userId") || "anon";
    this.join(userId, ws);
    this.common(ws, req, userId);
    ws.on("close", () => this.leave(userId, ws));
    ws.on("error", () => this.leave(userId, ws));
    try { ws.send(JSON.stringify({ type: "hello", server_time: db.utcNow().toISOString() })); } catch (_) {}
  }

  appSocket(ws, req) {
    this.common(ws, req, "app");
    try { ws.send(JSON.stringify({ type: "hello", server_time: db.utcNow().toISOString() })); } catch (_) {}
  }
}

const userHub = new UserHub();

// ------------------------------------------------------- signed app requests

function rawBody(req) {
  if (typeof req.rawBody === "string") return req.rawBody;
  try { return req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : ""; } catch (_) { return ""; }
}

async function verifyApp(req, res, next) {
  try {
    const appId = req.headers["x-app-id"];
    const ts = req.headers["x-timestamp"];
    const sig = req.headers["x-signature"];
    if (!appId || !ts || !sig) throw new u.HttpError(401, "X-App-Id, X-Timestamp, X-Signature required");

    const skew = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(skew) || skew > 300) throw new u.HttpError(401, "Timestamp out of ±300s window");

    const id = oid(appId);
    const app = id ? await db.apps.findOne({ _id: id }) : null;
    if (!app) throw new u.HttpError(401, "Unknown app");
    if (!app.secret) throw new u.HttpError(401, "App secret missing — rotate karo");

    const expected = crypto.createHmac("sha256", app.secret).update(rawBody(req) + ts).digest("hex");
    if (!safeEq(expected, String(sig).toLowerCase())) throw new u.HttpError(401, "Bad signature");

    req.app = app;
    next();
  } catch (e) { next(e); }
}

// ------------------------------------------------------------------- router

const router = express.Router();

// raw body capture
router.use((req, _res, next) => {
  if (req.rawBody === undefined) req.rawBody = rawBody(req);
  next();
});

// ---- config / health ----

router.get("/api/builder/config", ah(async (req, res) => {
  let counts = null;
  try { counts = await db.builderStats(); } catch (_) {}
  res.json({
    status: "ok",
    version: config.VERSION,
    worker_mode: builderConfig.WORKER_MODE,
    engine: builderConfig.ENGINE,
    variant: builderConfig.DEFAULT_VARIANT,
    template_ok: fs.existsSync(builderConfig.TEMPLATE_DIR),
    queue: getQueue().stats(),
    quota: await quota(),
    counts,
  });
}));

router.get("/api/builder/preflight", ah(async (req, res) => res.json(preflight())));

// ---- apps ----

router.get("/api/apps", ah(async (req, res) => {
  const userId = req.query.userId || null;
  const q = userId ? { userId } : {};
  const apps = await db.apps.find(q).sort({ _id: -1 }).limit(200).toArray();
  res.json({ apps: apps.map(shapeApp), quota: await quota() });
}));

router.post("/api/apps", ah(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if (!name) throw new u.HttpError(400, "name required");

  const secret = genSecret();
  const doc = {
    userId: b.userId || "anon",
    name,
    package: b.package || "",
    variant: b.variant || builderConfig.DEFAULT_VARIANT,
    config: b.config || {},
    secret,
    secret_last4: secret.slice(-4),
    secret_hash: sha256hex(secret),
    builds_total: 0,
    created_at: db.utcNow(),
  };
  const r = await db.apps.insertOne(doc);
  const app = { ...doc, _id: r.insertedId };
  u.logEvent("app_created", { appId: String(r.insertedId), name });
  res.json({ status: "ok", app: { ...shapeApp(app), secret } });
}));

router.post("/api/apps/:appId/secret/rotate", ah(async (req, res) => {
  const id = oid(req.params.appId);
  if (!id) throw new u.HttpError(400, "Bad appId");

  const secret = genSecret();
  const app = unwrap(await db.apps.findOneAndUpdate(
    { _id: id },
    { $set: { secret, secret_last4: secret.slice(-4), secret_hash: sha256hex(secret), secret_rotated_at: db.utcNow() } },
    { returnDocument: "after" },
  ));
  if (!app) throw new u.HttpError(404, "App not found");

  u.logEvent("app_secret_rotated", { appId: String(id) });
  res.json({ status: "ok", app: { ...shapeApp(app), secret } });
}));

router.delete("/api/apps/:appId", ah(async (req, res) => {
  const id = oid(req.params.appId);
  if (!id) throw new u.HttpError(400, "Bad appId");
  await db.apps.deleteOne({ _id: id });
  await db.builds.deleteMany({ appId: String(id) });
  u.logEvent("app_deleted", { appId: String(id) });
  res.json({ status: "ok" });
}));

// ---- builds ----

router.get("/api/builds", ah(async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 60, 10), 200));
  const q = {};
  if (req.query.userId) q.userId = req.query.userId;
  if (req.query.appId) q.appId = req.query.appId;
  const rows = await db.builds.find(q).sort({ _id: -1 }).limit(limit).toArray();
  res.json({ builds: rows.map(shapeBuild), queue: getQueue().stats() });
}));

router.post("/api/builds", ah(async (req, res) => {
  const b = req.body || {};
  const appId = b.appId ? String(b.appId) : null;

  let app = null;
  if (appId) {
    const id = oid(appId);
    app = id ? await db.apps.findOne({ _id: id }) : null;
    if (!app) throw new u.HttpError(404, "App not found");
  }

  const q = await quota();
  if (!q.unlimited && q.used_today >= q.daily_limit) {
    throw new u.HttpError(429, `Daily build limit (${q.daily_limit}) reach ho gaya`);
  }

  const id = await getQueue().add({
    userId: b.userId || (app && app.userId) || "anon",
    appId,
    appName: (app && app.name) || b.appName || "",
    variant: b.variant || (app && app.variant) || builderConfig.DEFAULT_VARIANT,
    config: { ...(app && app.config ? app.config : {}), ...(b.config || {}) },
    baseUrl: b.baseUrl || null,
  });

  if (builderConfig.WORKER_MODE === "inline") getQueue()._tick().catch(() => {});

  u.logEvent("build_queued", { buildId: String(id), appId });
  res.json({ status: "ok", build: { buildId: String(id), status: "queued" } });
}));

router.get("/api/builds/:id", ah(async (req, res) => {
  const id = oid(req.params.id);
  if (!id) throw new u.HttpError(400, "Bad buildId");
  const doc = await db.builds.findOne({ _id: id });
  if (!doc) throw new u.HttpError(404, "Build not found");
  res.json({ build: shapeBuild(doc) });
}));

router.get("/api/builds/:id/log", ah(async (req, res) => {
  const id = oid(req.params.id);
  if (!id) throw new u.HttpError(400, "Bad buildId");
  const doc = await db.builds.findOne({ _id: id }, { projection: { log_tail: 1, status: 1, error: 1 } });
  if (!doc) throw new u.HttpError(404, "Build not found");
  res.json({ status: doc.status, error: doc.error || null, log: (doc.log_tail || []).join("\n") });
}));

router.post("/api/builds/:id/cancel", ah(async (req, res) => {
  const id = oid(req.params.id);
  if (!id) throw new u.HttpError(400, "Bad buildId");
  const r = await db.builds.updateOne(
    { _id: id, status: { $in: ["queued", "running"] } },
    { $set: { status: "canceled", finished_at: db.utcNow() } },
  );
  if (!r.matchedCount) throw new u.HttpError(409, "Build already finished");
  res.json({ status: "ok" });
}));

router.post("/api/builds/:id/retry", ah(async (req, res) => {
  const id = oid(req.params.id);
  if (!id) throw new u.HttpError(400, "Bad buildId");
  const old = await db.builds.findOne({ _id: id });
  if (!old) throw new u.HttpError(404, "Build not found");

  const newId = await getQueue().add({
    userId: old.userId,
    appId: old.appId,
    appName: old.appName,
    variant: old.variant,
    config: old.config || {},
  });
  res.json({ status: "ok", build: { buildId: String(newId), status: "queued" } });
}));

router.get("/api/builds/:id/download", ah(async (req, res) => {
  const id = oid(req.params.id);
  if (!id) throw new u.HttpError(400, "Bad buildId");
  const doc = await db.builds.findOne({ _id: id });
  if (!doc) throw new u.HttpError(404, "Build not found");
  if (!doc.artifact || !fs.existsSync(doc.artifact)) throw new u.HttpError(404, "APK not ready");

  const fname = doc.apk_name || `${(doc.appName || "app").replace(/\s+/g, "-")}-${String(doc._id)}.apk`;
  res.setHeader("Cache-Control", "no-store");
  res.download(doc.artifact, fname);
}));

// ---- orders (signed) ----

router.post("/api/orders", verifyApp, ah(async (req, res) => {
  const doc = {
    appId: String(req.app._id), // body ka appId ignore — sirf header
    userId: req.app.userId || "anon",
    payload: req.body || {},
    created_at: db.utcNow(),
  };
  const r = await db.orders.insertOne(doc);
  res.json({ status: "ok", order: { id: String(r.insertedId), appId: doc.appId, created_at: doc.created_at } });
}));

router.get("/api/orders", verifyApp, ah(async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || 100, 10), 500));
  const rows = await db.orders.find({ appId: String(req.app._id) }).sort({ _id: -1 }).limit(limit).toArray();
  res.json({ orders: rows });
}));

router.post("/api/echo", verifyApp, ah(async (req, res) => {
  res.json({ status: "ok", appId: String(req.app._id), body: req.body || {} });
}));

// ------------------------------------------------------------------- export

module.exports = {
  config: builderConfig,
  ensureDirs,
  bindLoop,
  initQueue,
  getQueue,
  stats: () => getQueue().stats(),
  preflight,
  resolveGradle,
  whichSync,
  router,
  userHub,
  verifyApp,
  shapeApp,
  shapeBuild,
};