import os
import secrets
import hashlib
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from pymongo.errors import PyMongoError

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

SESSION_TTL = 300
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="ScreenLink Remote",
    version="1.0.0",
    lifespan=lifespan,
)


class PairRequest(BaseModel):
    device_name: str = Field(min_length=1, max_length=40)


class AdminLoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


def hash_value(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def require_admin(api_key: str | None):
    if not ADMIN_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="Admin authentication is not configured",
        )

    if not api_key or not secrets.compare_digest(
        api_key,
        ADMIN_API_KEY,
    ):
        raise HTTPException(
            status_code=401,
            detail="Unauthorized",
        )


def log_event(event_type, details=None, device_id=None):
    activity_logs.insert_one({
        "event_type": event_type,
        "details": details,
        "device_id": device_id,
        "created_at": utc_now(),
    })


@app.get("/")
async def home():
    return {
        "app": "ScreenLink Remote",
        "status": "online",
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


@app.post("/pair")
async def create_pair(request: PairRequest):
    device_name = request.device_name.strip()

    if not device_name:
        raise HTTPException(
            status_code=400,
            detail="Device name required",
        )

    code = secrets.token_urlsafe(8)
    now = time.time()

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

    return {
        "pair_code": code,
        "expires_in_seconds": SESSION_TTL,
    }


@app.post("/admin/login")
async def admin_login(request: AdminLoginRequest):
    """
    Checks an existing admin record.
    Passwords must be stored as secure password hashes.
    This endpoint does not create admin accounts.
    """
    admin = admins.find_one({
        "username": request.username,
        "is_active": True,
    })

    if not admin:
        raise HTTPException(
            status_code=401,
            detail="Invalid credentials",
        )

    from pwdlib import PasswordHash

    password_hash = admin.get("password_hash", "")

    try:
        valid = PasswordHash.recommended().verify(
            request.password,
            password_hash,
        )
    except Exception:
        valid = False

    if not valid:
        raise HTTPException(
            status_code=401,
            detail="Invalid credentials",
        )

    # API key authentication remains separate from this login.
    # Do not treat this response as a browser login session.
    return {
        "status": "ok",
        "message": "Credentials verified",
        "admin_id": str(admin["_id"]),
    }


@app.get("/admin/devices")
async def admin_devices(
    x_admin_key: str | None = None,
):
    require_admin(x_admin_key)

    result = []

    for device in devices.find(
        {"is_active": True}
    ).sort("_id", -1).limit(200):
        result.append({
            "id": str(device["_id"]),
            "device_name": device.get("device_name", "Unknown"),
            "platform": device.get("platform", "android"),
            "created_at": device.get("created_at"),
            "last_seen": device.get("last_seen"),
            "is_authorized": device.get("is_authorized", False),
            "is_active": device.get("is_active", True),
        })

    return {"devices": result}


@app.get("/admin/sessions")
async def admin_sessions(
    x_admin_key: str | None = None,
):
    require_admin(x_admin_key)

    result = []

    for session in support_sessions.find().sort(
        "_id", -1
    ).limit(200):
        result.append({
            "id": str(session["_id"]),
            "device_id": str(session.get("device_id", "")),
            "status": session.get("status"),
            "created_at": session.get("created_at"),
            "owner_approved_at": session.get("owner_approved_at"),
            "started_at": session.get("started_at"),
            "ended_at": session.get("ended_at"),
        })

    return {"sessions": result}


@app.get("/admin/activity")
async def admin_activity(
    x_admin_key: str | None = None,
):
    require_admin(x_admin_key)

    result = []

    for event in activity_logs.find().sort(
        "_id", -1
    ).limit(100):
        result.append({
            "event_type": event.get("event_type"),
            "details": event.get("details"),
            "created_at": event.get("created_at"),
        })

    return {"activity": result}


@app.websocket("/ws/{pair_code}")
async def websocket_endpoint(
    websocket: WebSocket,
    pair_code: str,
):
    """
    Pairing validation only.
    This endpoint does not stream screens or send remote-control input.
    """
    code_hash = hash_value(pair_code)
    now = time.time()

    pairing = pairing_codes.find_one({
        "code_hash": code_hash,
        "expires_at": {"$gt": now},
        "used_at": None,
    })

    if not pairing:
        await websocket.close(code=1008)
        return

    await websocket.accept()

    try:
        await websocket.send_json({
            "type": "pairing_valid",
            "device_name": pairing["device_name"],
            "message": "Pairing validated; owner approval is still required.",
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