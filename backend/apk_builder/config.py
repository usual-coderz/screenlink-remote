"""APK builder — saari settings ek jagah.

Koi bhi module os.getenv seedha na kare, sirf config import kare.
Isse test karna aur deploy karna dono aasan rehta hai.
"""
from __future__ import annotations

import os
from pathlib import Path


def _str_env(name: str, default: str = "") -> str:
    v = os.getenv(name)
    return v if v not in (None, "") else default


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


# --------------------------------------------------------------------- paths

# backend/apk_builder/config.py -> parents[2] == project root
BASE_DIR = Path(__file__).resolve().parents[2]

TEMPLATE_DIR = Path(_str_env("APK_TEMPLATE_DIR", str(BASE_DIR)))
BUILD_ROOT = Path(_str_env("APK_BUILD_ROOT", "/tmp/tpc_builds"))
STORAGE_ROOT = Path(_str_env("APK_STORAGE_ROOT", str(BASE_DIR / "storage" / "apks")))
KEYSTORE_DIR = Path(_str_env("APK_KEYSTORE_DIR", str(BASE_DIR / "worker" / "keystores")))
LOG_DIR = Path(_str_env("APK_LOG_DIR", str(BUILD_ROOT / "logs")))

# template se ye cheezein copy nahi hoti
COPY_IGNORE = (
    ".git", ".github", ".gradle", "build", "storage", "__pycache__",
    ".idea", ".vscode", "node_modules", "worker",
)

# ------------------------------------------------------------------- gradle

DEFAULT_VARIANT = _str_env("APK_BUILD_VARIANT", "release").lower()
GRADLE_BIN = _str_env("APK_GRADLE_BIN", "gradle")
GRADLE_ARGS = tuple(
    a for a in _str_env(
        "APK_GRADLE_ARGS",
        "--no-daemon --console=plain --stacktrace",
    ).split(" ") if a
)
GRADLE_TIMEOUT = _int_env("APK_GRADLE_TIMEOUT", 2400)      # seconds
GRADLE_MEM = _str_env("APK_GRADLE_MEM", "1536m")

# docker me build karna ho to (host par gradle/sdk na ho)
USE_DOCKER = _bool_env("APK_USE_DOCKER", False)
DOCKER_BIN = _str_env("APK_DOCKER_BIN", "docker")
DOCKER_IMAGE = _str_env("APK_DOCKER_IMAGE", "ghcr.io/cirruslabs/android-sdk:35")

# ---------------------------------------------------------------- toolchain

ZIPALIGN_BIN = _str_env("APK_ZIPALIGN_BIN", "zipalign")
APKSIGNER_BIN = _str_env("APK_APKSIGNER_BIN", "apksigner")
KEYTOOL_BIN = _str_env("APK_KEYTOOL_BIN", "keytool")

KEYSTORE_ALIAS = _str_env("APK_KEYSTORE_ALIAS", "app")
KEYSTORE_VALIDITY_DAYS = _int_env("APK_KEYSTORE_VALIDITY_DAYS", 10950)   # ~30y
REQUIRE_SIGNATURE = _bool_env("APK_REQUIRE_SIGNATURE", True)

# ------------------------------------------------------------------- queue

MAX_CONCURRENT_BUILDS = max(1, _int_env("APK_MAX_CONCURRENT_BUILDS", 1))
QUEUE_MAXSIZE = max(10, _int_env("APK_QUEUE_MAXSIZE", 500))
WORKER_MODE = _str_env("APK_WORKER_MODE", "inline").lower()   # inline | poll
POLL_INTERVAL = _int_env("APK_POLL_INTERVAL", 5)

# ------------------------------------------------------------------ quotas

DAILY_BUILD_QUOTA = _int_env("APK_DAILY_BUILD_QUOTA", 20)     # 0 = unlimited
MAX_ACTIVE_BUILDS_PER_APP = _int_env("APK_MAX_ACTIVE_PER_APP", 2)
MAX_BUILD_LOG_LINES = _int_env("APK_MAX_LOG_LINES", 300)

# ------------------------------------------------------------- signing url

DOWNLOAD_URL_TTL = _int_env("APK_DOWNLOAD_TTL", 300)          # 5 minutes
SIGNED_WINDOW_SECONDS = _int_env("APK_HMAC_WINDOW", 300)
MAX_BODY_BYTES = _int_env("APK_MAX_BODY_BYTES", 1_000_000)

# ------------------------------------------------------------- app secrets

APP_ID_PREFIX = _str_env("APK_APP_ID_PREFIX", "a_")
SECRET_PREFIX = _str_env("APK_SECRET_PREFIX", "s3c_")
PACKAGE_SUFFIX = _str_env("APK_PACKAGE_SUFFIX", "tpcapp")

# Fernet key source. SESSION_SECRET se derive hota hai agar alag key na ho.
ENCRYPTION_KEY = _str_env("APP_ENCRYPTION_KEY") or _str_env("SESSION_SECRET", "tpc-dev-key")
ENCRYPTION_KEY_ID = _str_env("APP_ENCRYPTION_KEY_ID", "k1")

# download token signing key (alag rakhna better)
URL_SIGNING_KEY = _str_env("APK_URL_SIGNING_KEY") or ENCRYPTION_KEY

# --------------------------------------------------------------- app facing

# signed request ka default version. 1 = HMAC(secret, body + timestamp)
SIGNATURE_VERSION = _int_env("APK_SIGNATURE_VERSION", 1)
ENFORCE_REPLAY_GUARD = _bool_env("APK_ENFORCE_REPLAY_GUARD", True)
MAX_BODY_PREVIEW = _int_env("APK_MAX_BODY_PREVIEW", 2000)


def ensure_dirs() -> None:
    for p in (BUILD_ROOT, STORAGE_ROOT, KEYSTORE_DIR, LOG_DIR):
        p.mkdir(parents=True, exist_ok=True)