import os
import re
import asyncio
import hashlib
import logging
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from bson.errors import InvalidId
from pymongo import ASCENDING, DESCENDING
from pymongo.errors import OperationFailure, DuplicateKeyError, PyMongoError
from motor.motor_asyncio import AsyncIOMotorClient

LOG = logging.getLogger("tpc.db")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

MONGODB_URI = os.environ.get("MONGODB_URI")
if not MONGODB_URI:
    raise RuntimeError("MONGODB_URI environment variable is required")

DB_NAME = os.environ.get("DB_NAME", "tpcpanel")

RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "30") or 30)
LOG_RETENTION_DAYS = int(os.environ.get("LOG_RETENTION_DAYS", "7") or 7)
OUTBOX_RETENTION_DAYS = int(os.environ.get("OUTBOX_RETENTION_DAYS", "14") or 14)
PENDING_OUTBOX_GRACE_DAYS = int(os.environ.get("PENDING_OUTBOX_GRACE_DAYS", "45") or 45)
PAIR_CODE_TTL_SECONDS = int(os.environ.get("PAIR_CODE_TTL_SECONDS", "900") or 900)

SHORT_ID_PREFIX = "TPC-"

UPI_KEYWORDS = (
    "upi", "vpa", "debited", "credited", "paid", "received", "sent",
    "a/c", "acct", "imps", "neft", "rtgs", "txn", "ref no", "avl bal",
    "balance", "inr", "₹",
)
AMOUNT_RE = re.compile(
    r"(?:rs\.?|inr|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------
# Client / handle
# --------------------------------------------------------------------------

client = AsyncIOMotorClient(
    MONGODB_URI,
    appname="tpc-panel",
    serverSelectionTimeoutMS=15000,
    connectTimeoutMS=15000,
    socketTimeoutMS=60000,
    maxPoolSize=50,
    retryWrites=True,
    tz_aware=True,
)

db = client[DB_NAME]

devices = db["devices"]
messages = db["messages"]
outbox = db["outbox"]
rules = db["rules"]
telegram_logs = db["telegram_logs"]
pairing_codes = db["pairing_codes"]
activity_logs = db["activity_logs"]
banned_senders = db["banned_senders"]
relay_config = db["relay_config"]
counters = db["counters"]

ALL_COLLECTIONS = (
    devices, messages, outbox, rules, telegram_logs, pairing_codes,
    activity_logs, banned_senders, relay_config, counters,
)

# --------------------------------------------------------------------------
# Small utilities
# --------------------------------------------------------------------------


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(value):
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return value


def to_object_id(value):
    if value is None:
        return None
    if isinstance(value, ObjectId):
        return value
    try:
        return ObjectId(str(value))
    except (InvalidId, TypeError):
        return None


def serialize_document(doc):
    if doc is None:
        return None
    if isinstance(doc, list):
        return [serialize_document(item) for item in doc]
    if isinstance(doc, ObjectId):
        return str(doc)
    if isinstance(doc, datetime):
        return as_utc(doc).isoformat()
    if isinstance(doc, dict):
        return {key: serialize_document(val) for key, val in doc.items()}
    return doc


def _norm_keys(keys):
    if isinstance(keys, str):
        return [(keys, ASCENDING)]
    if isinstance(keys, dict):
        return list(keys.items())
    return [(k, v) for k, v in keys]


def _index_name(keys, partial=None, unique=False, ttl=False):
    base = "_".join(f"{k}_{v}" for k, v in _norm_keys(keys))
    tags = []
    if unique:
        tags.append("uniq")
    if ttl:
        tags.append("ttl")
    if partial:
        tags.append(hashlib.md5(repr(sorted(partial.items())).encode()).hexdigest()[:8])
    return "_".join([base] + tags) if tags else base


# --------------------------------------------------------------------------
# Index helpers
# --------------------------------------------------------------------------


async def _existing_indexes(collection):
    try:
        return await collection.list_indexes().to_list(length=None)
    except PyMongoError as exc:
        LOG.warning("list_indexes(%s) failed: %s", collection.name, exc)
        return []


async def _drop_conflicting(collection, keys, partial):
    """Drop any index on the same key pattern whose partial filter differs."""
    wanted_keys = _norm_keys(keys)
    for spec in await _existing_indexes(collection):
        if spec.get("name") == "_id_":
            continue
        if list(spec.get("key", {}).items()) != wanted_keys:
            continue
        if (spec.get("partialFilterExpression") or None) == (partial or None):
            continue
        try:
            await collection.drop_index(spec["name"])
            LOG.info("dropped conflicting index %s.%s", collection.name, spec["name"])
        except PyMongoError as exc:
            LOG.warning("drop_index(%s.%s) failed: %s", collection.name, spec["name"], exc)


async def _ensure_index(collection, keys, *, unique=False, partial=None, name=None):
    """Create an index, tolerating an existing conflicting index with the same keys."""
    opts = {}
    if unique:
        opts["unique"] = True
    if partial:
        opts["partialFilterExpression"] = partial
    opts["name"] = name or _index_name(keys, partial=partial, unique=unique)

    try:
        await collection.create_index(keys, **opts)
        return True
    except OperationFailure as exc:
        if exc.code in (85, 86):
            await _drop_conflicting(collection, keys, partial)
            try:
                await collection.create_index(keys, **opts)
                return True
            except PyMongoError as inner:
                LOG.warning("index %s.%s retry failed: %s", collection.name, opts["name"], inner)
                return False
        LOG.warning("index %s.%s failed: %s", collection.name, opts["name"], exc)
        return False
    except DuplicateKeyError:
        LOG.warning(
            "index %s.%s hit duplicate data; falling back to non-unique",
            collection.name, opts["name"],
        )
        opts.pop("unique", None)
        try:
            await collection.create_index(keys, **opts)
            return True
        except PyMongoError as exc:
            LOG.warning("index %s.%s fallback failed: %s", collection.name, opts["name"], exc)
            return False


async def _ensure_ttl(collection, key, seconds, *, partial=None, name=None):
    """Create a TTL index. Supports a partial filter so only a subset expires."""
    seconds = int(seconds)
    opts = {"expireAfterSeconds": seconds}
    if partial:
        opts["partialFilterExpression"] = partial
    opts["name"] = name or _index_name(key, partial=partial, ttl=True)

    try:
        await collection.create_index([(key, ASCENDING)], **opts)
        return True
    except OperationFailure as exc:
        if exc.code in (85, 86):
            await _drop_conflicting(collection, [(key, ASCENDING)], partial)
            try:
                await collection.create_index([(key, ASCENDING)], **opts)
                return True
            except PyMongoError as inner:
                LOG.warning("ttl %s.%s retry failed: %s", collection.name, opts["name"], inner)
                return False
        LOG.warning("ttl %s.%s failed: %s", collection.name, opts["name"], exc)
        return False


# --------------------------------------------------------------------------
# Bootstrap
# --------------------------------------------------------------------------


async def init_db():
    """Idempotent schema + index bootstrap. Safe to call on every boot."""
    await client.admin.command("ping")
    LOG.info("connected to mongo db=%s", DB_NAME)

    # ---------------- devices ----------------
    await _ensure_index(devices, [("registration_id", ASCENDING)], unique=True)
    await _ensure_index(
        devices, [("short_id", ASCENDING)],
        unique=True, partial={"short_id": {"$type": "string"}},
    )
    await _ensure_index(devices, [("phone_number", ASCENDING)])
    await _ensure_index(devices, [("last_seen", DESCENDING)])
    await _ensure_index(devices, [("online", ASCENDING), ("last_seen", DESCENDING)])
    await _ensure_index(devices, [("banned", ASCENDING)])
    # relay auto-sender lookup: find({'auto_sender.enabled': True, 'auto_sender.channel_id': key})
    await _ensure_index(devices, [("auto_sender.enabled", ASCENDING), ("auto_sender.channel_id", ASCENDING)])
    await _ensure_index(devices, [("auto_sender.channel_id", ASCENDING)])
    await _ensure_index(devices, [("owner_id", ASCENDING)])

    # ---------------- messages ----------------
    await _ensure_index(messages, [("device_id", ASCENDING), ("_id", DESCENDING)])
    await _ensure_index(messages, [("created_at", DESCENDING)])
    await _ensure_index(messages, [("direction", ASCENDING), ("created_at", DESCENDING)])
    await _ensure_index(messages, [("category", ASCENDING), ("created_at", DESCENDING)])
    await _ensure_index(messages, [("sender", ASCENDING)])
    await _ensure_index(
        messages, [("dedupe_key", ASCENDING)],
        unique=True, partial={"dedupe_key": {"$type": "string"}},
    )
    await _ensure_ttl(messages, "created_at", RETENTION_DAYS * 86400)

    # ---------------- outbox ----------------
    await _ensure_index(outbox, [("device_id", ASCENDING), ("status", ASCENDING), ("created_at", ASCENDING)])
    await _ensure_index(outbox, [("status", ASCENDING), ("created_at", ASCENDING)])
    # acked rows expire OUTBOX_RETENTION_DAYS after they were actually sent
    await _ensure_ttl(outbox, "sent_at", OUTBOX_RETENTION_DAYS * 86400)
    # pending rows get a much longer grace so an offline device still receives them
    await _ensure_ttl(
        outbox, "created_at", PENDING_OUTBOX_GRACE_DAYS * 86400,
        partial={"status": "pending"},
    )

    # ---------------- rules ----------------
    await _ensure_index(rules, [("created_at", DESCENDING)])
    await _ensure_index(rules, [("enabled", ASCENDING), ("created_at", DESCENDING)])

    # ---------------- telegram_logs ----------------
    await _ensure_index(telegram_logs, [("created_at", DESCENDING)])
    await _ensure_ttl(telegram_logs, "created_at", LOG_RETENTION_DAYS * 86400)

    # ---------------- pairing_codes ----------------
    await _ensure_index(pairing_codes, [("code", ASCENDING)], unique=True)
    await _ensure_ttl(pairing_codes, "created_at", PAIR_CODE_TTL_SECONDS)

    # ---------------- activity_logs ----------------
    await _ensure_index(activity_logs, [("created_at", DESCENDING)])
    await _ensure_index(activity_logs, [("kind", ASCENDING), ("created_at", DESCENDING)])
    await _ensure_ttl(activity_logs, "created_at", RETENTION_DAYS * 86400)

    # ---------------- banned_senders ----------------
    await _ensure_index(banned_senders, [("sender", ASCENDING)], unique=True)

    # ---------------- relay_config ----------------
    await _ensure_index(relay_config, [("updated_at", DESCENDING)])

    # ---------------- counters ----------------
    await _ensure_index(counters, [("_id", ASCENDING)])

    LOG.info("schema bootstrap complete")
    return True


async def init_db_with_retry(attempts: int = 5, delay: float = 2.0):
    attempts = max(1, int(attempts or 1))
    last = None
    for i in range(attempts):
        try:
            await init_db()
            return True
        except Exception as exc:  # noqa: BLE001
            last = exc
            LOG.warning("init_db attempt %s/%s failed: %s", i + 1, attempts, exc)
            if i + 1 < attempts:
                await asyncio.sleep(delay * (i + 1))
    if last is not None:
        raise last
    return False


async def ping() -> bool:
    try:
        await client.admin.command("ping")
        return True
    except PyMongoError:
        return False


async def close_db():
    try:
        client.close()
        LOG.info("mongo client closed")
    except Exception as exc:  # noqa: BLE001
        LOG.warning("close_db failed: %s", exc)


# --------------------------------------------------------------------------
# Device helpers
# --------------------------------------------------------------------------


async def next_device_short_id() -> str:
    doc = await counters.find_one_and_update(
        {"_id": "device_short_id"},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=True,
    )
    seq = int((doc or {}).get("seq", 1))
    return f"{SHORT_ID_PREFIX}{seq:04d}"


async def device_short_id(device: dict) -> str:
    if not device:
        return ""
    existing = device.get("short_id")
    if isinstance(existing, str) and existing:
        return existing
    generated = await next_device_short_id()
    if device.get("_id") is not None:
        try:
            await devices.update_one(
                {"_id": device["_id"], "short_id": {"$type": "string"}},
                {"$set": {"short_id": generated}},
            )
        except PyMongoError as exc:
            LOG.warning("short_id persist failed: %s", exc)
    device["short_id"] = generated
    return generated


def resolve_device_number(device: dict) -> str:
    if not device:
        return ""
    for key in ("phone_number", "number", "msisdn", "sim_number"):
        val = device.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def view_device(device: dict, *, include_secrets: bool = False) -> dict:
    if not device:
        return {}
    doc = serialize_document(device)
    doc["number"] = resolve_device_number(device)
    if not include_secrets:
        doc.pop("api_key", None)
        doc.pop("secret", None)
    doc.setdefault("auto_sender", {"enabled": False, "channel_id": None})
    return doc


def sanitize_telemetry(payload: dict) -> dict:
    if not isinstance(payload, dict):
        return {}
    out = {}
    for key in (
        "battery", "charging", "signal", "network", "operator",
        "sim_state", "storage_free", "storage_total", "ram_free",
        "ram_total", "uptime", "ip", "app_version", "sdk", "model",
        "manufacturer", "screen", "temperature",
    ):
        if key in payload:
            val = payload[key]
            if isinstance(val, str) and len(val) > 128:
                val = val[:128]
            out[key] = val
    return out


def telemetry_summary(device: dict) -> dict:
    telemetry = (device or {}).get("telemetry") or {}
    return {
        "battery": telemetry.get("battery"),
        "charging": telemetry.get("charging"),
        "signal": telemetry.get("signal"),
        "network": telemetry.get("network"),
        "operator": telemetry.get("operator"),
        "app_version": telemetry.get("app_version"),
        "updated_at": serialize_document(telemetry.get("updated_at")),
    }


async def apply_telemetry(device_id, payload: dict) -> dict:
    oid = to_object_id(device_id)
    if oid is None:
        return {}
    clean = sanitize_telemetry(payload)
    clean["updated_at"] = utc_now()
    update = {
        "$set": {
            "telemetry": clean,
            "last_seen": utc_now(),
            "online": True,
        }
    }
    await devices.update_one({"_id": oid}, update)
    return clean


# --------------------------------------------------------------------------
# SMS helpers
# --------------------------------------------------------------------------


def classify_sms(body: str) -> dict:
    text = (body or "").strip()
    lowered = text.lower()
    is_upi = any(kw in lowered for kw in UPI_KEYWORDS)
    match = AMOUNT_RE.search(text)
    amount = None
    if match:
        try:
            amount = float(match.group(1).replace(",", ""))
        except ValueError:
            amount = None
    return {
        "category": "upi" if is_upi else "sms",
        "is_upi": is_upi,
        "amount": amount,
    }


def make_dedupe_key(device_id, sender, body, ts) -> str:
    raw = f"{device_id}|{(sender or '').strip()}|{(body or '').strip()}|{int(ts)}"
    return hashlib.sha1(raw.encode("utf-8", "ignore")).hexdigest()


async def insert_message(doc: dict):
    """Insert an SMS row, deduped. Returns (inserted, stored_doc)."""
    payload = dict(doc or {})
    payload.setdefault("created_at", utc_now())
    payload.setdefault("direction", "in")
    payload.setdefault("read", False)

    body = payload.get("body") or ""
    if "category" not in payload:
        payload.update(classify_sms(body))

    device_id = payload.get("device_id")
    ts = as_utc(payload.get("created_at")) or utc_now()
    dedupe = payload.get("dedupe_key") or make_dedupe_key(
        device_id, payload.get("sender"), body, ts.timestamp()
    )
    payload["dedupe_key"] = dedupe

    try:
        result = await messages.insert_one(payload)
        payload["_id"] = result.inserted_id
        return True, payload
    except DuplicateKeyError:
        existing = await messages.find_one({"dedupe_key": dedupe})
        return False, existing or payload


# --------------------------------------------------------------------------
# Outbox helpers
# --------------------------------------------------------------------------


async def queue_sms(device_id, to_number: str, body: str, *, source: str = "panel") -> dict:
    oid = to_object_id(device_id)
    now = utc_now()
    doc = {
        "device_id": oid if oid is not None else device_id,
        "to": to_number,
        "body": body,
        "source": source,
        "status": "pending",
        "attempts": 0,
        "created_at": now,
        "last_pushed_at": None,
        "sent_at": None,
    }
    result = await outbox.insert_one(doc)
    doc["_id"] = result.inserted_id
    return doc


async def push_outbox(device_id, limit: int = 25):
    oid = to_object_id(device_id)
    query = {"device_id": oid if oid is not None else device_id, "status": "pending"}
    rows = (
        await outbox.find(query)
        .sort("created_at", ASCENDING)
        .limit(int(limit))
        .to_list(length=int(limit))
    )
    if not rows:
        return []
    ids = [r["_id"] for r in rows]
    await outbox.update_many(
        {"_id": {"$in": ids}},
        {"$inc": {"attempts": 1}, "$set": {"last_pushed_at": utc_now()}},
    )
    return rows


async def repush_stale(device_id, older_than_seconds: int = 300, limit: int = 25):
    cutoff = utc_now() - timedelta(seconds=int(older_than_seconds))
    oid = to_object_id(device_id)
    query = {
        "device_id": oid if oid is not None else device_id,
        "status": "pending",
        "$or": [
            {"last_pushed_at": None},
            {"last_pushed_at": {"$lt": cutoff}},
        ],
    }
    return (
        await outbox.find(query)
        .sort("created_at", ASCENDING)
        .limit(int(limit))
        .to_list(length=int(limit))
    )


async def _ack_outbox(ids):
    if not ids:
        return 0
    oids = [to_object_id(i) or i for i in ids]
    result = await outbox.update_many(
        {"_id": {"$in": oids}, "status": {"$ne": "sent"}},
        {"$set": {"status": "sent", "sent_at": utc_now()}},
    )
    return result.modified_count