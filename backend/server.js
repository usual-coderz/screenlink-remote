"use strict";

const http = require("http");
const cluster = require("cluster");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cookieSession = require("cookie-session");
const { WebSocketServer } = require("ws");
const { execSync } = require("child_process");

const config = require("./config");

// ---------------------------------------------------------- argv / flags

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--port", "--host", "--workers"]);

function argValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}
const hasFlag = (n) => argv.includes(n);

/** Procfile `$PORT` positional aata hai — flags ke values ko chhod ke pehla numeric token. */
function positionalPort() {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith("--")) continue;
    if (/^\d+$/.test(a)) return parseInt(a, 10);
  }
  return undefined;
}

const WORKER_ONLY = hasFlag("--worker");
const NO_LISTEN = hasFlag("--no-listen");
const PROXY_HEADERS = hasFlag("--proxy-headers") || process.env.TRUST_PROXY === "1";

const WORKERS = Math.max(
  1,
  parseInt(argValue("--workers") || process.env.WEB_CONCURRENCY || "1", 10) || 1
);
const PORT = parseInt(
  String(argValue("--port") || positionalPort() || process.env.PORT || "8000"),
  10
);
const HOST = String(argValue("--host") || process.env.HOST || "0.0.0.0");
const SPREAD = ["1", "true", "yes"].includes(
  String(process.env.CLUSTER_PORT_SPREAD || "").toLowerCase()
);

const isPrimary =
  cluster.isPrimary === undefined ? cluster.isMaster : cluster.isPrimary;
const IS_CHILD = !!process.env.TPC_CHILD;
const QUEUE_OWNER = !cluster.worker || cluster.worker.id === 1;

if (!Number.isFinite(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`[startup] bad PORT: ${PORT}`);
  process.exit(1);
}

// queue ownership + worker mode — builder require se PEHLE decide
if (WORKER_ONLY) {
  process.env.BUILDER_WORKER_MODE = process.env.BUILDER_WORKER_MODE || "inline";
} else if (WORKERS > 1) {
  process.env.BUILDER_WORKER_MODE = process.env.BUILDER_WORKER_MODE || "api";
} else {
  process.env.BUILDER_WORKER_MODE = process.env.BUILDER_WORKER_MODE || "inline";
}
if (!QUEUE_OWNER) process.env.BUILDER_WORKER_MODE = "api";

// queue sirf owner chalaye; secondary workers warmup bhi na karein
if (process.env.BUILDER_START_QUEUE === undefined) {
  process.env.BUILDER_START_QUEUE = QUEUE_OWNER ? "1" : "0";
}
if (!QUEUE_OWNER && process.env.BUILDER_SKIP_WARMUP === undefined) {
  process.env.BUILDER_SKIP_WARMUP = "1";
}

// ---------------------------------------------------------------- modules

const db = require("./database");
const u = require("./utils");
const hub = require("./hub");
const relay = require("./relay");
const builder = require("./builder");

const devicesRoutes = require("./routes/devices");
const adminRoutes = require("./admin/admin");
const wsRoutes = require("./routes/ws");

// ----------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Kabhi hang nahi hota: error aur timeout dono null pe resolve. */
function withTimeout(label, ms, fn) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => {
      if (!done) { done = true; console.error(`[startup] ${label} timeout ${ms}ms — skip`); resolve(null); }
    }, ms);
    Promise.resolve().then(fn)
      .then((v) => finish(v))
      .catch((err) => { console.error(`[startup] ${label} fail:`, err.message || err); finish(null); });
  });
}

/** Infinite loop ko await mat karo — spawn karke chhod do. */
const spawnLoop = (label, fn) => {
  Promise.resolve()
    .then(fn)
    .catch((e) => console.error(`[loop] ${label} crash:`, (e && e.message) || e));
};

const which = (bin) => {
  if (!bin) return null;
  try {
    return execSync(`command -v ${bin}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim() || null;
  } catch (_) {
    return null;
  }
};

// ------------------------------------------------------------ middleware

/** builder.verifyApp ko byte-exact body chahiye — yahin capture karo. */
function rawBodyCapture(req, _res, buf) {
  if (buf && buf.length) req.rawBody = buf.toString("utf8");
}

/** DB ready na ho to bhi ye paths chalne chahiye (login, register, health). */
const DB_EXEMPT = [
  "/health",
  "/version",
  "/favicon.ico",
  "/devices/config",
  "/devices/register",
  "/pair",
  "/panel/login",
  "/panel/access",
  "/panel/me",
  "/admin/auth/status",
  "/api/builder/config",
  "/api/builder/preflight",
  "/api/builder/themes",
];

const isExempt = (p) => DB_EXEMPT.some((x) => p === x || p.startsWith(`${x}/`) || p.startsWith(x));

function dbGuard(req, res, next) {
  if (isExempt(req.path)) return next();
  if (db.isReady()) return next();
  res.setHeader("Retry-After", "3");
  res.status(503).json({ detail: "Database not ready", db: db.status() });
}

const _hits = new Map();

function rateLimit({ windowMs = 60000, max = 120, name = "rl" } = {}) {
  return (req, res, next) => {
    const key = `${name}:${req.ip || "?"}`;
    const now = Date.now();
    const rec = _hits.get(key);

    if (!rec || now > rec.reset) {
      _hits.set(key, { n: 1, reset: now + windowMs });
    } else {
      rec.n += 1;
      if (rec.n > max) {
        res.setHeader("Retry-After", String(Math.ceil((rec.reset - now) / 1000)));
        return res.status(429).json({ detail: "Too many requests" });
      }
    }

    if (_hits.size > 5000) {
      for (const [k, v] of _hits) if (now > v.reset) _hits.delete(k);
    }
    next();
  };
}

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  next();
}

// ------------------------------------------------------------------- app

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.set("trust proxy", PROXY_HEADERS ? 1 : false);

  app.use(securityHeaders);

  // raw body capture — builder HMAC ke liye zaroori
  app.use(express.json({ limit: "8mb", verify: rawBodyCapture }));
  app.use(express.urlencoded({ extended: true, limit: "8mb" }));

  app.use(
    cookieSession({
      name: config.COOKIE_NAME,
      keys: [config.SESSION_SECRET],
      maxAge: config.SESSION_MAX_AGE * 1000,
      sameSite: "lax",
      secure: config.FORCE_SECURE,
      httpOnly: true,
      domain: config.COOKIE_DOMAIN || undefined,
      overwrite: true,
    })
  );

  // ---------------- health (DB se pehle) ----------------
  app.get("/health/live", (req, res) => res.json({ status: "ok", pid: process.pid }));

  app.get("/health/ready", (req, res) =>
    res.status(db.isReady() ? 200 : 503).json({
      status: db.isReady() ? "ok" : "degraded",
      db: db.status(),
    })
  );

  app.get("/health", (req, res) =>
    res.status(db.isReady() ? 200 : 503).json({
      status: db.isReady() ? "ok" : "degraded",
      version: config.VERSION,
      db: db.status(),
      devices_online: hub.hub ? hub.hub.onlineCount : 0,
      relay_authorized: !!relay.relayState.authorized,
      build_queue: builder.getQueue().stats(),
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
    })
  );

  app.get("/health/database", async (req, res) => {
    const r = await db.checkDatabase();
    res.status(r.status === "ok" ? 200 : 503).json(r);
  });

  app.get("/health/builder", async (req, res) => {
    const tools = {
      gradle: which(builder.config.GRADLE_BIN),
      keytool: which(builder.config.KEYTOOL_BIN),
      apksigner: which(builder.config.APKSIGNER_BIN),
      zipalign: which(builder.config.ZIPALIGN_BIN),
      docker: which(builder.config.DOCKER_BIN),
    };
    const gradleOk = !!tools.gradle || builder.config.USE_DOCKER;
    const templateOk = fs.existsSync(builder.config.TEMPLATE_DIR);
    res.json({
      status: gradleOk && templateOk ? "ok" : "degraded",
      version: config.VERSION,
      variant: builder.config.DEFAULT_VARIANT,
      worker_mode: builder.config.WORKER_MODE,
      template_dir: builder.config.TEMPLATE_DIR,
      template_ok: templateOk,
      tools: Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, !!v])),
      tool_paths: Object.fromEntries(Object.entries(tools).filter(([, v]) => v)),
      queue: builder.getQueue().stats(),
      counts: await db.builderStats(),
    });
  });

  // ---------------- public ----------------
  app.get("/", (req, res) =>
    res.json({
      app: "TPC PANEL",
      status: db.isReady() ? "online" : "degraded",
      version: config.VERSION,
      owner: "https://t.me/icivan",
      relay: relay.TELETHON_OK ? "mtproto" : "unavailable",
      builder: builder.config.WORKER_MODE,
      admin: "/admin",
      pid: process.pid,
    })
  );

  app.get("/favicon.ico", (req, res) => res.status(204).end());
  app.get("/version", (req, res) => res.json({ version: config.VERSION }));

  // ---------------- admin dashboard ----------------
  const serveAdmin = (req, res, next) => {
    if (!fs.existsSync(config.ADMIN_FILE)) {
      return next(new u.HttpError(404, "Admin dashboard file not found"));
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(config.ADMIN_FILE);
  };
  app.get(["/admin", "/admin/", "/panel"], serveAdmin);

  // ---------------- routes ----------------
  app.use(rateLimit({ name: "auth", windowMs: 60000, max: 60 }), (req, res, next) => {
    const p = req.path;
    if (
      p === "/panel/login" ||
      p === "/panel/access" ||
      p === "/pair" ||
      p === "/devices/register"
    ) {
      return next();
    }
    next();
  });

  app.use("/api", dbGuard);

  app.use(builder.router);

  // relay admin mount pehle, warna root mount shadow kar dega
  app.use("/admin/relay", relay.router);
  app.use(relay.router);

  // device + admin routes: DB ready hona chahiye (exempt list chhod ke)
  const guarded = (mw) => (req, res, next) => {
    if (db.isReady() || isExempt(req.path)) return mw(req, res, next);
    res.setHeader("Retry-After", "3");
    return res.status(503).json({ detail: "Database not ready", db: db.status() });
  };

  app.use(guarded(devicesRoutes));
  app.use(guarded(adminRoutes));

  // ---------------- errors ----------------
  app.use((req, res) => res.status(404).json({ detail: "Not found" }));

  app.use((err, req, res, _next) => {
    const status = err instanceof u.HttpError ? err.status : err.status || 500;
    if (status >= 500) console.error("[error]", err.stack || err);
    res.status(status).json({ detail: err.message || "Server error" });
  });

  return app;
}

// -------------------------------------------------------------------- ws

function attachWs(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch (_) {
      socket.destroy();
      return;
    }

    let handler = null;
    try {
      if (pathname === "/ws/admin") {
        handler = wsRoutes.adminSocket;
      } else if (pathname.startsWith("/ws/device/")) {
        const rid = decodeURIComponent(pathname.slice("/ws/device/".length));
        handler = (ws, r) => wsRoutes.deviceSocket(ws, r, rid);
      } else if (pathname === "/ws/user") {
        handler = (ws, r) => builder.userHub.userSocket(ws, r);
      } else if (pathname === "/ws/app") {
        handler = (ws, r) => builder.userHub.appSocket(ws, r);
      }
    } catch (err) {
      console.error("[ws] route resolve fail:", err.message);
    }

    if (!handler) {
      try {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      } catch (_) {}
      socket.destroy();
      return;
    }

    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
        ws.on("error", (e) => console.error("[ws] socket error:", e.message));
        Promise.resolve(handler(ws, req)).catch((err) => {
          console.error("[ws] handler fail:", err.message || err);
          try { ws.close(1011, "handler error"); } catch (_) {}
        });
      });
    } catch (err) {
      console.error("[ws] upgrade fail:", err.message);
      try { socket.destroy(); } catch (_) {}
    }
  });

  // dangling socket cleanup
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (_) {}
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, 30000);
  if (sweep.unref) sweep.unref();

  wss.on("connection", (ws) => ws.on("pong", () => { ws.isAlive = true; }));

  return wss;
}

// ----------------------------------------------------------------- listen

/** Port bind — EADDRINUSE pe short retry, warna saaf error. */
async function listenWithRetry(server, port, host, attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      return server.address();
    } catch (err) {
      if (err.code === "EADDRINUSE" && i < attempts) {
        console.error(`[startup] ${port} busy (try ${i}/${attempts}) — 400ms baad retry`);
        await sleep(400);
        continue;
      }
      if (err.code === "EACCES") {
        throw new Error(`port ${port} pe permission nahi (1024 se neeche root chahiye)`);
      }
      throw err;
    }
  }
}

function armListenWatchdog(server, port) {
  const t = setTimeout(() => {
    if (server.listening) return;
    console.error(
      `[startup] 10s baad bhi ${port} pe listen nahi — ` +
      `argv=${JSON.stringify(argv)} workers=${WORKERS} mode=${builder.config.WORKER_MODE}`
    );
  }, 10000);
  if (t.unref) t.unref();
}

// ------------------------------------------------------------- background

/**
 * Listener ke BAAD chalta hai. Sirf queue owner heavy init karta hai —
 * secondary workers sirf apna DB pool banate hain, warna relay/gramJS
 * do baar connect hota hai aur SDK warmup race karta hai.
 */
async function runStartupTasks() {
  if (!db.isReady()) await withTimeout("mongo", 20000, () => db.initDbWithRetry());

  const wid = cluster.worker ? cluster.worker.id : 0;
  if (!QUEUE_OWNER) {
    console.log(`[startup] worker ${wid} secondary — db only, heavy init skip`);
    return;
  }
  console.log(`[startup] worker ${wid} queue owner — full init`);

  await withTimeout("dbWatchdog", 5000, () => db.startWatchdog());

  await withTimeout("backfillShortIds", 15000, () => u.backfillShortIds());
  await withTimeout("backfillAutoSender", 15000, () => u.backfillAutoSender());
  await withTimeout("loadBans", 10000, () => relay.loadBans());
  await withTimeout("loadRelayConfig", 10000, () => relay.loadRelayConfig());
  await withTimeout("startRelay", 30000, () => relay.startRelay());

  // infinite loops — await mat karo
  spawnLoop("pruneEvents", () => hub.spawn(hub.pruneEventsLoop()));
  spawnLoop("heartbeat", () => hub.spawn(hub.heartbeatLoop()));

  await withTimeout("builderInit", 20000, async () => {
    builder.ensureDirs();
    builder.bindLoop(); // queue start + warmup khud handle karta hai
  });

  console.log(
    `[startup] background init done — db=${db.isReady() ? "ready" : "down"} ` +
    `mode=${builder.config.WORKER_MODE}`
  );
}

// ----------------------------------------------------------------- start

async function start() {
  const listenPort = SPREAD && cluster.worker ? PORT + (cluster.worker.id - 1) : PORT;

  const server = http.createServer(createApp());
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 0;

  const wss = attachWs(server);

  if (NO_LISTEN) {
    console.log(
      `TPC PANEL v${config.VERSION} worker up — pid=${process.pid} (no listen) ` +
      `mode=${builder.config.WORKER_MODE}`
    );
    await runStartupTasks();
  } else {
    armListenWatchdog(server, listenPort);
    try {
      await listenWithRetry(server, listenPort, HOST);
    } catch (err) {
      console.error(`[startup] LISTEN FAIL ${HOST}:${listenPort} — ${err.message}`);
      process.exit(1);
    }

    console.log(
      `TPC PANEL v${config.VERSION} up — pid=${process.pid} ${HOST}:${listenPort} ` +
      `mode=${builder.config.WORKER_MODE} workers=${WORKERS} ` +
      `admins=${Object.keys(config.ADMINS).length} secret=${config.SESSION_SECRET_SRC}`
    );

    // pehla page load healthy DB pe jaye — max 15s wait, phir bhi bind rehta hai
    if (!db.isReady()) {
      await withTimeout("mongo-prime", 15000, () => db.initDbWithRetry());
    }
    if (db.isReady()) console.log("[startup] db primed — dashboard data available");

    // fire-and-forget: listener ab kabhi block nahi hoga
    runStartupTasks().catch((e) => console.error("[startup] chain fail:", e.message));
  }

  let done = false;
  const shutdown = async (sig) => {
    if (done) return;
    done = true;
    console.log(`[shutdown] ${sig}`);
    try { await builder.getQueue().stop(); } catch (_) {}
    try { await relay.stopRelay(); } catch (_) {}
    try { await hub.closeSockets(); } catch (_) {}
    try { for (const ws of wss.clients) ws.terminate(); } catch (_) {}
    try { await db.closeDb(); } catch (_) {}
    try { server.closeAllConnections?.(); } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}

// --------------------------------------------------------------- cluster

function startClusterPrimary() {
  console.log(`[cluster] primary pid=${process.pid} — ${WORKERS} workers fork`);
  if (!SPREAD) {
    console.warn(
      "[cluster] CLUSTER_PORT_SPREAD off — saare workers ek hi port share karenge " +
      "(WS stickiness weak). Single process chahiye toh --workers 1."
    );
  }

  const fork = () => cluster.fork({ TPC_CHILD: "1" });
  for (let i = 0; i < WORKERS; i++) fork();

  let shuttingDown = false;
  cluster.on("exit", (worker, code, signal) => {
    if (shuttingDown) return;
    console.error(`[cluster] worker ${worker.process.pid} exit (${signal || code}) — restart`);
    setTimeout(fork, 1000);
  });

  const stop = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[cluster] ${sig} — children ko SIGTERM`);
    for (const id of Object.keys(cluster.workers || {})) {
      try { cluster.workers[id].process.kill("SIGTERM"); } catch (_) {}
    }
    setTimeout(() => process.exit(0), 6000);
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGHUP", () => {
    console.log("[cluster] SIGHUP — rolling restart");
    for (const id of Object.keys(cluster.workers || {})) {
      try { cluster.workers[id].process.kill("SIGTERM"); } catch (_) {}
    }
  });
}

process.on("unhandledRejection", (e) =>
  console.error("[unhandledRejection]", (e && e.stack) || e)
);
process.on("uncaughtException", (e) =>
  console.error("[uncaughtException]", (e && e.stack) || e)
);

module.exports = { start, createApp, attachWs };

if (require.main === module) {
  if (!WORKER_ONLY && WORKERS > 1 && isPrimary && !IS_CHILD) {
    startClusterPrimary();
  } else {
    start().catch((e) => {
      console.error("[startup] failed", e);
      process.exit(1);
    });
  }
}