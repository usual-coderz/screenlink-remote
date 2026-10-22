"""Core services: secretService, signedRequest, scopedRepo, apps, builds.

Isolation ke teen stambh yahin hain:

  1. secretService -> per-app appId + appSecret (encrypted at rest) + rotation
  2. signedRequest -> X-App-Id / X-Timestamp / X-Signature verify (constant time)
  3. scopedRepo    -> har Mongo query me appId force

Yeh teen milke banate hain: koi app doosre app ka data nahi padh sakta,
aur koi doosre app ka appId spoof nahi kar sakta.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

from . import config, validators
from .validators import ValidationError

try:
    from cryptography.fernet import Fernet, InvalidToken
    _FERNET_OK = True
except Exception:                                  # pragma: no cover
    Fernet = None
    InvalidToken = Exception
    _FERNET_OK = False

log = logging.getLogger("tpc.apk.service")


class BuilderError(Exception):
    def __init__(self, message: str, status: int = 400, code: str = "bad_request"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


class AuthError(BuilderError):
    def __init__(self, message: str = "Unauthorized", status: int = 401, code: str = "unauthorized"):
        super().__init__(message, status, code)


# --------------------------------------------------------------- collections

def _db():
    from backend import database as d
    return d


def apps_col():
    return _db().apps


def builds_col():
    return _db().builds


def build_events_col():
    return _db().build_events


def orders_col():
    return _db().orders


def counters_col():
    return _db().counters


def nonces_col():
    return _db().app_nonces


def _now() -> datetime:
    return datetime.now(timezone.utc)


def next_seq(name: str) -> int:
    doc = counters_col().find_one_and_update(
        {"_id": name},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return int((doc or {}).get("seq") or 1)


# ============================================================== secretService

_fernet_cache: Dict[str, Any] = {}


def _fernet(key: str):
    if key not in _fernet_cache:
        if not _FERNET_OK:
            _fernet_cache[key] = None
        else:
            digest = hashlib.sha256(key.encode("utf-8")).digest()
            _fernet_cache[key] = Fernet(base64.urlsafe_b64encode(digest))
    return _fernet_cache[key]


def encrypt_secret(plain: str) -> str:
    f = _fernet(config.ENCRYPTION_KEY)
    if f is None:
        # cryptography nahi hai — base64 fallback (obfuscation, encryption nahi)
        return "b1:" + base64.urlsafe_b64encode(plain.encode()).decode()
    return "f1:" + f.encrypt(plain.encode()).decode()


def decrypt_secret(blob: str) -> str:
    if not blob:
        return ""
    if blob.startswith("f1:"):
        f = _fernet(config.ENCRYPTION_KEY)
        if f is None:
            return ""
        try:
            return f.decrypt(blob[3:].encode()).decode()
        except InvalidToken:
            log.warning("secret decrypt fail — ENCRYPTION_KEY badla?")
            return ""
    if blob.startswith("b1:"):
        try:
            return base64.urlsafe_b64decode(blob[3:].encode()).decode()
        except Exception:
            return ""
    return blob


def new_app_id(user_id: str) -> str:
    """a_<user>_<5hex> — collision par retry."""
    base = validators.slug(user_id, 8)
    for _ in range(8):
        cand = f"{config.APP_ID_PREFIX}{base}_{secrets.token_hex(4)[:5]}"
        try:
            if not apps_col().find_one({"appId": cand}, {"_id": 1}):
                return cand
        except PyMongoError:
            return cand
    return f"{config.APP_ID_PREFIX}{base}_{secrets.token_hex(4)}"


def new_secret() -> str:
    raw = secrets.token_urlsafe(24).replace("-", "").replace("_", "")
    return config.SECRET_PREFIX + raw[:32]


# ================================================================ scopedRepo

class ScopedRepo:
    """Ek collection, ek appId. appId har query me force hota hai.

    Body me aaya appId kabhi bharosa nahi karta — sirf verified header.
    """

    def __init__(self, collection, app_id: str):
        self.col = collection
        self.app_id = app_id

    # ---- query helpers
    def _q(self, query: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        q = dict(query or {})
        q.pop("appId", None)                     # client ka appId hata do
        q["appId"] = self.app_id
        return q

    def _doc(self, doc: Dict[str, Any]) -> Dict[str, Any]:
        d = dict(doc or {})
        d["appId"] = self.app_id
        d.setdefault("created_at", _now())
        return d

    # ---- reads
    def find(self, query=None, projection=None, limit: int = 100, sort=None, skip: int = 0):
        cur = self.col.find(self._q(query), projection)
        if sort:
            cur = cur.sort(sort)
        elif True:
            cur = cur.sort("_id", -1)
        if skip:
            cur = cur.skip(int(skip))
        return list(cur.limit(max(1, min(int(limit), 500))))

    def find_one(self, query=None, projection=None):
        return self.col.find_one(self._q(query), projection)

    def count(self, query=None) -> int:
        return int(self.col.count_documents(self._q(query)))

    # ---- writes
    def insert(self, doc: Dict[str, Any]):
        try:
            return self.col.insert_one(self._doc(doc)).inserted_id
        except DuplicateKeyError:
            raise BuilderError("duplicate row", 409, "duplicate")

    def insert_many(self, docs: Iterable[Dict[str, Any]]):
        items = [self._doc(d) for d in docs]
        if not items:
            return []
        try:
            return self.col.insert_many(items).inserted_ids
        except DuplicateKeyError:
            raise BuilderError("duplicate row", 409, "duplicate")

    def update_one(self, query, update, upsert: bool = False):
        return self.col.update_one(self._q(query), update, upsert=upsert)

    def update_many(self, query, update):
        return self.col.update_many(self._q(query), update)

    def delete_one(self, query):
        return self.col.delete_one(self._q(query))

    def delete_many(self, query=None):
        return self.col.delete_many(self._q(query))


def repo_for(collection_name: str, app_id: str) -> ScopedRepo:
    return ScopedRepo(_db().db[collection_name], app_id)


# ============================================================= signedRequest

_seen_sig: Dict[str, float] = {}


def _canonical_v1(body: bytes, ts: str) -> bytes:
    """Spec format: HMAC(secret, body + timestamp)."""
    return (body or b"") + str(ts).encode()


def _canonical_v2(method: str, path: str, ts: str, body: bytes) -> bytes:
    """Stronger format — body ka sha256 use hota hai, large body aasan."""
    return b"\n".join([
        method.upper().encode(),
        path.encode(),
        str(ts).encode(),
        hashlib.sha256(body or b"").hexdigest().encode(),
    ])


def sign_request(secret: str, body: bytes, ts: Optional[int] = None,
                 method: str = "POST", path: str = "/", version: int = None) -> Dict[str, str]:
    """Client side helper (test aur docs ke liye)."""
    version = int(version or config.SIGNATURE_VERSION)
    ts = int(ts or time.time())
    payload = _canonical_v1(body, ts) if version == 1 else _canonical_v2(method, path, ts, body)
    sig = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return {"X-Timestamp": str(ts), "X-Signature": sig, "X-Signature-Version": str(version)}


def _prune_nonces(now: float) -> None:
    if len(_seen_sig) < 50_000:
        return
    cutoff = now - (config.SIGNED_WINDOW_SECONDS * 2)
    for k, v in list(_seen_sig.items()):
        if v < cutoff:
            _seen_sig.pop(k, None)


def _check_replay(app_id: str, ts: int, sig: str) -> None:
    if not config.ENFORCE_REPLAY_GUARD:
        return
    key = f"{app_id}|{ts}|{sig}"
    now = time.time()
    if key in _seen_sig:
        raise AuthError("replay detected (same signature dobara)", 401, "replay")
    _seen_sig[key] = now
    _prune_nonces(now)


def get_app_by_id(app_id: str) -> Optional[dict]:
    try:
        return apps_col().find_one({"appId": app_id, "deleted": {"$ne": True}})
    except PyMongoError:
        return None


def app_secret(app: dict) -> str:
    return decrypt_secret(app.get("secret_enc") or "")


def verify_signed_request(headers, body: bytes, method: str = "POST",
                          path: str = "/") -> dict:
    """Signed request verify karo aur app doc return karo.

    Order of checks: header shape -> app lookup -> timestamp window -> HMAC -> replay.
    Timestamp pehle check hota hai taaki expired request par kaam na ho.
    """
    h = validators.validate_headers(headers)

    app = get_app_by_id(h["appId"])
    if not app:
        raise AuthError("unknown appId", 401, "unknown_app")

    ts = validators.validate_ts_unit(h["ts"])
    now = int(time.time())
    drift = abs(now - ts)
    if drift > config.SIGNED_WINDOW_SECONDS:
        raise AuthError(
            f"timestamp window se bahar ({drift}s, max {config.SIGNED_WINDOW_SECONDS}s)",
            401, "stale_timestamp",
        )

    secret = app_secret(app)
    if not secret:
        raise AuthError("app secret decrypt nahi hua", 500, "secret_broken")

    version = 1
    raw_ver = (headers.get("X-Signature-Version") or headers.get("x-signature-version") or "").strip()
    if raw_ver.isdigit():
        version = int(raw_ver)

    if version == 2:
        payload = _canonical_v2(method, path, h["ts"], body)
    else:
        payload = _canonical_v1(body, h["ts"])

    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected, h["sig"]):
        raise AuthError("signature mismatch", 401, "bad_signature")

    _check_replay(app["appId"], ts, h["sig"])

    return app


# ================================================================== apps CRUD

def app_public(doc: dict, reveal_secret: bool = False) -> dict:
    if not doc:
        return {}
    out = {
        "appId": doc.get("appId"),
        "name": doc.get("name"),
        "package": doc.get("package"),
        "secret_last4": doc.get("secret_last4") or "",
        "secret_version": int(doc.get("secret_version") or 1),
        "secret_rotated_at": _iso(doc.get("secret_rotated_at")),
        "created_at": _iso(doc.get("created_at")),
        "updated_at": _iso(doc.get("updated_at")),
        "builds_total": int(doc.get("builds_total") or 0),
        "last_build_at": _iso(doc.get("last_build_at")),
    }
    if reveal_secret:
        out["secret"] = app_secret(doc)
    return out


def _iso(v):
    if isinstance(v, datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat()
    return v


def create_app(user_id: str, name: str) -> dict:
    clean = validators.clean_app_name(name)
    app_id = new_app_id(user_id)
    secret = new_secret()
    now = _now()

    doc = {
        "appId": app_id,
        "userId": user_id,
        "name": clean,
        "package": validators.package_for(app_id, user_id),
        "secret_enc": encrypt_secret(secret),
        "secret_last4": secret[-4:],
        "secret_version": 1,
        "secret_rotated_at": now,
        "created_at": now,
        "updated_at": now,
        "deleted": False,
        "builds_total": 0,
        "last_build_at": None,
    }

    try:
        apps_col().insert_one(doc)
    except DuplicateKeyError:
        raise BuilderError("appId collision — dobara try karo", 409, "collision")

    doc["_plain_secret"] = secret        # sirf create ke response me
    return doc


def list_apps(user_id: str, limit: int = 100) -> List[dict]:
    try:
        return list(
            apps_col()
            .find({"userId": user_id, "deleted": {"$ne": True}})
            .sort("_id", -1)
            .limit(max(1, min(limit, 300)))
        )
    except PyMongoError:
        return []


def get_app(user_id: str, app_id: str) -> dict:
    a = validators.validate_app_id(app_id)
    doc = get_app_by_id(a)
    if not doc:
        raise BuilderError("app nahi mila", 404, "not_found")
    if doc.get("userId") != user_id:
        raise BuilderError("ye app tumhara nahi hai", 403, "forbidden")
    return doc


def rotate_secret(user_id: str, app_id: str) -> dict:
    doc = get_app(user_id, app_id)
    secret = new_secret()
    now = _now()

    apps_col().update_one(
        {"_id": doc["_id"]},
        {"$set": {
            "secret_enc": encrypt_secret(secret),
            "secret_last4": secret[-4:],
            "secret_rotated_at": now,
            "updated_at": now,
        }, "$inc": {"secret_version": 1}},
    )

    doc["secret_enc"] = encrypt_secret(secret)
    doc["secret_last4"] = secret[-4:]
    doc["secret_version"] = int(doc.get("secret_version") or 1) + 1
    doc["_plain_secret"] = secret
    return doc


def rename_app(user_id: str, app_id: str, name: str) -> dict:
    doc = get_app(user_id, app_id)
    clean = validators.clean_app_name(name)
    apps_col().update_one(
        {"_id": doc["_id"]}, {"$set": {"name": clean, "updated_at": _now()}}
    )
    doc["name"] = clean
    return doc


def delete_app(user_id: str, app_id: str) -> None:
    doc = get_app(user_id, app_id)
    now = _now()
    apps_col().update_one(
        {"_id": doc["_id"]}, {"$set": {"deleted": True, "deleted_at": now}}
    )
    try:
        orders_col().delete_many({"appId": doc["appId"]})
        build_events_col().delete_many({"appId": doc["appId"]})
    except PyMongoError:
        pass


# =================================================================== builds

ACTIVE_STATUSES = ("queued", "running")


def _today_start() -> datetime:
    now = _now()
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def quota_state(user_id: str) -> dict:
    limit = config.DAILY_BUILD_QUOTA
    try:
        used = builds_col().count_documents(
            {"userId": user_id, "created_at": {"$gte": _today_start()}}
        )
    except PyMongoError:
        used = 0
    return {
        "used_today": used,
        "daily_limit": limit,
        "remaining": max(0, limit - used) if limit else None,
        "unlimited": limit == 0,
    }


def build_public(doc: dict, include_log: bool = False) -> dict:
    if not doc:
        return {}
    out = {
        "buildId": doc.get("buildId"),
        "appId": doc.get("appId"),
        "appName": doc.get("appName"),
        "status": doc.get("status"),
        "variant": doc.get("variant"),
        "versionCode": doc.get("versionCode"),
        "versionName": doc.get("versionName"),
        "queued_at": _iso(doc.get("queued_at")),
        "started_at": _iso(doc.get("started_at")),
        "finished_at": _iso(doc.get("finished_at")),
        "duration_ms": doc.get("duration_ms"),
        "apk_size": doc.get("apk_size"),
        "apk_sha256": doc.get("apk_sha256"),
        "signed": bool(doc.get("signed")),
        "error": doc.get("error"),
        "created_at": _iso(doc.get("created_at")),
        "download_ready": doc.get("status") == "success" and bool(doc.get("apk_path")),
    }
    if include_log:
        out["log_tail"] = doc.get("log_tail") or []
    return out


def create_build(user_id: str, app_id: str, options: Optional[dict] = None,
                 force: bool = False) -> dict:
    app = get_app(user_id, app_id)
    opts = validators.validate_build_options(options)

    q = quota_state(user_id)
    if not q["unlimited"] and q["remaining"] == 0:
        raise BuilderError(
            f"aaj ki build quota khatam ({q['used_today']}/{q['daily_limit']})",
            429, "quota_exceeded",
        )

    if not force:
        active = builds_col().find_one(
            {"appId": app["appId"], "status": {"$in": list(ACTIVE_STATUSES)}},
            {"buildId": 1, "status": 1},
        )
        if active and builds_col().count_documents(
            {"appId": app["appId"], "status": {"$in": list(ACTIVE_STATUSES)}}
        ) >= config.MAX_ACTIVE_BUILDS_PER_APP:
            return active

    build_id = f"b_{next_seq('build_seq')}"
    now = _now()

    doc = {
        "buildId": build_id,
        "userId": user_id,
        "appId": app["appId"],
        "appName": app.get("name"),
        "status": "queued",
        "variant": opts["variant"],
        "versionCode": opts["versionCode"],
        "versionName": opts["versionName"],
        "baseUrl": opts["baseUrl"],
        "queued_at": now,
        "started_at": None,
        "finished_at": None,
        "duration_ms": None,
        "apk_path": None,
        "apk_size": None,
        "apk_sha256": None,
        "signed": False,
        "error": None,
        "log_tail": [],
        "attempts": 0,
        "created_at": now,
        "updated_at": now,
    }

    builds_col().insert_one(doc)

    apps_col().update_one(
        {"_id": app["_id"]},
        {"$inc": {"builds_total": 1}, "$set": {"last_build_at": now}},
    )

    add_build_event(build_id, app["appId"], user_id, "info", "build queued")
    return doc


def get_build(user_id: str, build_id: str, allow_any: bool = False) -> dict:
    b = validators.validate_build_id(build_id)
    doc = builds_col().find_one({"buildId": b})
    if not doc:
        raise BuilderError("build nahi mila", 404, "not_found")
    if not allow_any and doc.get("userId") != user_id:
        raise BuilderError("ye build tumhara nahi hai", 403, "forbidden")
    return doc


def list_builds(user_id: str, app_id: Optional[str] = None,
                limit: int = 50) -> List[dict]:
    q: Dict[str, Any] = {"userId": user_id}
    if app_id:
        q["appId"] = validators.validate_app_id(app_id)
    try:
        return list(builds_col().find(q).sort("_id", -1).limit(max(1, min(limit, 200))))
    except PyMongoError:
        return []


def add_build_event(build_id: str, app_id: str, user_id: str,
                    level: str, message: str) -> None:
    try:
        build_events_col().insert_one({
            "buildId": build_id,
            "appId": app_id,
            "userId": user_id,
            "level": level,
            "message": str(message)[:500],
            "created_at": _now(),
        })
    except PyMongoError:
        pass


def mark_canceled(user_id: str, build_id: str) -> dict:
    doc = get_build(user_id, build_id)
    if doc.get("status") not in ACTIVE_STATUSES:
        return doc
    builds_col().update_one(
        {"_id": doc["_id"]},
        {"$set": {"status": "canceled", "canceled_at": _now(), "updated_at": _now()}},
    )
    doc["status"] = "canceled"
    add_build_event(build_id, doc["appId"], user_id, "warn", "build canceled by user")
    return doc