"""
TPC PANEL — backend

FastAPI service that:
  * registers Android devices and stores their telemetry in MongoDB
  * serves the admin console
  * relays a live screen stream + control events between device and operator
    over two websocket channels
"""

import os
import json
import time
import secrets
import hashlib
import asyncio
from pathlib import Path
from typing import Dict, Set
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import (
    FastAPI,
    HTTPException,
    Header,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from pydantic import BaseModel, Field
from pymongo.errors import PyMongoError, DuplicateKeyError
from bson import ObjectId
from pwdlib import PasswordHash

from backend.database import (
    init_db,
    check_database,
    admins,
    devices,
    pairing_codes,
    support_sessions,
    activity_logs,
    utc_now,
)

# ---------------------------------------------------------------- config

BASE_DIR = Path(__file__).resolve().parent.parent
ADMIN_FILE = BASE_DIR / "admin" / "index.html"

SESSION_TTL = 300
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY")
SESSION_SECRET = os.getenv("SESSION_SECRET")
COOKIE_NAME = "tpc_admin_session"

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "ivan")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "Ahad@198612")

password_hasher = PasswordHash.recommended()

ONLINE_WINDOW_SECONDS = 90
MAX_TELEMETRY_KEYS = 60
MAX_TELEMETRY_STRING = 300
MAX_WS_TEXT_BYTES = 4_000_000

# --------------------------------------------------------------- lifespan


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="TPC PANEL", version="3.0.0", lifespan=lifespan)

app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET or secrets.token_urlsafe(32),
    session_cookie=COOKIE_NAME,
    max_age=60 * 60 * 8,
    same_site="lax",
    https_only=True,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Admin-Key"],
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


class AdminLoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


# -------------------------------------------------------------- utilities


def hash_value(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


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
    """Clamp arbitrary client telemetry into Mongo-safe shapes."""
    if not isinstance(raw, dict):
        return {}

    clean: dict = {}

    for key, value in list(raw.items())[:MAX_TELEMETRY_KEYS]:
        if not isinstance(key, str) or not key:
            continue

        key = key[:60]

        if value is None or isinstance(value, bool) or isinstance(value, (int, float)):
            clean[key] = value
            continue

        if isinstance(value, str):
            clean[key] = value[:MAX_TELEMETRY_STRING]
            continue

        if isinstance(value, list):
            items = []
            for item in value[:20]:
                if item is None or isinstance(item, (bool, int, float)):
                    items.append(item)
                elif isinstance(item, str):
                    items.append(item[:MAX_TELEMETRY_STRING])
                elif isinstance(item, dict):
                    items.append({
                        str(k)[:40]: (
                            v[:MAX_TELEMETRY_STRING] if isinstance(v, str) else v
                        )
                        for k, v in list(item.items())[:20]
                        if v is None or isinstance(v, (bool, int, float, str))
                    })
            clean[key] = items
            continue

        if isinstance(value, dict):
            clean[key] = {
                str(k)[:40]: (v[:MAX_TELEMETRY_STRING] if isinstance(v, str) else v)
                for k, v in list(value.items())[:20]
                if v is None or isinstance(v, (bool, int, float, str))
            }

    return clean


def telemetry_summary(telemetry: dict) -> dict:
    """Mirror useful telemetry fields to top level for fast list rendering."""
    sims = telemetry.get("sims")
    first_sim = sims[0] if isinstance(sims, list) and sims else {}

    return {
        "device_model": telemetry.get("model") or telemetry.get("device_name") or "",
        "android_version": telemetry.get("android_version") or "",
        "sim_carrier": (
            telemetry.get("sim_carrier")
            or telemetry.get("sim_operator")
            or first_sim.get("carrier")
            or ""
        ),
        "sim_number": telemetry.get("sim_number") or first_sim.get("number") or "",
        "sim_number_source": telemetry.get("sim_number_source") or "",
        "sim_count": len(sims) if isinstance(sims, list) else 0,
        "battery_level": telemetry.get("battery_level"),
        "battery_charging": telemetry.get("battery_charging"),
        "network_type": telemetry.get("network_type") or "",
        "local_ip": telemetry.get("local_ip") or "",
        "telemetry_updated_at": utc_now(),
    }


def require_api_key(api_key: str | None):
    if not ADMIN_API_KEY:
        raise HTTPException(status_code=503, detail="Admin API key is not configured")
    if not api_key or not secrets.compare_digest(api_key, ADMIN_API_KEY):
        raise HTTPException(status_code=401, detail="Unauthorized")


def require_admin_session(request: Request):
    admin_id = request.session.get("admin_id")
    if not admin_id:
        raise HTTPException(status_code=401, detail="Please log in")
    return admin_id


def serialize_datetime(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    if value is None:
        return None
    return str(value)


def serialize_document(document: dict) -> dict:
    result: dict = {}

    for key, value in document.items():
        if key == "_id":
            result["id"] = str(value)
            continue

        if key in {
            "registration_id_hash",
            "device_token_hash",
            "password_hash",
            "session_token_hash",
        }:
            continue

        if isinstance(value, (dict, list)):
            result[key] = value
        else:
            result[key] = serialize_datetime(value)

    last_seen = document.get("last_seen")
    if isinstance(last_seen, datetime):
        if last_seen.tzinfo is None:
            last_seen = last_seen.replace(tzinfo=timezone.utc)
        result["status"] = (
            "Online"
            if datetime.now(timezone.utc) - last_seen
            < timedelta(seconds=ONLINE_WINDOW_SECONDS)
            else "Offline"
        )
    else:
        result["status"] = "Offline"

    return result


# -------------------------------------------------------------------- hub


class Hub:
    """In-memory relay between device sockets and operator viewer sockets."""

    def __init__(self):
        self.device_sockets: Dict[str, WebSocket] = {}
        self.viewer_sockets: Dict[str, Set[WebSocket]] = {}
        self.lock = asyncio.Lock()

    # ---- device side

    async def add_device(self, device_id: str, ws: WebSocket):
        async with self.lock:
            self.device_sockets[device_id] = ws

    async def remove_device(self, device_id: str, ws: WebSocket):
        async with self.lock:
            if self.device_sockets.get(device_id) is ws:
                self.device_sockets.pop(device_id, None)

    def device_online(self, device_id: str) -> bool:
        return device_id in self.device_sockets

    @property
    def streaming_count(self) -> int:
        return len(self.device_sockets)

    async def send_to_device(self, device_id: str, payload: dict) -> bool:
        ws = self.device_sockets.get(device_id)
        if ws is None:
            return False
        try:
            await ws.send_json(payload)
            return True
        except Exception:
            return False

    # ---- viewer side

    async def add_viewer(self, device_id: str, ws: WebSocket):
        async with self.lock:
            self.viewer_sockets.setdefault(device_id, set()).add(ws)

    async def remove_viewer(self, device_id: str, ws: WebSocket) -> int:
        async with self.lock:
            sockets = self.viewer_sockets.get(device_id)
            if not sockets:
                return 0
            sockets.discard(ws)
            if not sockets:
                self.viewer_sockets.pop(device_id, None)
                return 0
            return len(sockets)

    def viewer_count(self, device_id: str) -> int:
        return len(self.viewer_sockets.get(device_id, ()))

    async def broadcast_to_viewers(self, device_id: str, payload: dict):
        for ws in list(self.viewer_sockets.get(device_id, ())):
            try:
                await ws.send_json(payload)
            except Exception:
                pass


hub = Hub()


# ------------------------------------------------------------ public routes


@app.get("/")
async def home():
    return {
        "app": "TPC PANEL",
        "status": "online",
        "version": "3.0.0",
        "owner": "https://t.me/icivan",
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/health/database")
async def database_health():
    result = check_database()
    if result["status"] != "ok":
        raise HTTPException(status_code=503, detail="Database connection failed")
    return result


@app.get("/admin", include_in_schema=False)
async def admin_dashboard():
    if not ADMIN_FILE.is_file():
        raise HTTPException(status_code=404, detail="Admin dashboard file not found")
    return FileResponse(ADMIN_FILE)


@app.get("/admin/login", include_in_schema=False)
async def admin_login_page():
    return await admin_dashboard()


# ------------------------------------------------------------ admin auth


@app.get("/admin/auth/status")
async def admin_auth_status(request: Request):
    admin_id = request.session.get("admin_id")
    return {"authenticated": bool(admin_id), "admin_id": admin_id}


@app.post("/admin/login")
async def admin_login(payload: AdminLoginRequest, request: Request):
    username = payload.username.strip()

    if not secrets.compare_digest(username, ADMIN_USERNAME):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    if not secrets.compare_digest(payload.password, ADMIN_PASSWORD):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    request.session["admin_id"] = ADMIN_USERNAME

    log_event(
        "admin_login",
        details={"username": ADMIN_USERNAME},
        admin_id=ADMIN_USERNAME,
    )

    return {"status": "ok", "message": "Login successful", "username": ADMIN_USERNAME}


@app.post("/admin/logout")
async def admin_logout(request: Request):
    admin_id = request.session.get("admin_id")

    if admin_id:
        log_event("admin_logout", admin_id=admin_id)

    request.session.clear()
    return {"status": "ok", "message": "Logged out"}


# --------------------------------------------------------------- pairing


@app.post("/pair")
async def create_pair(payload: PairRequest):
    device_name = payload.device_name.strip()

    if not device_name:
        raise HTTPException(status_code=400, detail="Device name required")

    code = secrets.token_urlsafe(8)
    now = time.time()

    try:
        pairing_codes.insert_one({
            "code_hash": hash_value(code),
            "device_name": device_name,
            "created_at": now,
            "expires_at": now + SESSION_TTL,
            "used_at": None,
        })
        log_event("pairing_code_created", {"device_name": device_name})
    except PyMongoError:
        raise HTTPException(status_code=503, detail="Could not create pairing code")

    return {"pair_code": code, "expires_in_seconds": SESSION_TTL}


# --------------------------------------------------------------- devices


@app.post("/devices/register")
async def register_device(payload: DeviceRegistrationRequest):
    device_name = payload.device_name.strip()
    registration_id = payload.registration_id.strip()
    platform = payload.platform.strip().lower()

    if not device_name or not registration_id:
        raise HTTPException(
            status_code=400,
            detail="Device name and registration ID are required",
        )

    if platform != "android":
        raise HTTPException(status_code=400, detail="Unsupported platform")

    if not payload.owner_approved:
        raise HTTPException(status_code=403, detail="Device owner approval is required")

    registration_hash = hash_value(registration_id)
    now = utc_now()

    telemetry = sanitize_telemetry(payload.telemetry)

    set_fields = {
        "device_name": device_name,
        "platform": platform,
        "last_seen": now,
        "is_active": True,
        "is_authorized": True,
    }

    if telemetry:
        set_fields["telemetry"] = telemetry
        set_fields.update(telemetry_summary(telemetry))

    try:
        devices.update_one(
            {"registration_id_hash": registration_hash},
            {
                "$set": set_fields,
                "$setOnInsert": {
                    "registration_id_hash": registration_hash,
                    "created_at": now,
                },
            },
            upsert=True,
        )

        log_event(
            "device_registered",
            {
                "device_name": device_name,
                "model": telemetry.get("model"),
                "carrier": telemetry.get("sim_carrier"),
            },
        )
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="Device registration conflict")
    except PyMongoError:
        raise HTTPException(status_code=503, detail="Could not register device")

    return {
        "status": "registered",
        "device_name": device_name,
        "telemetry_saved": bool(telemetry),
    }


@app.post("/devices/heartbeat")
async def device_heartbeat(payload: DeviceHeartbeatRequest):
    registration_hash = hash_value(payload.registration_id.strip())
    now = utc_now()

    set_fields = {"last_seen": now, "is_active": True}

    telemetry = sanitize_telemetry(payload.telemetry)
    if telemetry:
        set_fields["telemetry"] = telemetry
        set_fields.update(telemetry_summary(telemetry))

    try:
        result = devices.update_one(
            {"registration_id_hash": registration_hash},
            {"$set": set_fields},
        )

        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Device is not registered")

        return {
            "status": "ok",
            "online": True,
            "last_seen": now.isoformat(),
            "telemetry_saved": bool(telemetry),
        }
    except PyMongoError:
        raise HTTPException(status_code=503, detail="Could not update device status")


# ------------------------------------------------------------- admin data


@app.get("/admin/devices")
async def admin_devices(
    request: Request,
    x_admin_key: str | None = Header(default=None),
):
    if not request.session.get("admin_id"):
        require_api_key(x_admin_key)

    try:
        result = []
        for device in (
            devices.find({}, {"registration_id_hash": 0, "device_token_hash": 0})
            .sort("_id", -1)
            .limit(200)
        ):
            serialized = serialize_document(device)
            serialized["ws_connected"] = hub.device_online(serialized["id"])
            serialized["viewer_count"] = hub.viewer_count(serialized["id"])
            result.append(serialized)

        return {"devices": result}
    except PyMongoError:
        raise HTTPException(status_code=503, detail="Could not load devices")


@app.get("/admin/sessions")
async def admin_sessions(
    request: Request,
    x_admin_key: str | None = Header(default=None),
):
    if not request.session.get("admin_id"):
        require_api_key(x_admin_key)

    try:
        result = [
            serialize_document(session)
            for session in support_sessions.find().sort("_id", -1).limit(200)
        ]
        return {"sessions": result}
    except PyMongoError:
        raise HTTPException(status_code=503, detail="Could not load sessions")


@app.get("/admin/activity")
async def admin_activity(
    request: Request,
    x_admin_key: str | None = Header(default=None),
):
    if not request.session.get("admin_id"):
        require_api_key(x_admin_key)

    try:
        result = [
            serialize_document(event)
            for event in activity_logs.find().sort("_id", -1).limit(100)
        ]
        return {"activity": result}
    except PyMongoError:
        raise HTTPException(status_code=503, detail="Could not load activity logs")


@app.get("/admin/overview")
async def admin_overview(request: Request):
    require_admin_session(request)

    try:
        registered_devices = devices.count_documents({})
        online_cutoff = utc_now() - timedelta(seconds=ONLINE_WINDOW_SECONDS)

        active_devices = devices.count_documents({"last_seen": {"$gte": online_cutoff}})
        charging_devices = devices.count_documents({"battery_charging": True})
        active_sessions = support_sessions.count_documents({
            "status": {"$in": ["active", "approved", "in_progress"]},
        })

        return {
            "registered_devices": registered_devices,
            "active_devices": active_devices,
            "charging_devices": charging_devices,
            "active_sessions": active_sessions,
            "streaming_devices": hub.streaming_count,
        }
    except PyMongoError:
        raise HTTPException(status_code=503, detail="Could not load dashboard overview")


# ------------------------------------------------------- legacy pairing ws


@app.websocket("/ws/{pair_code}")
async def pairing_socket(websocket: WebSocket, pair_code: str):
    code_hash = hash_value(pair_code)
    now = time.time()

    try:
        pairing = pairing_codes.find_one({
            "code_hash": code_hash,
            "expires_at": {"$gt": now},
            "used_at": None,
        })
    except PyMongoError:
        await websocket.close(code=1011)
        return

    if not pairing:
        await websocket.close(code=1008)
        return

    await websocket.accept()

    try:
        await websocket.send_json({
            "type": "pairing_valid",
            "device_name": pairing["device_name"],
            "message": "Pairing validated. Device-owner approval is still required.",
        })

        while True:
            message = await websocket.receive_text()
            if len(message) > 65536:
                await websocket.close(code=1009)
                break
            await websocket.send_json({"type": "ack", "received": True})
    except WebSocketDisconnect:
        pass


# -------------------------------------------------------- device stream ws


@app.websocket("/ws/device/{registration_id}")
async def device_socket(websocket: WebSocket, registration_id: str):
    registration_hash = hash_value(registration_id.strip())

    try:
        device = devices.find_one({"registration_id_hash": registration_hash})
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
        devices.update_one(
            {"_id": device["_id"]},
            {"$set": {"ws_connected": True, "ws_connected_at": utc_now()}},
        )

        log_event("device_stream_connected", {"device_id": device_id})

        await hub.broadcast_to_viewers(
            device_id, {"type": "device_status", "online": True}
        )

        while True:
            raw = await websocket.receive_text()

            if len(raw) > MAX_WS_TEXT_BYTES:
                continue

            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue

            kind = message.get("type")

            if kind == "frame":
                await hub.broadcast_to_viewers(device_id, message)

            elif kind == "telemetry":
                telemetry = sanitize_telemetry(message.get("data"))
                if telemetry:
                    devices.update_one(
                        {"_id": device["_id"]},
                        {"$set": {"telemetry": telemetry, **telemetry_summary(telemetry)}},
                    )
                await hub.broadcast_to_viewers(
                    device_id, {"type": "telemetry", "data": telemetry}
                )

            elif kind == "pong":
                pass

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await hub.remove_device(device_id, websocket)

        try:
            devices.update_one(
                {"_id": device["_id"]},
                {"$set": {"ws_connected": False, "ws_disconnected_at": utc_now()}},
            )
        except PyMongoError:
            pass

        log_event("device_stream_disconnected", {"device_id": device_id})

        await hub.broadcast_to_viewers(
            device_id, {"type": "device_status", "online": False}
        )


# -------------------------------------------------------- operator view ws


@app.websocket("/ws/view/{device_id}")
async def viewer_socket(websocket: WebSocket, device_id: str):
    admin_id = websocket.session.get("admin_id")

    if not admin_id:
        await websocket.close(code=1008)
        return

    try:
        object_id = ObjectId(device_id)
    except Exception:
        await websocket.close(code=1008)
        return

    try:
        device = devices.find_one({"_id": object_id})
    except PyMongoError:
        await websocket.close(code=1011)
        return

    if not device:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    await hub.add_viewer(device_id, websocket)

    now = utc_now()
    session_id = secrets.token_hex(8)

    try:
        support_sessions.update_one(
            {"device_id": device_id, "status": "active"},
            {
                "$set": {
                    "device_id": device_id,
                    "device_name": device.get("device_name", "Unknown"),
                    "status": "active",
                    "admin_id": admin_id,
                    "updated_at": now,
                },
                "$setOnInsert": {"created_at": now, "session_id": session_id},
            },
            upsert=True,
        )

        await websocket.send_json({
            "type": "snapshot",
            "device": serialize_document(device),
            "device_online": hub.device_online(device_id),
            "control_available": hub.device_online(device_id),
        })

        if hub.device_online(device_id):
            await hub.send_to_device(device_id, {"type": "stream_start"})

        log_event("viewer_joined", {"device_id": device_id}, admin_id=admin_id)

        while True:
            raw = await websocket.receive_text()

            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if message.get("type") != "control":
                continue

            delivered = await hub.send_to_device(device_id, message)

            if not delivered:
                try:
                    await websocket.send_json({
                        "type": "control_ack",
                        "delivered": False,
                    })
                except Exception:
                    pass

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        remaining = await hub.remove_viewer(device_id, websocket)

        if remaining == 0:
            await hub.send_to_device(device_id, {"type": "stream_stop"})

            try:
                support_sessions.update_many(
                    {"device_id": device_id, "status": "active"},
                    {"$set": {"status": "ended", "ended_at": utc_now()}},
                )
            except PyMongoError:
                pass

        log_event("viewer_left", {"device_id": device_id}, admin_id=admin_id)