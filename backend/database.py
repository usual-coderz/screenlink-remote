import os
from datetime import datetime, timezone

from pymongo import MongoClient, DESCENDING
from pymongo.errors import PyMongoError

MONGODB_URI = os.getenv("MONGODB_URI")
DB_NAME = os.getenv("DB_NAME", "screenlink")

if not MONGODB_URI:
    raise RuntimeError("MONGODB_URI environment variable is missing")

client = MongoClient(
    MONGODB_URI,
    serverSelectionTimeoutMS=10000,
    connectTimeoutMS=10000,
    retryWrites=True
)

db = client[DB_NAME]

admins = db["admins"]
devices = db["devices"]
pairing_codes = db["pairing_codes"]
support_sessions = db["support_sessions"]
activity_logs = db["activity_logs"]


def init_db():
    client.admin.command("ping")

    admins.create_index("username", unique=True)
    devices.create_index("device_token_hash", unique=True, sparse=True)
    pairing_codes.create_index("code_hash", unique=True)
    pairing_codes.create_index("expires_at", expireAfterSeconds=0)
    support_sessions.create_index("status")
    activity_logs.create_index(
    [("created_at", DESCENDING)]
)


def utc_now():
    return datetime.now(timezone.utc)


def list_devices():
    return list(
        devices.find(
            {},
            {
                "_id": 0,
                "device_token_hash": 0
            }
        ).sort("_id", DESCENDING).limit(200)
    )


def list_sessions():
    return list(
        support_sessions.find(
            {},
            {"_id": 0}
        ).sort("_id", DESCENDING).limit(200)
    )


def list_recent_activity(limit=50):
    limit = max(1, min(int(limit), 200))

    return list(
        activity_logs.find(
            {},
            {"_id": 0}
        ).sort("_id", DESCENDING).limit(limit)
    )


def log_activity(
    event_type,
    details=None,
    admin_id=None,
    device_id=None
):
    document = {
        "event_type": event_type,
        "details": details,
        "admin_id": admin_id,
        "device_id": device_id,
        "created_at": utc_now()
    }

    result = activity_logs.insert_one(document)
    return str(result.inserted_id)


def check_database():
    try:
        client.admin.command("ping")
        return {
            "status": "ok",
            "database": DB_NAME
        }
    except PyMongoError:
        return {
            "status": "error",
            "database": DB_NAME
        }