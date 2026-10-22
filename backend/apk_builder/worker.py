"""Build worker — ek build ka poora lifecycle, asli mein.

Steps:
  1. workspace banao, template copy karo (git/storage chhod ke)
  2. per-app keystore banao (keytool) + keystore.properties
  3. strings.xml patch karo (app_name, api_app_id, api_secret, api_base_url)
  4. builder.properties likho (applicationId, versionCode, versionName)
  5. gradle assemble<Release|Debug> chalao, stdout stream karo
  6. zipalign + apksigner sign + verify
  7. storage me publish + sha256 + DB update + socket event
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess
import time
from collections import deque
from datetime import timezone
from pathlib import Path
from typing import Callable, Optional

from . import config, service, storage, validators

log = logging.getLogger("tpc.apk.worker")

CancelFn = Callable[[str], bool]
EmitFn = Callable[[str, dict], None]

_STR_RE = r'<string\s+name="{k}"\s*>(.*?)</string>'


# ----------------------------------------------------------------- helpers

def _now():
    return service._now()


def _set(build_id: str, **fields) -> None:
    fields["updated_at"] = _now()
    try:
        service.builds_col().update_one({"buildId": build_id}, {"$set": fields})
    except Exception:
        log.warning("build %s update fail", build_id, exc_info=True)


def _fail(build_id: str, doc: dict, message: str, emit: Optional[EmitFn]) -> None:
    _set(build_id, status="failed", error=str(message)[:2000], finished_at=_now())
    service.add_build_event(build_id, doc.get("appId"), doc.get("userId"), "error", message)
    if emit:
        emit(doc.get("userId"), {
            "type": "build",
            "data": {"buildId": build_id, "appId": doc.get("appId"),
                     "status": "failed", "error": str(message)[:300]},
        })


def _cancel_requested(build_id: str, should_cancel: Optional[CancelFn]) -> bool:
    if should_cancel and should_cancel(build_id):
        return True
    doc = service.builds_col().find_one({"buildId": build_id}, {"status": 1})
    return bool(doc and doc.get("status") == "canceled")


def _patch_strings(text: str, mapping: dict) -> str:
    """Sirf diye gaye keys replace karo. File ka baaki content safe rehta hai."""
    for key, value in mapping.items():
        esc = validators.xml_escape(value)
        pat = re.compile(_STR_RE.format(k=re.escape(key)), re.S)
        if pat.search(text):
            text = pat.sub(lambda m: f'<string name="{key}">{esc}</string>', text)
        else:
            text = text.replace(
                "</resources>",
                f'    <string name="{key}">{esc}</string>\n</resources>',
            )
    return text


def _run(cmd: list[str], cwd: Optional[Path] = None, timeout: int = 300) -> tuple[int, str]:
    try:
        p = subprocess.run(
            cmd, cwd=str(cwd) if cwd else None,
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except FileNotFoundError:
        return 127, f"{cmd[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, f"{cmd[0]}: timeout after {timeout}s"


def _which(binary: str) -> bool:
    return shutil.which(binary) is not None


# ---------------------------------------------------------------- keystore

def ensure_keystore(app_id: str, app_name: str, workspace: Path) -> dict:
    """Per-app keystore. Pehle se ho to reuse (same signing identity rehta hai)."""
    config.KEYSTORE_DIR.mkdir(parents=True, exist_ok=True)
    ks_path = config.KEYSTORE_DIR / f"{app_id}.jks"

    app = service.get_app_by_id(app_id) or {}
    stored_pw = service.decrypt_secret(app.get("keystore_pw_enc") or "")
    password = stored_pw or (app_id[-6:] + "Tpc!2026")

    if not ks_path.is_file():
        if not _which(config.KEYTOOL_BIN):
            log.warning("keytool nahi mila — debug signing par fallback")
            return {"available": False}

        dname = f"CN={app_name}, OU=TPC, O=TPC Panel, C=IN"
        code, out = _run([
            config.KEYTOOL_BIN, "-genkeypair", "-v",
            "-keystore", str(ks_path),
            "-alias", config.KEYSTORE_ALIAS,
            "-keyalg", "RSA", "-keysize", "2048",
            "-validity", str(config.KEYSTORE_VALIDITY_DAYS),
            "-storepass", password,
            "-keypass", password,
            "-dname", dname,
        ], timeout=120)

        if code != 0 or not ks_path.is_file():
            return {"available": False, "error": out[-400:]}

        if app.get("_id"):
            try:
                service.apps_col().update_one(
                    {"_id": app["_id"]},
                    {"$set": {"keystore_pw_enc": service.encrypt_secret(password),
                              "keystore_at": _now()}},
                )
            except Exception:
                pass

    # gradle ke liye keystore.properties (rootProject relative)
    local_ks = workspace / "app-keystore.jks"
    shutil.copy2(ks_path, local_ks)

    (workspace / "keystore.properties").write_text(
        "storeFile=app-keystore.jks\n"
        f"storePassword={password}\n"
        f"keyAlias={config.KEYSTORE_ALIAS}\n"
        f"keyPassword={password}\n",
        encoding="utf-8",
    )

    return {
        "available": True,
        "keystore": ks_path,
        "local": local_ks,
        "password": password,
    }


# ------------------------------------------------------------------- build

def _gradle_cmd(workspace: Path, task: str) -> list[str]:
    args = [f"assemble{task}"]
    args += ["-PappIdBuild=true", f"-Dorg.gradle.jvmargs=-Xmx{config.GRADLE_MEM}"]
    args += list(config.GRADLE_ARGS)

    if config.USE_DOCKER:
        return [
            config.DOCKER_BIN, "run", "--rm",
            "-v", f"{workspace}:/work", "-w", "/work",
            config.DOCKER_IMAGE,
            "gradle", *args,
        ]
    return [config.GRADLE_BIN, *args]


def _find_apk(workspace: Path, variant: str) -> Optional[Path]:
    base = workspace / "app" / "build" / "outputs" / "apk" / variant
    if not base.is_dir():
        return None
    cands = sorted(base.glob("*.apk"), key=lambda p: p.stat().st_mtime, reverse=True)
    for c in cands:
        if "-unsigned" not in c.name:
            return c
    return cands[0] if cands else None


def _post_process(apk: Path, app_id: str, build_id: str, log_line) -> tuple[Path, bool]:
    """zipalign + apksigner. Tools na ho to APK as-is chalta hai."""
    work = apk.parent
    signed = False

    if _which(config.ZIPALIGN_BIN):
        aligned = work / f"{build_id}-aligned.apk"
        code, out = _run([config.ZIPALIGN_BIN, "-f", "-p", "4", str(apk), str(aligned)], timeout=180)
        if code == 0 and aligned.is_file():
            apk = aligned
            log_line("zipalign ok")
        else:
            log_line(f"zipalign skip: {out.strip()[:200]}")

    ks = config.KEYSTORE_DIR / f"{app_id}.jks"
    if _which(config.APKSIGNER_BIN) and ks.is_file():
        app = service.get_app_by_id(app_id) or {}
        pw = service.decrypt_secret(app.get("keystore_pw_enc") or "") or (app_id[-6:] + "Tpc!2026")
        out_apk = work / f"{build_id}-signed.apk"

        code, out = _run([
            config.APKSIGNER_BIN, "sign",
            "--ks", str(ks),
            "--ks-key-alias", config.KEYSTORE_ALIAS,
            "--ks-pass", f"pass:{pw}",
            "--key-pass", f"pass:{pw}",
            "--v1-signing-enabled", "true",
            "--v2-signing-enabled", "true",
            "--v3-signing-enabled", "true",
            "--out", str(out_apk), str(apk),
        ], timeout=300)

        if code == 0 and out_apk.is_file():
            code2, out2 = _run([config.APKSIGNER_BIN, "verify", "--print-certs", str(out_apk)], timeout=120)
            if code2 == 0:
                log_line("apksigner sign + verify ok")
                apk = out_apk
                signed = True
            else:
                log_line(f"apksigner verify fail: {out2.strip()[:200]}")
        else:
            log_line(f"apksigner sign fail: {out.strip()[:200]}")

    return apk, signed


async def run_build(build_id: str, emit: Optional[EmitFn] = None,
                    should_cancel: Optional[CancelFn] = None) -> None:
    doc = service.builds_col().find_one({"buildId": build_id})
    if not doc:
        log.warning("build %s DB me nahi mila", build_id)
        return

    if doc.get("status") not in ("queued", "running"):
        if doc.get("status") == "canceled":
            if emit:
                emit(doc.get("userId"), {"type": "build",
                                         "data": {"buildId": build_id, "status": "canceled"}})
        return

    app = service.get_app_by_id(doc["appId"])
    if not app:
        _fail(build_id, doc, "app delete ho gaya", emit)
        return

    variant = (doc.get("variant") or config.DEFAULT_VARIANT).lower()
    task = "Release" if variant == "release" else "Debug"

    workspace = config.BUILD_ROOT / build_id
    log_path = config.LOG_DIR / f"{build_id}.log"
    config.LOG_DIR.mkdir(parents=True, exist_ok=True)

    started = time.time()
    _set(build_id, status="running", started_at=_now(), attempts=int(doc.get("attempts") or 0) + 1)
    service.add_build_event(build_id, doc["appId"], doc["userId"], "info", f"worker start ({variant})")
    if emit:
        emit(doc["userId"], {"type": "build",
                             "data": {"buildId": build_id, "appId": doc["appId"], "status": "running"}})

    tail: deque[str] = deque(maxlen=config.MAX_BUILD_LOG_LINES)

    def log_line(line: str) -> None:
        line = line.rstrip()
        if not line:
            return
        tail.append(line)
        try:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass

    try:
        # ---------------- 1. workspace
        if workspace.exists():
            shutil.rmtree(workspace, ignore_errors=True)
        workspace.mkdir(parents=True, exist_ok=True)
        log_line(f"[1/7] workspace {workspace}")

        shutil.copytree(
            config.TEMPLATE_DIR, workspace,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns(*config.COPY_IGNORE),
        )
        log_line("[1/7] template copied")

        if _cancel_requested(build_id, should_cancel):
            raise _Canceled()

        # ---------------- 2. keystore
        log_line("[2/7] keystore")
        ks = ensure_keystore(doc["appId"], app.get("name") or "App", workspace)
        log_line("[2/7] keystore " + ("ready" if ks.get("available") else "skipped"))

        # ---------------- 3. strings.xml
        secret = service.app_secret(app)
        if not secret:
            raise RuntimeError("app secret decrypt nahi hua (ENCRYPTION_KEY check karo)")

        base_url = doc.get("baseUrl") or config._str_env("APK_DEFAULT_BASE_URL", "")
        res_dir = workspace / "app" / "src" / "main" / "res" / "values"
        res_dir.mkdir(parents=True, exist_ok=True)

        strings_path = res_dir / "strings.xml"
        if strings_path.is_file():
            text = strings_path.read_text(encoding="utf-8")
        else:
            text = '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n'

        text = _patch_strings(text, {
            "app_name": app.get("name") or "App",
            "api_app_id": doc["appId"],
            "api_secret": secret,
            "api_base_url": base_url,
            "api_hmac_window_seconds": str(config.SIGNED_WINDOW_SECONDS),
        })
        strings_path.write_text(text, encoding="utf-8")
        log_line("[3/7] strings.xml patched")

        (res_dir / "builder.xml").write_text(
            '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
            f'    <bool name="allow_cleartext">{"true" if base_url.startswith("http://") else "false"}</bool>\n'
            '</resources>\n',
            encoding="utf-8",
        )

        # ---------------- 4. builder.properties
        (workspace / "builder.properties").write_text(
            f"appId={app.get('package') or validators.package_for(doc['appId'], doc['userId'])}\n"
            f"versionCode={int(doc.get('versionCode') or 1)}\n"
            f"versionName={doc.get('versionName') or '1.0'}\n"
            f"appName={app.get('name') or 'App'}\n",
            encoding="utf-8",
        )
        log_line("[4/7] builder.properties written")

        if _cancel_requested(build_id, should_cancel):
            raise _Canceled()

        # ---------------- 5. gradle
        cmd = _gradle_cmd(workspace, task)
        log_line("[5/7] " + " ".join(cmd))

        proc = await asyncio.create_subprocess_exec(
            *cmd, cwd=str(workspace),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        async def pump():
            assert proc.stdout is not None
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    break
                log_line(raw.decode("utf-8", "replace"))

        pump_task = asyncio.create_task(pump())

        try:
            await asyncio.wait_for(proc.wait(), timeout=config.GRADLE_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError(f"gradle timeout ({config.GRADLE_TIMEOUT}s)")

        await asyncio.gather(pump_task, return_exceptions=True)

        if proc.returncode != 0:
            err = "\n".join(list(tail)[-25:])
            raise RuntimeError(f"gradle exit {proc.returncode}\n{err}")

        _set(build_id, log_tail=list(tail)[-40:])
        log_line("[5/7] gradle ok")

        # ---------------- 6. locate + sign
        apk = _find_apk(workspace, variant)
        if not apk or not apk.is_file():
            raise RuntimeError(f"{variant} APK output me nahi mila")

        log_line("[6/7] signing")
        apk, signed = _post_process(apk, doc["appId"], build_id, log_line)

        if not validators.looks_like_apk(apk):
            raise RuntimeError("output valid APK nahi hai")

        if config.REQUIRE_SIGNATURE and not signed and not ks.get("available"):
            log_line("warning: APK unsigned (apksigner/keytool missing)")

        # ---------------- 7. publish
        dest, size, sha = storage.publish_apk(apk, doc["appId"], build_id)
        log_line(f"[7/7] published {dest.name} ({size} bytes)")

        try:
            shutil.copy2(log_path, storage.apk_log_path(doc["appId"], build_id))
        except OSError:
            pass

        duration = int((time.time() - started) * 1000)
        _set(
            build_id,
            status="success",
            finished_at=_now(),
            duration_ms=duration,
            apk_path=str(dest),
            apk_size=size,
            apk_sha256=sha,
            signed=signed,
            error=None,
            log_tail=list(tail)[-40:],
        )
        service.add_build_event(build_id, doc["appId"], doc["userId"], "info",
                                f"build success in {duration}ms, {size} bytes")

        if emit:
            emit(doc["userId"], {
                "type": "build",
                "data": {
                    "buildId": build_id, "appId": doc["appId"],
                    "status": "success", "apk_size": size, "signed": signed,
                },
            })
        log.info("build %s success (%d bytes)", build_id, size)

    except _Canceled:
        _set(build_id, status="canceled", finished_at=_now(), log_tail=list(tail)[-40:])
        service.add_build_event(build_id, doc["appId"], doc["userId"], "warn", "canceled")
        if emit:
            emit(doc.get("userId"), {"type": "build",
                                     "data": {"buildId": build_id, "status": "canceled"}})
    except Exception as e:
        log.warning("build %s fail: %s", build_id, e)
        _set(build_id, log_tail=list(tail)[-40:])
        _fail(build_id, doc, str(e), emit)
    finally:
        if config._bool_env("APK_CLEAN_WORKSPACE", True):
            shutil.rmtree(workspace, ignore_errors=True)


class _Canceled(Exception):
    pass


# ------------------------------------------------------- standalone poller

def _poll_once() -> int:
    """External worker mode: Mongo se queued builds uthao."""
    n = 0
    for row in service.builds_col().find({"status": "queued"}).sort("_id", 1).limit(5):
        try:
            asyncio.run(run_build(row["buildId"]))
            n += 1
        except Exception:
            log.exception("poll build %s fail", row["buildId"])
    return n


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    config.ensure_dirs()
    log.info("APK builder poller start (interval=%ds)", config.POLL_INTERVAL)
    while True:
        try:
            _poll_once()
        except Exception:
            log.exception("poll loop error")
        time.sleep(config.POLL_INTERVAL)


if __name__ == "__main__":
    main()