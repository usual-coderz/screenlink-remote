"""MongoDB layer — collections, conflict-safe indexes, boot-time backfill.

Do cheezein yahan important hain:

  1. Index creation kabhi boot na tode. Conflicting index mile to drop karke
     naye options ke saath dobara banao, aur agar unique lagna hi possible na
     ho to non-unique par gir jao (index na hone se better hai).
  2. TTL hamesha BSON date par lage, epoch number par nahi — warna TTL
     chalta hi nahi.

APK builder ke liye alag collections hain (apps/builds/build_events/orders/
app_nonces). appId in sab me pehla key hai, kyunki har query app-scoped hai.
"""
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

# growth feed retention (0 = TTL off, sirf app-side prune loop chalega)
EVENT_RETENTION_DAYS = _int_env("EVENT_RETENTION_DAYS", 180)

# builder: signed-request replay guard ki durability window
NONCE_TTL_SECONDS = _int_env("APK_NONCE_TTL", 900)

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

# ---- growth / install tracking ----
device_events = db["device_events"]
install_fingerprints = db["install_fingerprints"]

# ---- APK builder (multi-tenant) ----
apps = db["apps"]
builds = db["builds"]
build_events = db["build_events"]
orders = db["orders"]
app_nonces = db["app_nonces"]


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


def _all_index_names_for(collection, keys):
    """Isi key-pattern ke saare indexes (naam wapas) — conflict cleanup ke liye."""
    want = _norm_keys(keys)
    names = []
    try:
        for info in collection.list_indexes():
            name = info.get("name") or ""
            if name == "_id_":
                continue
            if dict(info.get("key") or {}) == want:
                names.append(name)
    except Exception:
        pass
    return names


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

    Teen level ka fallback:
      1. as-is try
      2. conflict (85/86) -> purana conflicting index drop karke dobara
      3. unique bhi na lage (duplicates hain) -> non-unique par gir jao
      4. last resort -> plain index, warna index ke bina chhod do
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
    relaxed = {k: v for k, v in options.items()
               if k not in ("unique", "partialFilterExpression", "background")}
    relaxed["background"] = INDEX_BACKGROUND

    for name in _all_index_names_for(collection, keys):
        _drop(collection, name)

    try:
        collection.create_index(keys, **relaxed)
        return
    except OperationFailure as e:
        if e.code not in (85, 86):
            raise

    # last resort: bina kisi option ke plain index
    for name in _all_index_names_for(collection, keys):
        _drop(collection, name)
    try:
        collection.create_index(keys, background=INDEX_BACKGROUND)
    except Exception:
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

    # ---- growth: install identity + state lookups
    _ensure_index(
        devices, "android_id",
        partialFilterExpression={"android_id": {"$type": "string"}},
    )
    _ensure_index(
        devices, "install_id",
        partialFilterExpression={"install_id": {"$type": "string"}},
    )
    # reinstall detect: android_id par purane installs dhoondhna padta hai
    _ensure_index(devices, [("android_id", 1), ("install_id", 1)])
    _ensure_index(devices, [("install_state", 1), ("last_seen", DESCENDING)])
    _ensure_index(devices, [("install_seq", DESCENDING)])
    _ensure_index(devices, [("first_seen", DESCENDING)])

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
    _ensure_index(messages, [("status", 1), ("updated_at", DESCENDING)])
    _ensure_index(messages, [("sim_slot", 1), ("created_at", DESCENDING)])
    _ensure_ttl(messages, "created_at", RETENTION_DAYS * 86400, DESCENDING)

    # ------------------------------------------------------------- outbox
    _ensure_index(outbox, [("status", 1), ("created_at", ASCENDING)])
    _ensure_index(outbox, [("device_id", 1), ("status", 1)])
    _ensure_index(outbox, [("status", 1), ("pushed_at", 1)])
    # stuck-queued recovery: repush_stale status+updated_at par query karta hai
    _ensure_index(outbox, [("status", 1), ("updated_at", ASCENDING)])
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

    # ------------------------------------------------------- device events
    # feed naye-se-puraane padha jaata hai
    _ensure_index(device_events, [("ts", DESCENDING)])
    _ensure_index(device_events, [("created_at", DESCENDING)])
    _ensure_index(device_events, [("event", 1), ("ts", DESCENDING)])
    _ensure_index(device_events, [("device_id", 1), ("ts", DESCENDING)])
    _ensure_index(
        device_events, "install_id",
        partialFilterExpression={"install_id": {"$type": "string"}},
    )
    if EVENT_RETENTION_DAYS > 0:
        # app.py ka prune_events_loop count-bound rakhta hai, ye time-bound.
        _ensure_ttl(device_events, "created_at", EVENT_RETENTION_DAYS * 86400, DESCENDING)

    # -------------------------------------------------- install fingerprints
    # ek phone = ek doc. install_count badhta jaata hai (reinstall churn signal).
    _ensure_index(
        install_fingerprints, "android_id",
        unique=True,
        partialFilterExpression={"android_id": {"$type": "string"}},
    )
    _ensure_index(install_fingerprints, [("install_count", DESCENDING)])
    _ensure_index(install_fingerprints, [("last_seen", DESCENDING)])

    # ------------------------------------------------------------ counters
    # _id hi kaafi hai (find_one_and_update {"_id": "device_seq"}), extra index nahi.

    # =====================================================================
    #  APK BUILDER — isolation ka data layer
    # =====================================================================

    # ---------------------------------------------------------------- apps
    # appId globally unique. Yeh line poori isolation ki neev hai: ek appId
    # sirf ek user ka ho sakta hai, isliye signed request verify hone ke baad
    # appId hi tenant key ban jaata hai.
    _ensure_index(
        apps, "appId",
        unique=True,
        partialFilterExpression={"appId": {"$type": "string"}},
    )
    _ensure_index(apps, [("userId", 1), ("_id", DESCENDING)])
    _ensure_index(apps, [("userId", 1), ("deleted", 1)])
    _ensure_index(apps, [("package", 1)])

    # -------------------------------------------------------------- builds
    _ensure_index(
        builds, "buildId",
        unique=True,
        partialFilterExpression={"buildId": {"$type": "string"}},
    )
    _ensure_index(builds, [("userId", 1), ("_id", DESCENDING)])
    _ensure_index(builds, [("appId", 1), ("_id", DESCENDING)])
    _ensure_index(builds, [("appId", 1), ("status", 1)])
    # queue poller: sabse purana queued pehle
    _ensure_index(builds, [("status", 1), ("_id", ASCENDING)])
    # stuck-running recovery
    _ensure_index(builds, [("status", 1), ("updated_at", ASCENDING)])
    _ensure_index(builds, [("userId", 1), ("created_at", DESCENDING)])

    # --------------------------------------------------------- build_events
    _ensure_index(build_events, [("buildId", 1), ("_id", DESCENDING)])
    _ensure_index(build_events, [("appId", 1), ("_id", DESCENDING)])
    _ensure_ttl(build_events, "created_at", LOG_RETENTION_DAYS * 86400, DESCENDING)

    # --------------------------------------------------------------- orders
    # scopedRepo har query me appId pehla key lagata hai.
    _ensure_index(orders, [("appId", 1), ("_id", DESCENDING)])
    _ensure_index(orders, [("appId", 1), ("created_at", DESCENDING)])
    _ensure_index(
        orders, [("appId", 1), ("ref", 1)],
        partialFilterExpression={"ref": {"$type": "string"}},
    )

    # -------------------------------------------------------------- nonces
    # Replay guard ka durable hissa. Process restart par bhi signature dobara
    # use nahi ho sakta.
    _ensure_ttl(app_nonces, "created_at", NONCE_TTL_SECONDS, ASCENDING)
    _ensure_index(app_nonces, [("appId", 1), ("sig", 1), ("ts", 1)], unique=True)
    _ensure_index(app_nonces, [("expires_at", 1)])

    _backfill_growth()


# ------------------------------------------------------------ growth backfill


def _backfill_growth():
    """Purane devices ko naye growth fields ke saath align karo.

    Ek baar chalta hai (idempotent), aur kabhi bhi boot na tode — har step
    apne try/except me hai.
    """
    # 1) devices: missing fields
    try:
        devices.update_many(
            {"first_seen": {"$exists": False}},
            [{"$set": {
                "first_seen": {"$ifNull": ["$created_at", "$$NOW"]},
                "installed_at": {"$ifNull": ["$created_at", "$$NOW"]},
            }}],
        )
    except PyMongoError:
        log.warning("growth backfill: devices.first_seen skip", exc_info=True)

    for field, value in (("install_state", "active"), ("install_seq", 1)):
        try:
            devices.update_many(
                {field: {"$exists": False}},
                {"$set": {field: value}},
            )
        except PyMongoError:
            log.warning("growth backfill: devices.%s skip", field, exc_info=True)

    # 2) install_fingerprints: purane devices se seed karo (jo already installed hain)
    try:
        pipeline = [
            {"$match": {"android_id": {"$type": "string"}}},
            {"$sort": {"_id": 1}},
            {"$group": {
                "_id": "$android_id",
                "install_count": {"$sum": 1},
                "first_seen": {"$min": {"$ifNull": ["$first_seen", "$created_at"]}},
                "last_seen": {"$max": {"$ifNull": ["$last_seen", "$created_at"]}},
                "last_install_id": {"$last": "$install_id"},
                "last_registration_id": {"$last": "$registration_id"},
            }},
        ]
        for row in devices.aggregate(pipeline, allowDiskUse=True):
            aid = row.pop("_id", None)
            if not aid:
                continue
            row["android_id"] = aid
            row["seeded_at"] = utc_now()
            try:
                install_fingerprints.update_one(
                    {"android_id": aid},
                    {"$setOnInsert": row},
                    upsert=True,
                )
            except PyMongoError:
                continue
    except PyMongoError:
        log.warning("growth backfill: fingerprints skip", exc_info=True)


def _backfill_builder():
    """Builder collections ko purane data ke saath align karo.

    Kuch bhi todne wala nahi — sirf missing fields set karta hai.
    """
    try:
        apps.update_many(
            {"secret_version": {"$exists": False}},
            {"$set": {"secret_version": 1, "deleted": False}},
        )
        apps.update_many(
            {"builds_total": {"$exists": False}},
            {"$set": {"builds_total": 0}},
        )
    except PyMongoError:
        log.warning("builder backfill: apps skip", exc_info=True)

    # restart ke baad stuck "running" builds ko queue par wapas bhejo.
    # Queue khud bhi recover() karta hai — ye belt-and-braces hai.
    try:
        builds.update_many(
            {"status": "running", "updated_at": {"$lt": utc_now().replace(tzinfo=None)}},
            {"$set": {"status": "queued", "error": "requeued after restart"}},
        )
    except PyMongoError:
        log.warning("builder backfill: builds skip", exc_info=True)


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
            _backfill_builder()
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


def builder_stats():
    """Builder ke liye halka stats — /health/builder me use hota hai."""
    out = {"apps": 0, "builds": 0, "queued": 0, "running": 0, "success": 0, "failed": 0}
    try:
        out["apps"] = apps.count_documents({"deleted": {"$ne": True}})
        out["builds"] = builds.count_documents({})
        for row in builds.aggregate([{"$group": {"_id": "$status", "n": {"$sum": 1}}}]):
            k = str(row.get("_id") or "")
            if k in out:
                out[k] = int(row.get("n") or 0)
    except PyMongoError:
        pass
    return out


def close_db():
    try:
        client.close()
    except Exception:
        pass