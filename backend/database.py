import os
import time
import logging
from datetime import datetime, timezone

from pymongo import MongoClient, ASCENDING, DESCENDING
from pymongo.errors import PyMongoError, OperationFailure, DuplicateKeyError

log = logging.getLogger("tpc.db")

MONGODB_URI = os.getenv("MONGODB_URI")
DB_NAME = os.getenv("DB_NAME", "tpcpanel")

if not MONGODB_URI:
    raise RuntimeError(
        "MONGODB_URI environment variable is missing "
        "(Heroku: heroku config:set MONGODB_URI='mongodb+srv://...')"
    )


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _bool_env(name: str, default: bool = False) -> bool:
    v = (os.getenv(name) or "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


RETENTION_DAYS = _int_env("RETENTION_DAYS", 30)
LOG_RETENTION_DAYS = _int_env("LOG_RETENTION_DAYS", 7)
OUTBOX_RETENTION_DAYS = _int_env("OUTBOX_RETENTION_DAYS", 14)
PENDING_OUTBOX_GRACE_DAYS = _int_env("PENDING_OUTBOX_GRACE_DAYS", 45)

# Index build ko boot pe blocking na kare (bade collection par kaam aata hai).
INDEX_BACKGROUND = _bool_env("MONGO_INDEX_BACKGROUND", True)

client = MongoClient(
    MONGODB_URI,
    serverSelectionTimeoutMS=10000,
    connectTimeoutMS=10000,
    socketTimeoutMS=20000,
    maxPoolSize=50,
    retryWrites=True,
    retryReads=True,
    # tz_aware=False (default) -> reads naive UTC dete hain; app.py me
    # serialize_dt() aur stale-check dono isi assumption par likhe hain.
    tz_aware=False,
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
panel_users = db["panel_users"]
panel_keys = db["panel_keys"]


# --------------------------------------------------------------- index utils


def _norm_keys(keys) -> dict:
    if isinstance(keys, str):
        return {keys: ASCENDING}
    if isinstance(keys, (list, tuple)) and keys and isinstance(keys[0], tuple):
        return {k: v for k, v in keys}
    return dict(keys)


def _find_index_name(collection, keys, partial=None):
    """Isi key-pattern ka existing index ka naam dhoondo (naam guessing ke bajaye)."""
    want = _norm_keys(keys)
    want_partial = partial or None
    try:
        for info in collection.list_indexes():
            name = info.get("name") or ""
            if name == "_id_":
                continue
            if dict(info.get("key") or {}) != want:
                continue
            have_partial = info.get("partialFilterExpression") or None
            if have_partial == want_partial:
                return name
    except Exception:
        pass
    return None


def _drop(collection, name):
    if not name or name == "_id_":
        return False
    try:
        collection.drop_index(name)
        return True
    except Exception:
        return False


def _ensure_index(collection, keys, **options):
    """create_index jo conflict pe crash na kare AUR options actually laga de.

    Pehle sirf `return` karta tha — matlab existing non-unique index par
    unique=True kabhi apply hi nahi hota tha. Ab conflict par purana index
    drop karke naye options ke saath dobara banate hain.
    """
    if INDEX_BACKGROUND:
        options.setdefault("background", True)

    try:
        collection.create_index(keys, **options)
        return
    except OperationFailure as e:
        if e.code not in (85, 86):          # 85=OptionsConflict, 86=KeySpecsConflict
            raise
        _drop(collection, _find_index_name(collection, keys,
                                           options.get("partialFilterExpression")))
        try:
            collection.create_index(keys, **options)
            return
        except OperationFailure:
            pass
    except DuplicateKeyError:
        pass

    # 11000 / unique fail: existing duplicates hain -> unique hata ke try karo.
    # Pehle purana index drop, warna options change hone par phir 85/86 milega.
    relaxed = {k: v for k, v in options.items()
               if k not in ("unique", "partialFilterExpression", "background")}
    relaxed["background"] = INDEX_BACKGROUND

    _drop(collection, _find_index_name(collection, keys,
                                       options.get("partialFilterExpression")))
    try:
        collection.create_index(keys, **relaxed)
    except OperationFailure as e:
        if e.code not in (85, 86):
            raise
        _drop(collection, _find_index_name(collection, keys))
        try:
            collection.create_index(keys, **relaxed)
        except OperationFailure:
            log.warning("index skip: %s %s", collection.name, keys)


def _ensure_ttl(collection, field, seconds, direction=ASCENDING, partial=None):
    """TTL index, conflict-safe.

    Same field par pehle se koi non-TTL index (ya alag options wala same-naam
    index) ho to create_index 85/86 deta hai aur TTL lag hi nahi paata. Isliye
    conflict hone par wahi index drop karke dobara banate hain.

    partial=... se partial TTL banta hai (jaise sirf pending outbox rows ke liye).
    """
    name = f"{field}_ttl"
    keys = [(field, direction)]

    opts = {"expireAfterSeconds": int(seconds), "name": name}
    if partial:
        opts["partialFilterExpression"] = partial

    try:
        collection.create_index(keys, **opts)
        return
    except OperationFailure as e:
        if e.code not in (85, 86):
            raise

    # Jitne bhi is field ke single-key index hain (naam ya partial mismatch) hata do,
    # warna naya create phir conflict dega.
    want = _norm_keys(keys)
    try:
        for info in collection.list_indexes():
            iname = info.get("name") or ""
            if iname == "_id_":
                continue
            if iname == name or dict(info.get("key") or {}) == want:
                _drop(collection, iname)
    except Exception:
        pass

    try:
        collection.create_index(keys, **opts)
    except OperationFailure as e:
        if e.code in (85, 86):
            _drop(collection, name)
            try:
                collection.create_index(keys, **opts)
            except OperationFailure:
                log.warning("ttl skip: %s.%s", collection.name, field)
        else:
            raise


# ------------------------------------------------------------------ init


def init_db():
    client.admin.command("ping")

    # ------------------------------------------------------------ devices
    # partial+unique: legacy docs jinme field hi nahi hai, wo aapas me
    # null-collide na karein (non-sparse unique me sirf EK null doc chalta hai).
    _ensure_index(
        devices, "registration_id_hash",
        unique=True,
        partialFilterExpression={"registration_id_hash": {"$type": "string"}},
    )
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
    _ensure_index(
        bots, "bot_id",
        unique=True,
        partialFilterExpression={"bot_id": {"$type": "string"}},
    )

    # ----------------------------------------------------- telegram logs
    _ensure_index(tg_logs, "created_at")
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

    # ------------------------------------------------------------ counters
    # _id hi kaafi hai (find_one_and_update {"_id": "device_seq"}), extra index nahi.


def init_db_with_retry(attempts: int = 5, delay: float = 2.0):
    """Boot pe Mongo thoda late aaye (docker-compose) to app crash na ho.

    Sirf PyMongoError nahi — koi bhi boot-time index error retry ho,
    aur last error hi raise ho taaki traceback saaf rahe.
    """
    attempts = max(1, attempts)
    last: Exception | None = None

    for i in range(attempts):
        try:
            init_db()
            if i:
                log.info("Mongo connect ho gaya (attempt %d/%d)", i + 1, attempts)
            return
        except Exception as e:  # noqa: BLE001 — boot robustness
            last = e
            log.warning("init_db attempt %d/%d fail: %s", i + 1, attempts, e)
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