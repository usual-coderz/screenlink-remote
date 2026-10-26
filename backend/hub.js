"use strict";

const { ObjectId } = require("mongodb");
const config = require("./config");
const db = require("./database");
const u = require("./utils");

// ------------------------------------------------------------------ spawn

function spawn(p) {
  if (p && typeof p.catch === "function") p.catch(() => {});
  return p;
}

// -------------------------------------------------------------- device hub

function sendJson(ws, payload) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(payload), (err) => (err ? reject(err) : resolve()));
  });
}

class Hub {
  constructor() {
    this.deviceSockets = new Map();
    this.lastPong = new Map();
  }

  async addDevice(deviceId, ws) {
    this.deviceSockets.set(deviceId, ws);
    this.lastPong.set(deviceId, Date.now() / 1000);
  }

  async removeDevice(deviceId, ws) {
    if (this.deviceSockets.get(deviceId) === ws) {
      this.deviceSockets.delete(deviceId);
      this.lastPong.delete(deviceId);
    }
  }

  online(deviceId) {
    return this.deviceSockets.has(deviceId);
  }

  get onlineCount() {
    return this.deviceSockets.size;
  }

  async sendToDevice(deviceId, payload) {
    const ws = this.deviceSockets.get(deviceId);
    if (!ws) return false;
    try {
      await sendJson(ws, payload);
      return true;
    } catch (_) {
      await this.removeDevice(deviceId, ws);
      return false;
    }
  }
}

const hub = new Hub();

// --------------------------------------------------------------- admin hub

class AdminHub {
  constructor() {
    this.sockets = new Set();
  }

  add(ws) { this.sockets.add(ws); }
  remove(ws) { this.sockets.delete(ws); }

  async broadcast(payload) {
    const targets = [...this.sockets];
    const dead = [];
    for (const ws of targets) {
      try { await sendJson(ws, payload); }
      catch (_) { dead.push(ws); }
    }
    for (const ws of dead) this.remove(ws);
  }
}

const adminHub = new AdminHub();

// ------------------------------------------------------------- broadcasts

function broadcast(payload) {
  spawn(adminHub.broadcast(payload));
}

function broadcastMessage(doc) {
  if (!doc) return;
  try { broadcast({ type: "message", data: u.serializeDocument(doc) }); } catch (_) {}
}

function broadcastDevice(deviceId, extra = null) {
  broadcast({ type: "device_status", data: { id: deviceId, ...(extra || {}) } });
}

function broadcastBuild(userId, payload) {
  try { broadcast({ type: "build", data: { ...payload, userId } }); } catch (_) {}
}

// ---------------------------------------------------------------- commands

async function sendCommand(deviceId, action, extra = null) {
  const payload = { type: "command", action, ts: Math.floor(Date.now() / 1000) };
  if (extra) Object.assign(payload, extra);
  return hub.sendToDevice(deviceId, payload);
}

// ------------------------------------------------------------------ outbox

function pushRow(deviceId, row) {
  const payload = {
    type: "sms_send",
    id: String(row._id),
    to: row.to || "",
    body: row.body || "",
  };
  const slot = row.sim_slot;
  if (slot !== null && slot !== undefined) {
    const n = parseInt(slot, 10);
    if (Number.isFinite(n)) payload.sim_slot = n;
  }
  return payload;
}

async function deliverOutboxRow(deviceId, outboxId) {
  let row;
  try {
    row = await db.outbox.findOne({ _id: new ObjectId(outboxId) });
  } catch (_) {
    return false;
  }
  if (!row) return false;

  const ok = await hub.sendToDevice(deviceId, pushRow(deviceId, row));
  if (ok) {
    try {
      await db.outbox.updateOne(
        { _id: row._id },
        { $set: { pushed_at: db.utcNow(), status: "pending" }, $inc: { attempts: 1 } },
      );
    } catch (_) {}
  }
  return ok;
}

async function pushOutbox(deviceId) {
  let pending;
  try {
    pending = await db.outbox.find({ device_id: deviceId, status: "pending" }).limit(20).toArray();
  } catch (_) {
    return 0;
  }
  let n = 0;
  for (const row of pending) {
    if (await deliverOutboxRow(deviceId, String(row._id))) n += 1;
  }
  return n;
}

async function repushStale(deviceId) {
  const cutoff = new Date(Date.now() - config.OUTBOX_REPUSH_AFTER * 1000);
  const stuck = new Date(Date.now() - config.SEND_STUCK_AFTER * 1000);
  let stale;
  try {
    stale = await db.outbox.find({
      device_id: deviceId,
      $or: [
        { status: "pending", pushed_at: { $lt: cutoff } },
        { status: "queued", updated_at: { $lt: stuck } },
      ],
    }).limit(10).toArray();
  } catch (_) {
    return;
  }
  for (const row of stale) await deliverOutboxRow(deviceId, String(row._id));
}

async function queueSms(deviceId, body, to, source = "panel", deviceName = "", simSlot = null) {
  const now = db.utcNow();
  to = u.normalizeNumber(to) || String(to || "").trim();

  const msgId = await u.insertMessage({
    device_id: deviceId,
    device_name: deviceName || "Unknown",
    direction: "out",
    address: to || "",
    body,
    kind: "sms",
    status: "queued",
    source,
    sim_slot: simSlot,
    created_at: now,
  }, false);

  const res = await db.outbox.insertOne({
    device_id: deviceId,
    to: to || "",
    body,
    source,
    status: "pending",
    sim_slot: simSlot,
    message_id: msgId,
    attempts: 0,
    pushed_at: null,
    created_at: now,
    updated_at: now,
  });

  if (msgId) {
    try { broadcastMessage(await db.messages.findOne({ _id: msgId })); } catch (_) {}
  }

  return [String(res.insertedId), msgId ? String(msgId) : ""];
}

// ----------------------------------------------------------------- targets

function slotsFor(payloadSlots, device) {
  const sel = u.normSlots(payloadSlots);
  if (!sel.length) return [null];
  return [...sel];
}

function onlineDeviceIds() {
  const out = [];
  for (const k of hub.deviceSockets.keys()) {
    try { out.push(new ObjectId(k)); } catch (_) {}
  }
  return out;
}

async function resolveTargets(payload) {
  if (payload.target === "device") {
    if (!payload.device_id) throw new u.HttpError(400, "device_id required for target=device");
    return [[await u.getDeviceOr404(payload.device_id)], false];
  }

  if (payload.target === "online") {
    const ids = onlineDeviceIds();
    if (!ids.length) return [[], false];
    return [await db.devices.find({ _id: { $in: ids } }).toArray(), false];
  }

  let total = 0;
  try { total = await db.devices.countDocuments({}); } catch (_) {}
  return [await db.devices.find().limit(config.MAX_BROADCAST).toArray(), total > config.MAX_BROADCAST];
}

// ----------------------------------------------------------------- cleanup

async function closeSockets() {
  for (const ws of hub.deviceSockets.values()) {
    try { ws.close(1001); } catch (_) {}
  }
  for (const ws of adminHub.sockets) {
    try { ws.close(1001); } catch (_) {}
  }
}

async function pruneEventsLoop() {
  for (;;) {
    try {
      const n = await db.device_events.countDocuments({});
      if (n > config.EVENT_PRUNE_LIMIT) {
        const extra = n - config.EVENT_PRUNE_LIMIT;
        const victims = await db.device_events.find({}, { projection: { _id: 1 } })
          .sort({ _id: 1 }).limit(extra).toArray();
        const ids = victims.map((r) => r._id);
        if (ids.length) await db.device_events.deleteMany({ _id: { $in: ids } });
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 3600 * 1000));
  }
}

module.exports = {
  hub,
  adminHub,
  spawn,
  sendJson,
  broadcast,
  broadcastMessage,
  broadcastDevice,
  broadcastBuild,
  sendCommand,
  pushRow,
  deliverOutboxRow,
  pushOutbox,
  repushStale,
  queueSms,
  slotsFor,
  onlineDeviceIds,
  resolveTargets,
  closeSockets,
  pruneEventsLoop,
};