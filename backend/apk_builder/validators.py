"""Input validation + safe string/xml helpers.

Yahan sab kuch strictly validate hota hai kyunki in values par
shell command aur xml file dono banti hain.
"""
from __future__ import annotations

import re
import zipfile
from pathlib import Path
from typing import Any, Dict, Optional

from . import config

# --------------------------------------------------------------- app name

_NAME_BAD = re.compile(r"[\x00-\x1f<>\"'&\\/]+")
_NAME_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._+\-()]{1,39}$")

RESERVED_NAMES = {"android", "app", "test", "debug", "release", "null"}


class ValidationError(ValueError):
    pass


def clean_app_name(raw: Any) -> str:
    """App ka display name. strings.xml me jaata hai, isliye safe rakho."""
    s = str(raw or "").strip()
    s = re.sub(r"\s+", " ", s)
    s = _NAME_BAD.sub(" ", s).strip()
    if len(s) < 2:
        raise ValidationError("App name kam se kam 2 character ka ho")
    if len(s) > 40:
        s = s[:40].rstrip()
    if not _NAME_OK.match(s):
        raise ValidationError("App name me sirf letters, digits, space, . _ - ( ) + chalte hain")
    return s


def slug(raw: Any, limit: int = 8) -> str:
    s = re.sub(r"[^a-z0-9]+", "", str(raw or "").lower())
    return (s or "user")[:limit]


# ------------------------------------------------------------------- ids

_APP_ID_RE = re.compile(r"^a_[a-z0-9]{2,12}_[a-z0-9]{4,10}$")
_BUILD_ID_RE = re.compile(r"^b_[0-9]{1,12}$")


def validate_app_id(app_id: str) -> str:
    a = str(app_id or "").strip()
    if not _APP_ID_RE.match(a):
        raise ValidationError("appId ka format galat hai")
    return a


def validate_build_id(build_id: str) -> str:
    b = str(build_id or "").strip()
    if not _BUILD_ID_RE.match(b):
        raise ValidationError("buildId ka format galat hai")
    return b


def validate_secret(secret: str) -> str:
    s = str(secret or "").strip()
    if len(s) < 20 or len(s) > 128:
        raise ValidationError("secret ki length 20-128 honi chahiye")
    if not re.match(r"^[A-Za-z0-9_\-]+$", s):
        raise ValidationError("secret me sirf [A-Za-z0-9_-] chalte hain")
    return s


# --------------------------------------------------------------- package

def package_for(app_id: str, fallback_user: str = "user") -> str:
    """appId se valid java package banao. Leading digit handle hota hai."""
    a = validate_app_id(app_id)
    _, mid, tail = a.split("_", 2)
    mid = re.sub(r"[^a-z0-9]", "", mid) or slug(fallback_user)
    tail = re.sub(r"[^a-z0-9]", "", tail) or "app"
    if mid[0].isdigit():
        mid = "x" + mid
    if tail[0].isdigit():
        tail = "x" + tail
    pkg = f"com.{config.PACKAGE_SUFFIX}.{mid}.{tail}"
    if len(pkg) > 120:
        pkg = pkg[:120].rstrip(".")
    return pkg


def validate_package(pkg: str) -> str:
    p = str(pkg or "").strip()
    if not re.match(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$", p):
        raise ValidationError("package name valid nahi hai")
    if len(p) > 120:
        raise ValidationError("package name bahut lamba hai")
    return p


# ------------------------------------------------------------------- xml

_XML_ESC = (("&", "&amp;"), ("<", "&lt;"), (">", "&gt;"), ('"', "&quot;"), ("'", "&apos;"))


def xml_escape(value: Any) -> str:
    s = str(value if value is not None else "")
    for a, b in _XML_ESC:
        s = s.replace(a, b)
    return s


# --------------------------------------------------------------- build opts

_VARIANTS = ("release", "debug")
_VERSION_NAME_RE = re.compile(r"^[0-9]{1,3}(\.[0-9]{1,3}){0,3}(-[A-Za-z0-9.]{1,12})?$")


def validate_build_options(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    raw = raw or {}
    variant = str(raw.get("variant") or config.DEFAULT_VARIANT).lower()
    if variant not in _VARIANTS:
        variant = "release"

    try:
        version_code = int(raw.get("versionCode") or raw.get("version_code") or 1)
    except (TypeError, ValueError):
        version_code = 1
    version_code = max(1, min(version_code, 2_100_000_000))

    version_name = str(raw.get("versionName") or raw.get("version_name") or "1.0").strip()
    if not _VERSION_NAME_RE.match(version_name):
        version_name = "1.0"
    version_name = version_name[:24]

    base_url = str(raw.get("baseUrl") or raw.get("base_url") or "").strip()[:200]
    if base_url and not re.match(r"^https?://[^\s]+$", base_url):
        base_url = ""
    if base_url and base_url.endswith("/"):
        base_url = base_url[:-1]

    return {
        "variant": variant,
        "versionCode": version_code,
        "versionName": version_name,
        "baseUrl": base_url,
    }


# ------------------------------------------------------------------- apk

def looks_like_apk(path: Path) -> bool:
    """APK = zip + AndroidManifest.xml. Sirf zip check kaafi nahi."""
    p = Path(path)
    if not p.is_file() or p.stat().st_size < 4096:
        return False
    try:
        with zipfile.ZipFile(p) as z:
            names = set(z.namelist())
            if "AndroidManifest.xml" not in names:
                return False
            if not any(n.startswith("classes") and n.endswith(".dex") for n in names):
                return False
    except (zipfile.BadZipFile, OSError):
        return False
    return True


# ------------------------------------------------------------- signed req

def validate_headers(headers) -> Dict[str, str]:
    """X-App-Id / X-Timestamp / X-Signature nikalo aur check karo."""
    def get(name):
        return (headers.get(name) or headers.get(name.lower()) or "").strip()

    app_id = get("X-App-Id")
    ts = get("X-Timestamp")
    sig = get("X-Signature")

    if not app_id:
        raise ValidationError("X-App-Id header missing")
    if not ts:
        raise ValidationError("X-Timestamp header missing")
    if not sig:
        raise ValidationError("X-Signature header missing")

    validate_app_id(app_id)

    try:
        ts_int = int(ts)
    except (TypeError, ValueError):
        raise ValidationError("X-Timestamp integer hona chahiye (epoch seconds)")

    if not re.match(r"^[a-fA-F0-9]{32,128}$", sig):
        raise ValidationError("X-Signature hex hona chahiye")

    return {"appId": app_id, "ts": ts_int, "sig": sig.lower()}


def validate_ts_unit(ts_int: int) -> int:
    """Milliseconds bhej diye ho to seconds me convert karo."""
    if ts_int > 10_000_000_000:
        return ts_int // 1000
    return ts_int