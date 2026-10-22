"""HTTP + WebSocket routes for the builder, plus the socket room hub.

Rooms:
  user:<userId>  -> build events (sirf usi user ko)
  app:<appId>    -> app ka data events (sirf usi app ke sockets ko)

Panel routes /api/apps, /api/builds session/token auth se chalti hain.
App routes /api/orders signed headers se chalti hain.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Dict, Optional, Set

from fastapi import (
    APIRouter, Body, Header, HTTPException, Query, Request, WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import config, service, storage, validators
from .queue import get_queue
from .validators import ValidationError

log = logging.getLogger("tpc.apk.routes")

router = APIRouter(tags=["builder"])

# ---------------------------------------------------------------- room hub

_LOOP: Optional[asyncio.AbstractEventLoop] = None


class RoomHub:
    def __init__(self):
        self._rooms: Dict[str, Set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def join(self, room: str, ws: WebSocket) -> None:
        async with self._lock:
            self._rooms.setdefault(room, set()).add(ws)

    async def leave(self, room: str, ws: WebSocket) -> None:
        async with self._lock:
            s = self._rooms.get(room)
            if s:
                s.discard(ws)
                if not s:
                    self._rooms.pop(room, None)

    async def emit(self, room: str, payload: dict) -> int:
        async with self._lock:
            targets = list(self._rooms.get(room) or ())
        dead = []
        for ws in targets:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.leave(room, ws)
        return len(targets) - len(dead)

    def emit_sync(self, room: str, payload: dict) -> None:
        loop = _LOOP
        if loop is None or loop.is_closed():
            return
        try:
            asyncio.run_coroutine_threadsafe(self.emit(room, payload), loop)
        except Exception:
            pass

    def stats(self) -> dict:
        return {"rooms": len(self._rooms),
                "sockets": sum(len(v) for v in self._rooms.values())}


rooms = RoomHub()


def bind_loop(loop) -> None:
    global _LOOP
    _LOOP = loop


def emit_to_user(user_id: str, payload: dict) -> None:
    rooms.emit_sync(f"user:{user_id}", payload)


def emit_to_app(app_id: str, payload: dict) -> None:
    rooms.emit_sync(f"app:{app_id}", payload)


def _emit_build_event(user_id: str, payload: dict) -> None:
    emit_to_user(user_id, payload)


# ------------------------------------------------------------------- auth

def _panel(request: Request) -> dict:
    """app.py ke require_panel ko lazy import (circular import se bachne ke liye)."""
    from backend.app import require_panel
    return require_panel(request)


def _user_id(request: Request) -> str:
    ident = _panel(request)
    role, name = ident.get("role"), ident.get("name")
    return name if role else "user"


# ---------------------------------------------------------------- schemas

class AppCreate(BaseModel):
    name: str = Field(min_length=2, max_length=40)


class AppRename(BaseModel):
    name: str = Field(min_length=2, max_length=40)


class BuildCreate(BaseModel):
    appId: str = Field(min_length=4, max_length=40)
    variant: str | None = None
    versionCode: int | None = None
    versionName: str | None = None
    baseUrl: str | None = None
    force: bool = False


class OrderCreate(BaseModel):
    ref: str | None = Field(default=None, max_length=64)
    amount: float | None = None
    note: str | None = Field(default=None, max_length=500)
    payload: dict | None = None


# ------------------------------------------------------------- error glue

def _err(e: Exception) -> HTTPException:
    if isinstance(e, service.BuilderError):
        return HTTPException(e.status, e.message)
    if isinstance(e, ValidationError):
        return HTTPException(400, str(e))
    return HTTPException(500, "internal error")


# ======================================================= panel: apps

@router.get("/api/builder/config")
async def builder_config(request: Request):
    _panel(request)
    return {
        "variant": config.DEFAULT_VARIANT,
        "daily_quota": config.DAILY_BUILD_QUOTA,
        "download_ttl": config.DOWNLOAD_URL_TTL,
        "signature_window": config.SIGNED_WINDOW_SECONDS,
        "signature_version": config.SIGNATURE_VERSION,
        "concurrency": config.MAX_CONCURRENT_BUILDS,
        "worker_mode": config.WORKER_MODE,
        "queue": get_queue().stats(),
    }


@router.get("/api/apps")
async def list_apps(request: Request, reveal: bool = False):
    uid = _user_id(request)
    rows = service.list_apps(uid)
    return {
        "apps": [service.app_public(a, reveal_secret=reveal) for a in rows],
        "quota": service.quota_state(uid),
    }


@router.post("/api/apps")
async def create_app(request: Request, payload: AppCreate):
    uid = _user_id(request)
    try:
        doc = service.create_app(uid, payload.name)
    except Exception as e:
        raise _err(e)

    out = service.app_public(doc)
    out["secret"] = doc.get("_plain_secret")     # sirf yahan plain milega
    log.info("app created %s by %s", doc["appId"], uid)
    return {"status": "ok", "app": out}


@router.get("/api/apps/{app_id}")
async def get_app(app_id: str, request: Request):
    uid = _user_id(request)
    try:
        doc = service.get_app(uid, app_id)
    except Exception as e:
        raise _err(e)
    return {"app": service.app_public(doc)}


@router.post("/api/apps/{app_id}/rename")
async def rename_app(app_id: str, request: Request, payload: AppRename):
    uid = _user_id(request)
    try:
        doc = service.rename_app(uid, app_id, payload.name)
    except Exception as e:
        raise _err(e)
    return {"status": "ok", "app": service.app_public(doc)}


@router.post("/api/apps/{app_id}/secret/rotate")
async def rotate_secret(app_id: str, request: Request):
    """Purana secret turant invalid. Naya APK rebuild karna padega."""
    uid = _user_id(request)
    try:
        doc = service.rotate_secret(uid, app_id)
    except Exception as e:
        raise _err(e)

    out = service.app_public(doc)
    out["secret"] = doc.get("_plain_secret")
    log.info("secret rotated for %s", doc["appId"])
    return {
        "status": "ok",
        "app": out,
        "note": "purana secret ab 401 dega — app ko dobara build karo",
    }


@router.delete("/api/apps/{app_id}")
async def delete_app(app_id: str, request: Request):
    uid = _user_id(request)
    try:
        service.delete_app(uid, app_id)
        storage.purge_app(app_id)
    except Exception as e:
        raise _err(e)
    return {"status": "ok"}


# ======================================================= panel: builds

@router.get("/api/builds")
async def list_builds(request: Request, appId: str | None = None, limit: int = 50):
    uid = _user_id(request)
    rows = service.list_builds(uid, appId, limit)
    return {"builds": [service.build_public(b) for b in rows],
            "queue": get_queue().stats()}


@router.post("/api/builds")
async def create_build(request: Request, payload: BuildCreate):
    uid = _user_id(request)
    try:
        doc = service.create_build(
            uid, payload.appId,
            {
                "variant": payload.variant,
                "versionCode": payload.versionCode,
                "versionName": payload.versionName,
                "baseUrl": payload.baseUrl,
            },
            force=payload.force,
        )
    except Exception as e:
        raise _err(e)

    queued = await get_queue().enqueue(doc["buildId"])
    if not queued:
        log.info("build %s pehle se queue me hai", doc["buildId"])

    return {"status": "ok", "build": service.build_public(doc), "queued": queued}


@router.get("/api/builds/{build_id}")
async def get_build(build_id: str, request: Request, log_tail: bool = True):
    uid = _user_id(request)
    try:
        doc = service.get_build(uid, build_id)
    except Exception as e:
        raise _err(e)
    return {"build": service.build_public(doc, include_log=log_tail)}


@router.post("/api/builds/{build_id}/cancel")
async def cancel_build(build_id: str, request: Request):
    uid = _user_id(request)
    try:
        doc = service.mark_canceled(uid, build_id)
    except Exception as e:
        raise _err(e)
    get_queue().cancel(build_id)
    return {"status": "ok", "build": service.build_public(doc)}


@router.post("/api/builds/{build_id}/retry")
async def retry_build(build_id: str, request: Request):
    uid = _user_id(request)
    try:
        old = service.get_build(uid, build_id)
    except Exception as e:
        raise _err(e)

    if old.get("status") in service.ACTIVE_STATUSES:
        return {"status": "ok", "build": service.build_public(old), "queued": False}

    doc = service.create_build(uid, old["appId"], {
        "variant": old.get("variant"),
        "versionCode": old.get("versionCode"),
        "versionName": old.get("versionName"),
        "baseUrl": old.get("baseUrl"),
    }, force=True)

    await get_queue().enqueue(doc["buildId"])
    return {"status": "ok", "build": service.build_public(doc), "queued": True}


@router.get("/api/builds/{build_id}/download")
async def build_download(build_id: str, request: Request,
                         token: str | None = Query(default=None)):
    """Bina token: ownership check karke fresh signed URL deta hai.
    Token ke saath: token verify karke seedha APK stream karta hai.
    """
    if token:
        try:
            t_build, t_user, _ = storage.verify_download(token)
        except ValidationError as e:
            raise HTTPException(401, str(e))

        if t_build != build_id:
            raise HTTPException(400, "token is build ka nahi hai")

        doc = service.builds_col().find_one({"buildId": build_id})
        if not doc:
            raise HTTPException(404, "build nahi mila")

        # token user match, ya logged-in owner
        try:
            uid = _user_id(request)
        except HTTPException:
            uid = None
        if uid != t_user and uid != doc.get("userId"):
            raise HTTPException(403, "forbidden")

        if doc.get("status") != "success" or not doc.get("apk_path"):
            raise HTTPException(409, f"APK ready nahi hai (status={doc.get('status')})")

        from pathlib import Path
        p = Path(doc["apk_path"])
        if not p.is_file():
            raise HTTPException(410, "APK file gayab ho gayi — rebuild karo")

        return FileResponse(
            p,
            media_type="application/vnd.android.package-archive",
            filename=f"{doc.get('appName') or doc['appId']}-{build_id}.apk",
            headers={
                "X-APK-SHA256": doc.get("apk_sha256") or "",
                "Cache-Control": "private, max-age=300",
            },
        )

    uid = _user_id(request)
    try:
        doc = service.get_build(uid, build_id)
    except Exception as e:
        raise _err(e)

    if doc.get("status") != "success" or not doc.get("apk_path"):
        raise HTTPException(409, f"APK ready nahi hai (status={doc.get('status')})")

    signed = storage.sign_download(build_id, uid)
    return {
        "status": "ok",
        "url": signed["url"],
        "expires_in": signed["expires_in"],
        "expires_at": signed["expires_at"],
        "apk_size": doc.get("apk_size"),
        "apk_sha256": doc.get("apk_sha256"),
        "signed": bool(doc.get("signed")),
    }


# ================================================== app-facing: signed only

def _signed(request: Request, body: bytes) -> dict:
    try:
        return service.verify_signed_request(
            request.headers, body,
            method=request.method,
            path=request.url.path,
        )
    except service.AuthError as e:
        raise HTTPException(e.status, e.message)
    except ValidationError as e:
        raise HTTPException(400, str(e))


@router.post("/api/orders")
async def order_create(request: Request):
    body = await request.body()
    if len(body) > config.MAX_BODY_BYTES:
        raise HTTPException(413, "body bahut bada hai")

    app = _signed(request, body)

    try:
        payload = json.loads(body.decode("utf-8")) if body else {}
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "body valid JSON nahi hai")

    # body me appId aaye to bhi ignore — verified header hi sach hai
    payload.pop("appId", None)

    repo = service.repo_for("orders", app["appId"])
    doc = {
        "ref": (payload.get("ref") or "")[:64],
        "amount": payload.get("amount"),
        "note": (payload.get("note") or "")[:500],
        "payload": payload.get("payload") if isinstance(payload.get("payload"), dict) else {},
        "source": "app",
    }

    try:
        oid = repo.insert(doc)
    except service.BuilderError as e:
        raise HTTPException(e.status, e.message)

    created = repo.find_one({"_id": oid})
    out = _serialize(created)

    emit_to_app(app["appId"], {"type": "order", "data": out})
    return {"status": "ok", "order": out, "appId": app["appId"]}


@router.get("/api/orders")
async def order_list(request: Request, limit: int = 50, skip: int = 0):
    app = _signed(request, b"")
    repo = service.repo_for("orders", app["appId"])
    rows = repo.find(limit=limit, skip=skip)
    return {
        "appId": app["appId"],
        "count": repo.count(),
        "orders": [_serialize(r) for r in rows],
    }


@router.get("/api/orders/{order_id}")
async def order_get(order_id: str, request: Request):
    app = _signed(request, b"")
    repo = service.repo_for("orders", app["appId"])

    from bson import ObjectId
    try:
        oid = ObjectId(order_id)
    except Exception:
        raise HTTPException(400, "bad order id")

    row = repo.find_one({"_id": oid})
    if not row:
        raise HTTPException(404, "order nahi mila (ya doosre app ka hai)")
    return {"order": _serialize(row), "appId": app["appId"]}


@router.delete("/api/orders/{order_id}")
async def order_delete(order_id: str, request: Request):
    app = _signed(request, b"")
    repo = service.repo_for("orders", app["appId"])

    from bson import ObjectId
    try:
        oid = ObjectId(order_id)
    except Exception:
        raise HTTPException(400, "bad order id")

    res = repo.delete_one({"_id": oid})
    if not res.deleted_count:
        raise HTTPException(404, "order nahi mila")
    emit_to_app(app["appId"], {"type": "order_deleted", "data": {"id": order_id}})
    return {"status": "ok"}


@router.post("/api/echo")
async def echo(request: Request):
    """Signed handshake verify karne ke liye chhota endpoint."""
    body = await request.body()
    app = _signed(request, body)
    return {
        "status": "ok",
        "appId": app["appId"],
        "name": app.get("name"),
        "body_bytes": len(body),
        "verified": True,
    }


def _serialize(doc: Optional[dict]) -> dict:
    if not doc:
        return {}
    out = {}
    for k, v in doc.items():
        if k == "_id":
            out["id"] = str(v)
        elif hasattr(v, "isoformat"):
            out[k] = v.isoformat()
        else:
            out[k] = v
    return out


# ================================================== websockets (rooms)

def _ws_user(ws: WebSocket) -> Optional[str]:
    """token query param ya session cookie se identity nikalo."""
    token = ws.query_params.get("token")
    if token:
        try:
            from backend.app import verify_token
            ident = verify_token(token)
            if ident:
                role, name = ident.split(":", 1) if ":" in ident else ("admin", ident)
                return name
        except Exception:
            return None

    try:
        ident = ws.session.get("admin_id")
        if ident:
            return ident.split(":", 1)[1] if ":" in ident else ident
    except Exception:
        pass
    return None


@router.websocket("/ws/user")
async def user_socket(websocket: WebSocket):
    """Panel user socket — build events sirf uske room me."""
    uid = _ws_user(websocket)
    if not uid:
        await websocket.close(code=1008)
        return

    room = f"user:{uid}"
    await websocket.accept()
    await rooms.join(room, websocket)

    try:
        await websocket.send_json({
            "type": "hello",
            "room": room,
            "queue": get_queue().stats(),
            "server_time": service._now().isoformat(),
        })

        while True:
            raw = await websocket.receive_text()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if str(msg.get("type") or "").lower() == "ping":
                await websocket.send_json({"type": "pong"})
            elif str(msg.get("type") or "").lower() == "subscribe":
                build = msg.get("buildId")
                if build:
                    await rooms.join(f"build:{build}", websocket)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await rooms.leave(room, websocket)


@router.websocket("/ws/app")
async def app_socket(websocket: WebSocket):
    """APK ka socket. Signed handshake -> room app:<appId>.

    Handshake: connect karo, pehla frame bhejo:
      {"type":"auth","appId":"a_...","ts":123,"sig":"...","body":""}
    sig = HMAC(secret, body + ts)
    """
    await websocket.accept()

    app_id: Optional[str] = None
    room: Optional[str] = None
    deadline = asyncio.get_event_loop().time() + 15

    try:
        while app_id is None:
            timeout = max(1.0, deadline - asyncio.get_event_loop().time())
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=timeout)
            except asyncio.TimeoutError:
                await websocket.close(code=1008)
                return

            try:
                msg = json.loads(raw)
            except ValueError:
                continue

            if str(msg.get("type") or "").lower() != "auth":
                continue

            headers = {
                "X-App-Id": str(msg.get("appId") or ""),
                "X-Timestamp": str(msg.get("ts") or ""),
                "X-Signature": str(msg.get("sig") or ""),
            }
            body = str(msg.get("body") or "").encode()

            try:
                app = service.verify_signed_request(headers, body, "WS", "/ws/app")
            except Exception as e:
                await websocket.send_json({"type": "auth_error", "error": str(e)})
                await websocket.close(code=1008)
                return

            app_id = app["appId"]
            room = f"app:{app_id}"

        await rooms.join(room, websocket)
        await websocket.send_json({
            "type": "auth_ok",
            "appId": app_id,
            "room": room,
            "server_time": service._now().isoformat(),
        })

        while True:
            raw = await websocket.receive_text()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if str(msg.get("type") or "").lower() == "ping":
                await websocket.send_json({"type": "pong"})

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if room:
            await rooms.leave(room, websocket)


@router.get("/api/builder/socket-stats")
async def socket_stats(request: Request):
    _panel(request)
    return rooms.stats()