import os
from datetime import datetime, timezone

from pymongo import MongoClient, DESCENDING
from pymongo.errors import PyMongoError

MONGODB_URI = os.getenv("MONGODB_URI")
DB_NAME = os.getenv("DB_NAME", "tpcpanel")

if not MONGODB_URI:
    raise RuntimeError("MONGODB_URI environment variable is missing")

client = MongoClient(
    MONGODB_URI,
    serverSelectionTimeoutMS=10000,
    connectTimeoutMS=10000,
    retryWrites=True,
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


def init_db():
    client.admin.command("ping")

    devices.create_index("registration_id_hash", unique=True)
    devices.create_index("last_seen")

    messages.create_index([("device_id", 1), ("created_at", DESCENDING)])
    messages.create_index([("created_at", DESCENDING)])
    messages.create_index("kind")

    outbox.create_index([("status", 1), ("created_at", 1)])

    rules.create_index("enabled")
    bots.create_index("bound")
    tg_logs.create_index([("created_at", DESCENDING)])

    pairing_codes.create_index("code_hash", unique=True)
    pairing_codes.create_index("expires_at", expireAfterSeconds=0)

    activity_logs.create_index([("created_at", DESCENDING)])


def utc_now():
    return datetime.now(timezone.utc)


def check_database():
    try:
        client.admin.command("ping")
        return {"status": "ok", "database": DB_NAME}
    except PyMongoError:
        return {"status": "error", "database": DB_NAME}