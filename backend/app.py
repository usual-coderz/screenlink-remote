import os
import time
import secrets
import hashlib
from pathlib import Path
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import (
    FastAPI,
    HTTPException,
    Header,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from pydantic import BaseModel, Field
from pymongo.errors import PyMongoError, DuplicateKeyError
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


BASE_DIR = Path(__file__).resolve().parent.parent
ADMIN_FILE = BASE_DIR / "admin" / "index.html"

SESSION_TTL = 300
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY")
SESSION_SECRET = os.getenv("SESSION_SECRET")
COOKIE_NAME = "screenlink_admin_session"

password_hasher = PasswordHash.recommended()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="ScreenLink Remote",
    version="2.0.0",
    lifespan=lifespan,
)

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


class PairRequest(BaseModel):
    device_name: str = Field(min_length=1, max_length=40)


class DeviceRegistrationRequest(BaseModel):
    device_name: str = Field(min_length=1, max_length=40)
    platform: str = Field(default="android", max_length=20)
    registration_id: str = Field(min_length=16, max_length=128)
    owner_approved: bool = False


class AdminLoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


def hash_value(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def log_event(
    event_type: str,
    details=None,
    device_id=None,
    admin_id=None,
):
    activity_logs.insert_one({
        "event_type": event_type,
        "details": details,
        "device_id": device_id,
        "admin_id": admin_id,
        "created_at": utc_now(),
    })


def require_api_key(api_key: str | None):
    if not ADMIN_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="Admin API key is not configured",
        )

    if not api_key or not secrets.compare_digest(
        api_key,
        ADMIN_API_KEY,
    ):
        raise HTTPException(
            status_code=401,
            detail="Unauthorized",
        )


def require_admin_session(request: Request):
    admin_id = request.session.get("admin_id")

    if not admin_id:
        raise HTTPException(
            status_code=401,
            detail="Please log in",
        )

    return admin_id


def serialize_datetime(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)

        return value.isoformat()

    if value is None:
        return None

    return str(value)


def serialize_document(document):
    result = {}

    for key, value in document.items():
        if key == "_id":
            result["id"] = str(value)
        elif key not in {
            "registration_id_hash",
            "device_token_hash",
            "password_hash",
            "session_token_hash",
        }:
            result[key] = serialize_datetime(value)

    return result


@app.get("/")
async def home():
    return {
        "app": "ScreenLink Remote",
        "status": "online",
        "version": "2.0.0",
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/health/database")
async def database_health():
    result = check_database()

    if result["status"] != "ok":
        raise HTTPException(
            status_code=503,
            detail="Database connection failed",
        )

    return result


@app.get("/admin", include_in_schema=False)
async def admin_dashboard():
    if not ADMIN_FILE.is_file():
        raise HTTPException(
            status_code=404,
            detail="Admin dashboard file not found",
        )

    return FileResponse(ADMIN_FILE)


@app.get("/admin/login", include_in_schema=False)
async def admin_login_page():
    if not ADMIN_FILE.is_file():
        raise HTTPException(
            status_code=404,
            detail="Admin dashboard file not found",
        )

    return FileResponse(ADMIN_FILE)


@app.get("/admin/auth/status")
async def admin_auth_status(request: Request):
    admin_id = request.session.get("admin_id")

    return {
        "authenticated": bool(admin_id),
        "admin_id": admin_id,
    }


@app.post("/admin/login")
async def admin_login(
    request: Request,
    payload: AdminLoginRequest,
):
    admin = admins.find_one({
        "username": payload.username.strip(),
        "is_active": True,
    })

    if not admin:
        raise HTTPException(
            status_code=401,
            detail="Invalid username or password",
        )

    stored_hash = admin.get("password_hash", "")

    try:
        valid = password_hasher.verify(
            payload.password,
            stored_hash,
        )
    except Exception:
        valid = False

    if not valid:
        raise HTTPException(
            status_code=401,
            detail="Invalid username or password",
        )

    request.session.clear()
    request.session["admin_id"] = str(admin["_id"])
    request.session["username"] = admin["username"]

    log_event(
        "admin_login",
        {"username": admin["username"]},
        admin_id=str(admin["_id"]),
    )

    return {
        "status": "ok",
        "message": "Login successful",
        "username": admin["username"],
    }


@app.post("/admin/logout")
async def admin_logout(request: Request):
    admin_id = request.session.get("admin_id")

    if admin_id:
        log_event(
            "admin_logout",
            admin_id=admin_id,
        )

    request.session.clear()

    return {"status": "ok", "message": "Logged out"}


@app.post("/pair")
async def create_pair(payload: PairRequest):
    device_name = payload.device_name.strip()

    if not device_name:
        raise HTTPException(
            status_code=400,
            detail="Device name required",
        )

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

        log_event(
            "pairing_code_created",
            {"device_name": device_name},
        )

    except PyMongoError:
        raise HTTPException(
            status_code=503,
            detail="Could not create pairing code",
        )

    return {
        "pair_code": code,
        "expires_in_seconds": SESSION_TTL,
    }


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
        raise HTTPException(
            status_code=400,
            detail="Unsupported platform",
        )

    if not payload.owner_approved:
        raise HTTPException(
            status_code=403,
            detail="Device owner approval is required",
        )

    registration_hash = hash_value(registration_id)
    now = utc_now()

    try:
        devices.update_one(
            {"registration_id_hash": registration_hash},
            {
                "$set": {
                    "device_name": device_name,
                    "platform": platform,
                    "last_seen": now,
                    "is_active": True,
                    "is_authorized": True,
                },
                "$setOnInsert": {
                    "registration_id_hash": registration_hash,
                    "created_at": now,
                },
            },
            upsert=True,
        )

        log_event(
            "device_registered",
            {"device_name": device_name},
        )

    except DuplicateKeyError:
        raise HTTPException(
            status_code=409,
            detail="Device registration conflict",
        )
    except PyMongoError:
        raise HTTPException(
            status_code=503,
            detail="Could not register device",
        )

    return {
        "status": "registered",
        "device_name": device_name,
    }


@app.get("/admin/devices")
async def admin_devices(
    request: Request,
    x_admin_key: str | None = Header(default=None),
):
    if request.session.get("admin_id"):
        pass
    else:
        require_api_key(x_admin_key)

    try:
        result = []

        for device in devices.find(
            {},
            {
                "registration_id_hash": 0,
                "device_token_hash": 0,
            },
        ).sort("_id", -1).limit(200):
            result.append(serialize_document(device))

        return {"devices": result}

    except PyMongoError:
        raise HTTPException(
            status_code=503,
            detail="Could not load devices",
        )


@app.get("/admin/sessions")
async def admin_sessions(
    request: Request,
    x_admin_key: str | None = Header(default=None),
):
    if request.session.get("admin_id"):
        pass
    else:
        require_api_key(x_admin_key)

    try:
        result = [
            serialize_document(session)
            for session in support_sessions.find().sort(
                "_id", -1
            ).limit(200)
        ]

        return {"sessions": result}

    except PyMongoError:
        raise HTTPException(
            status_code=503,
            detail="Could not load sessions",
        )


@app.get("/admin/activity")
async def admin_activity(
    request: Request,
    x_admin_key: str | None = Header(default=None),
):
    if request.session.get("admin_id"):
        pass
    else:
        require_api_key(x_admin_key)

    try:
        result = [
            serialize_document(event)
            for event in activity_logs.find().sort(
                "_id", -1
            ).limit(100)
        ]

        return {"activity": result}

    except PyMongoError:
        raise HTTPException(
            status_code=503,
            detail="Could not load activity logs",
        )


@app.get("/admin/overview")
async def admin_overview(request: Request):
    require_admin_session(request)

    try:
        registered_devices = devices.count_documents({})
        active_devices = devices.count_documents({
            "is_active": True,
        })
        active_sessions = support_sessions.count_documents({
            "status": {
                "$in": ["active", "approved", "in_progress"],
            },
        })

        return {
            "registered_devices": registered_devices,
            "active_devices": active_devices,
            "active_sessions": active_sessions,
        }

    except PyMongoError:
        raise HTTPException(
            status_code=503,
            detail="Could not load dashboard overview",
        )


@app.websocket("/ws/{pair_code}")
async def websocket_endpoint(
    websocket: WebSocket,
    pair_code: str,
):
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
            "message": (
                "Pairing validated. "
                "Device-owner approval is still required."
            ),
        })

        while True:
            message = await websocket.receive_text()

            if len(message) > 65536:
                await websocket.close(code=1009)
                break

            await websocket.send_json({
                "type": "ack",
                "received": True,
            })

    except WebSocketDisconnect:
        pass