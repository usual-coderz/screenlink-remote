import os
import time
from datetime import datetime, timezone

from pymongo import MongoClient, ASCENDING, DESCENDING
from pymongo.errors import PyMongoError, OperationFailure

MONGODB_URI = os.getenv("MONGODB_URI")
DB_NAME = os.getenv("DB_NAME", "tpcpanel")

if not MONGODB_URI:
    raise RuntimeError("MONGODB_URI environment variable is missing")


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


RETENTION_DAYS = _int_env("RETENTION_DAYS", 30)
LOG_RETENTION_DAYS = _int_env("LOG_RETENTION_DAYS", 7)
OUTBOX_RETENTION_DAYS = _int_env("OUTBOX_RETENTION_DAYS", 14)
PENDING_OUTBOX_GRACE_DAYS = _int_env("PENDING_OUTBOX_GRACE_DAYS", 45)

client = MongoClient(
    MONGODB_URI,
    serverSelectionTimeoutMS=10000,
    connectTimeoutMS=10000,
    socketTimeoutMS=20000,
    maxPoolSize=50,
    retryWrites=True,
    appname="tpc-panel",
)

db = client[DB_NAME]

devices = db["devices"]
messages = db["messages"]
outbox = db["outbox"]
rules = db["rules"]
bots = db["telegram_bots"]
tg_logs = db["telegram_logs"]
pairing_codes = db["pairing_codes"]
activity_logs = db["activity_logs"]
banned_senders = db["banned_senders"]
relay_config = db["relay_config"]
counters = db["counters"]


def _ensure_index(collection, keys, **options):
    """create_index jo conflict pe crash na kare.

    - 85 / 86 (IndexOptionsConflict / KeySpecsConflict): existing index chhodo
    - 11000 par unique: existing duplicates hain -> unique hata ke dobara try
    """
    try:
        collection.create_index(keys, **options)
        return
    except OperationFailure as e:
        if e.code in (85, 86):
            return
        if e.code == 11000:
            relaxed = {k: v for k, v in options.items()
                       if k not in ("unique", "partialFilterExpression")}
            try:
                collection.create_index(keys, **relaxed)
            except OperationFailure:
                pass
            return
        raise


def _ensure_ttl(collection, field, seconds, direction=ASCENDING, partial=None):
    """TTL index, conflict-safe.

    Same field par pehle se koi non-TTL index (ya alag options wala same-naam
    index) ho to create_index 85/86 deta hai aur TTL lag hi nahi paata. Isliye
    conflict hone par wahi index drop karke dobara banate hain.

    partial=... se partial TTL banta hai (jaise sirf pending outbox rows ke liye).
    """
    name = f"{field}_ttl"
    keys = [(field, direction)]

    opts = {"expireAfterSeconds": seconds, "name": name}
    if partial:
        opts["partialFilterExpression"] = partial

    try:
        collection.create_index(keys, **opts)
        return
    except OperationFailure as e:
        if e.code not in (85, 86):
            raise

    try:
        for info in collection.list_indexes():
            iname = info.get("name") or ""
            if iname == "_id_":
                continue
            same_keys = dict(info.get("key") or {}) == dict(keys)
            same_partial = (info.get("partialFilterExpression") or None) == (partial or None)
            if iname == name or (same_keys and same_partial):
                collection.drop_index(iname)
    except Exception:
        pass

    collection.create_index(keys, **opts)


def init_db():
    client.admin.command("ping")

    # ------------------------------------------------------------ devices
    _ensure_index(devices, "registration_id_hash", unique=True)
    # partial + unique: short_id missing/null wale docs aapas me collide na karein
    _ensure_index(
        devices, "short_id",
        unique=True,
        partialFilterExpression={"short_id": {"$type": "string"}},
    )
    _ensure_index(devices, "last_seen")
    _ensure_index(devices, "onboarded")
    _ensure_index(devices, "phone_number")
    _ensure_index(devices, [("onboarded", 1), ("onboarded_at", DESCENDING)])
    _ensure_index(devices, [("is_active", 1), ("last_seen", DESCENDING)])
    # auto sender: har channel message par ye lookup hota hai — index zaruri hai
    _ensure_index(devices, [("auto_sender.enabled", 1), ("auto_sender.channel_id", 1)])
    _ensure_index(devices, "auto_sender.channel_id")

    # ----------------------------------------------------------- messages
    # dedupe_key har inbound insert par find_one hota hai — critical index.
    # partial: outbound rows me dedupe_key hota hi nahi.
    _ensure_index(
        messages, "dedupe_key",
        unique=True,
        partialFilterExpression={"dedupe_key": {"$type": "string"}},
    )
    _ensure_index(messages, [("device_id", 1), ("created_at", DESCENDING)])
    _ensure_index(messages, [("device_id", 1), ("_id", DESCENDING)])
    _ensure_index(messages, [("kind", 1), ("created_at", DESCENDING)])
    _ensure_index(messages, [("direction", 1), ("created_at", DESCENDING)])
    _ensure_ttl(messages, "created_at", RETENTION_DAYS * 86400, DESCENDING)

    # ------------------------------------------------------------- outbox
    _ensure_index(outbox, [("status", 1), ("created_at", ASCENDING)])
    _ensure_index(outbox, [("device_id", 1), ("status", 1)])
    _ensure_index(outbox, [("status", 1), ("pushed_at", 1)])
    # acked rows sent_at par expire hote hain (sent_at pending rows me nahi hota)
    _ensure_ttl(outbox, "sent_at", OUTBOX_RETENTION_DAYS * 86400, ASCENDING)
    # pending rows sirf lambe grace ke baad — offline device ka SMS na ude
    _ensure_ttl(
        outbox, "created_at",
        PENDING_OUTBOX_GRACE_DAYS * 86400,
        ASCENDING,
        partial={"status": "pending"},
    )

    # -------------------------------------------------------- rules / bots
    _ensure_index(rules, "enabled")
    _ensure_index(rules, "created_at")
    _ensure_index(bots, "bound")
    _ensure_index(bots, "bot_id", unique=True)

    # ----------------------------------------------------- telegram logs
    _ensure_ttl(tg_logs, "created_at", LOG_RETENTION_DAYS * 86400, DESCENDING)

    # ------------------------------------------------------ activity logs
    _ensure_index(activity_logs, [("device_id", 1), ("created_at", DESCENDING)])
    _ensure_index(activity_logs, [("event_type", 1), ("created_at", DESCENDING)])
    _ensure_ttl(activity_logs, "created_at", RETENTION_DAYS * 86400, DESCENDING)

    # ------------------------------------------------------- pairing codes
    # expires_at MUST be a BSON date (na ki epoch number), warna TTL kaam nahi karega.
    _ensure_index(pairing_codes, "code_hash", unique=True)
    _ensure_ttl(pairing_codes, "expires_at", 0, ASCENDING)

    # -------------------------------------------------------------- relay
    _ensure_index(banned_senders, "address", unique=True)
    _ensure_index(relay_config, "updated_at")


def init_db_with_retry(attempts: int = 5, delay: float = 2.0):
    """Boot pe Mongo thoda late aaye (docker-compose) to app crash na ho."""
    attempts = max(1, attempts)
    last = None
    for i in range(attempts):
        try:
            init_db()
            return
        except PyMongoError as e:
            last = e
            if i < attempts - 1:
                time.sleep(delay)
    if last is not None:
        raise last


def utc_now():
    return datetime.now(timezone.utc)


def check_database():
    try:
        client.admin.command("ping")
        return {"status": "ok", "database": DB_NAME}
    except Exception as e:
        return {"status": "error", "database": DB_NAME, "detail": str(e)}


def close_db():
    try:
        client.close()
    except Exception:
        pass