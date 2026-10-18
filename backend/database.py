import os
import time
from datetime import datetime, timezone

from pymongo import MongoClient, ASCENDING, DESCENDING
from pymongo.errors import PyMongoError, OperationFailure

MONGODB_URI = os.getenv("MONGODB_URI")
DB_NAME = os.getenv("DB_NAME", "tpcpanel")

if not MONGODB_URI:
    raise RuntimeError("MONGODB_URI environment variable is missing")

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


def _ensure_index(collection, keys, **options):
    """create_index jo IndexOptionsConflict / KeySpecsConflict pe crash na kare."""
    try:
        collection.create_index(keys, **options)
    except OperationFailure as e:
        # 85 = IndexOptionsConflict, 86 = IndexKeySpecsConflict
        if e.code in (85, 86):
            return
        raise


def init_db():
    client.admin.command("ping")

    # --- devices
    _ensure_index(devices, "registration_id_hash", unique=True)
    _ensure_index(devices, "last_seen")
    _ensure_index(devices, "onboarded")
    _ensure_index(devices, [("onboarded", 1), ("onboarded_at", DESCENDING)])
    _ensure_index(devices, [("is_active", 1), ("last_seen", DESCENDING)])

    # --- messages
    _ensure_index(messages, [("device_id", 1), ("created_at", DESCENDING)])
    _ensure_index(messages, [("created_at", DESCENDING)])
    _ensure_index(messages, [("kind", 1), ("created_at", DESCENDING)])
    _ensure_index(messages, "kind")
    _ensure_index(messages, [("direction", 1), ("created_at", DESCENDING)])

    # --- outbox
    _ensure_index(outbox, [("status", 1), ("created_at", ASCENDING)])
    _ensure_index(outbox, [("device_id", 1), ("status", 1)])

    # --- rules / bots
    _ensure_index(rules, "enabled")
    _ensure_index(bots, "bound")
    _ensure_index(bots, "bot_id", unique=True)
    _ensure_index(tg_logs, [("created_at", DESCENDING)])

    # --- pairing codes  (expires_at MUST be a BSON date, not epoch number)
    _ensure_index(pairing_codes, "code_hash", unique=True)
    _ensure_index(pairing_codes, "expires_at", expireAfterSeconds=0)

    # --- activity log
    _ensure_index(activity_logs, [("created_at", DESCENDING)])
    _ensure_index(activity_logs, [("device_id", 1), ("created_at", DESCENDING)])
    _ensure_index(activity_logs, [("event_type", 1), ("created_at", DESCENDING)])


def init_db_with_retry(attempts: int = 5, delay: float = 2.0):
    """Boot pe Mongo thoda late aaye (docker-compose) to app crash na ho."""
    last = None
    for i in range(attempts):
        try:
            init_db()
            return
        except PyMongoError as e:
            last = e
            if i < attempts - 1:
                time.sleep(delay)
    raise last


def utc_now():
    return datetime.now(timezone.utc)


def check_database():
    try:
        client.admin.command("ping")
        return {"status": "ok", "database": DB_NAME}
    except Exception as e:
        return {"status": "error", "database": DB_NAME, "detail": str(e)}