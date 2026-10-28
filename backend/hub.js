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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------- device hub

function sendJson(ws, payload) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error("socket not open"));
    ws.send(JSON.stringify(payload), (err) => (err ? reject(err) : resolve()));
  });
}

class Hub {
  constructor() {
    this.deviceSockets = new Map();
    this.lastPong = new Map();
    this._hbStarted = false;
  }

  async addDevice(deviceId, ws) {
    const id = String(deviceId);
    const old = this.deviceSockets.get(id);
    if (old && old !== ws) {
      try { old.close(4001, "replaced"); } catch (_) {}
    }
    this.deviceSockets.set(id, ws);
    this.lastPong.set(id, Date.now() / 1000);
    if (!this._hbStarted) {
      this._hbStarted = true;
      spawn(heartbeatLoop());
    }
  }

  async removeDevice(deviceId, ws) {
    const id = String(deviceId);
    if (this.deviceSockets.get(id) === ws) {
      this.deviceSockets.delete(id);
      this.lastPong.delete(id);
    }
  }

  touch(deviceId) {
    this.lastPong.set(String(deviceId), Date.now() / 1000);
  }

  online(deviceId) {
    return this.deviceSockets.has(String(deviceId));
  }

  get onlineCount() {
    return this.deviceSockets.size;
  }

  async sendToDevice(deviceId, payload) {
    const id = String(deviceId);
    const ws = this.deviceSockets.get(id);
    if (!ws) return false;
    try {
      await sendJson(ws, payload);
      this.touch(id);
      return true;
    } catch (_) {
      await this.removeDevice(id, ws);
      return false;
    }
  }
}

const hub = new Hub();

async function heartbeatLoop() {
  for (;;) {
    await sleep(Math.max(5, config.WS_PING_INTERVAL) * 1000);
    const now = Date.now() / 1000;
    const payload = JSON.stringify({ type: "ping", ts: Math.floor(now) });

    for (const [id, ws] of [...hub.deviceSockets]) {
      const last = hub.lastPong.get(id) || 0;
      if (now - last > config.WS_IDLE_TIMEOUT) {
        try { ws.close(4000, "idle"); } catch (_) {}
        await hub.removeDevice(id, ws);
        continue;
      }
      try {
        if (ws.readyState === 1) ws.send(payload);
      } catch (_) {
        await hub.removeDevice(id, ws);
      }
    }
  }
}

// --------------------------------------------------------------- admin hub

class AdminHub {
  constructor() {
    this.sockets = new Set();
  }

  add(ws) { this.sockets.add(ws); }
  remove(ws) { this.sockets.delete(ws); }

  async broadcast(payload) {
    const data = JSON.stringify(payload);
    const tasks = [];
    for (const ws of [...this.sockets]) {
      if (!ws || ws.readyState !== 1) { this.remove(ws); continue; }
      tasks.push(
        new Promise((resolve) => {
          try {
            ws.send(data, (err) => {
              if (err) this.remove(ws);
              resolve();
            });
          } catch (_) {
            this.remove(ws);
            resolve();
          }
        })
      );
    }
    if (tasks.length) await Promise.allSettled(tasks);
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
  broadcast({ type: "device_status", data: { id: String(deviceId), ...(extra || {}) } });
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
    row = await db.outbox.findOne({ _id: new ObjectId(String(outboxId)) });
  } catch (_) {
    return false;
  }
  if (!row) return false;
  if (row.status === "sent") return true;

  const ok = await hub.sendToDevice(deviceId, pushRow(deviceId, row));
  if (ok) {
    try {
      await db.outbox.updateOne(
        { _id: row._id, status: { $ne: "sent" } },
        { $set: { pushed_at: db.utcNow(), updated_at: db.utcNow() }, $inc: { attempts: 1 } }
      );
    } catch (_) {}
  }
  return ok;
}

async function pushOutbox(deviceId) {
  let pending;
  try {
    pending = await db.outbox
      .find({ device_id: String(deviceId), status: { $in: ["pending", "queued"] } })
      .sort({ _id: 1 })
      .limit(20)
      .toArray();
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
    stale = await db.outbox
      .find({
        device_id: String(deviceId),
        status: { $ne: "sent" },
        $or: [
          { status: "pending", pushed_at: { $lt: cutoff } },
          { status: "queued", updated_at: { $lt: stuck } },
        ],
      })
      .limit(10)
      .toArray();
  } catch (_) {
    return;
  }
  for (const row of stale) await deliverOutboxRow(deviceId, String(row._id));
}

async function queueSms(deviceId, body, to, source = "panel", deviceName = "", simSlot = null) {
  if (!deviceId) throw new u.HttpError(400, "deviceId required");
  const now = db.utcNow();
  const dest = u.normalizeNumber(to) || String(to || "").trim();
  const slot =
    simSlot === null || simSlot === undefined || simSlot === ""
      ? null
      : parseInt(simSlot, 10);

  const msgId = await u.insertMessage(
    {
      device_id: String(deviceId),
      device_name: deviceName || "Unknown",
      direction: "out",
      address: dest || "",
      body,
      kind: "sms",
      status: "queued",
      source,
      sim_slot: Number.isFinite(slot) ? slot : null,
      created_at: now,
    },
    false
  );

  const res = await db.outbox.insertOne({
    device_id: String(deviceId),
    to: dest || "",
    body,
    source,
    status: "pending",
    sim_slot: Number.isFinite(slot) ? slot : null,
    message_id: msgId || null,
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
  if (sel.length) return sel;
  const a = u.autoSenderOf(device || {});
  if (a.sim_slots.length) return a.sim_slots;
  return [null];
}

function onlineDeviceIds() {
  const out = [];
  for (const k of hub.deviceSockets.keys()) {
    try {
      out.push(new ObjectId(k));
    } catch (_) {}
  }
  return out;
}

async function resolveTargets(payload = {}) {
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
  const rows = await db.devices.find().limit(config.MAX_BROADCAST).toArray();
  return [rows, total > config.MAX_BROADCAST];
}

// ----------------------------------------------------------------- cleanup

async function closeSockets() {
  for (const ws of hub.deviceSockets.values()) {
    try { ws.close(1001, "shutdown"); } catch (_) {}
  }
  for (const ws of adminHub.sockets) {
    try { ws.close(1001, "shutdown"); } catch (_) {}
  }
  hub.deviceSockets.clear();
  hub.lastPong.clear();
  adminHub.sockets.clear();
}

async function pruneCollection(name, limit, sort = { _id: 1 }) {
  if (!limit || limit <= 0) return;
  const col = db[name];
  if (!col) return;
  const n = await col.countDocuments({});
  if (n <= limit) return;
  const extra = n - limit;
  const victims = await col
    .find({}, { projection: { _id: 1 } })
    .sort(sort)
    .limit(extra)
    .toArray();
  if (victims.length) await col.deleteMany({ _id: { $in: victims.map((r) => r._id) } });
}

async function pruneEventsLoop() {
  for (;;) {
    await sleep(3600 * 1000);
    for (const [name, limit] of [
      ["device_events", config.EVENT_PRUNE_LIMIT],
      ["tg_logs", config.TG_LOG_LIMIT],
      ["activity_logs", config.ACTIVITY_LOG_LIMIT],
    ]) {
      try {
        await pruneCollection(name, limit);
      } catch (_) {}
    }
  }
}

module.exports = {
  hub,
  adminHub,
  spawn,
  sendJson,
  heartbeatLoop,
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