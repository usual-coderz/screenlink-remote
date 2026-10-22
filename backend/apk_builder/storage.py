"""Artifact storage + signed download tokens.

APK path hamesha appId ke andar hi rehta hai, isliye path traversal
possible nahi. Download URL HMAC se signed hai aur TTL wala hai.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import shutil
import time
from pathlib import Path
from typing import Optional, Tuple

from . import config, validators


def _key() -> bytes:
    return config.URL_SIGNING_KEY.encode("utf-8")


# ------------------------------------------------------------------ paths

def app_dir(app_id: str) -> Path:
    a = validators.validate_app_id(app_id)
    d = config.STORAGE_ROOT / a
    d.mkdir(parents=True, exist_ok=True)
    return d


def build_apk_path(app_id: str, build_id: str) -> Path:
    b = validators.validate_build_id(build_id)
    return app_dir(app_id) / f"{b}.apk"


def latest_apk_path(app_id: str) -> Path:
    """Spec ke mutabiq: storage/apks/<appId>/app.apk — hamesha latest."""
    return app_dir(app_id) / "app.apk"


def apk_log_path(app_id: str, build_id: str) -> Path:
    return app_dir(app_id) / f"{build_id}.log"


def publish_apk(workspace_apk: Path, app_id: str, build_id: str) -> Tuple[Path, int, str]:
    """APK ko storage me atomically daalo + sha256 nikalo.

    Pehle .part par likh ke rename karte hain, taaki download ke dauraan
    adhoori file na mile.
    """
    dest = build_apk_path(app_id, build_id)
    tmp = dest.with_suffix(".apk.part")

    shutil.copy2(workspace_apk, tmp)
    os.replace(tmp, dest)

    size = dest.stat().st_size
    sha = sha256_file(dest)

    try:
        shutil.copy2(dest, latest_apk_path(app_id))
    except OSError:
        pass

    return dest, size, sha


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def delete_build_artifacts(app_id: str, build_id: str) -> None:
    for p in (build_apk_path(app_id, build_id), apk_log_path(app_id, build_id)):
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass


def purge_app(app_id: str) -> None:
    try:
        shutil.rmtree(app_dir(app_id), ignore_errors=True)
    except OSError:
        pass


# ---------------------------------------------------------- signed tokens

def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(raw: str) -> bytes:
    pad = "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(raw + pad)


def sign_download(build_id: str, user_id: str, ttl: Optional[int] = None) -> dict:
    """Short-lived signed token. Sirf isi token se file milegi."""
    ttl = int(ttl or config.DOWNLOAD_URL_TTL)
    exp = int(time.time()) + ttl

    payload = f"{build_id}|{user_id}|{exp}"
    sig = hmac.new(_key(), payload.encode(), hashlib.sha256).hexdigest()[:40]
    token = _b64(f"{payload}|{sig}".encode())

    return {
        "token": token,
        "expires_at": exp,
        "expires_in": ttl,
        "url": f"/api/builds/{build_id}/download?token={token}",
    }


def verify_download(token: str) -> Tuple[str, str, int]:
    """(build_id, user_id, exp) return karta hai. Galat ho to ValidationError."""
    if not token:
        raise validators.ValidationError("token missing")

    try:
        raw = _unb64(token).decode()
        build_id, user_id, exp, sig = raw.rsplit("|", 3)
    except Exception:
        raise validators.ValidationError("token corrupt hai")

    expect = hmac.new(
        _key(), f"{build_id}|{user_id}|{exp}".encode(), hashlib.sha256
    ).hexdigest()[:40]

    if not hmac.compare_digest(sig, expect):
        raise validators.ValidationError("token signature mismatch")

    exp_int = int(exp)
    if exp_int < int(time.time()):
        raise validators.ValidationError("token expire ho gaya")

    return build_id, user_id, exp_int