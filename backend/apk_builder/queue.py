"""Async build queue — concurrency, dedupe, cancel, crash recovery.

Queue in-process hai (asyncio.Queue). Build rows Mongo me hote hain, isliye
process restart hone par recover() se adhoore builds dobara queue ho jaate hain.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Callable, Optional, Set

from . import config

log = logging.getLogger("tpc.apk.queue")

EmitFn = Callable[[str, dict], None]


class BuildQueue:
    def __init__(self, concurrency: int = None, maxsize: int = None,
                 emit: Optional[EmitFn] = None):
        self.concurrency = max(1, int(concurrency or config.MAX_CONCURRENT_BUILDS))
        self._q: asyncio.Queue = asyncio.Queue(maxsize=int(maxsize or config.QUEUE_MAXSIZE))
        self._tasks: list[asyncio.Task] = []
        self._pending: Set[str] = set()
        self._running: dict[str, int] = {}
        self._canceled: Set[str] = set()
        self._emit = emit
        self._started = False

    # ------------------------------------------------------------- lifecycle

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        await self.recover()
        for i in range(self.concurrency):
            self._tasks.append(
                asyncio.create_task(self._loop(i), name=f"apk-worker-{i}")
            )
        log.info("build queue start — workers=%d", self.concurrency)

    async def stop(self) -> None:
        self._started = False
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        log.info("build queue stop")

    async def recover(self) -> int:
        """Restart ke baad adhoore builds wapas queue karo."""
        from . import service
        n = 0
        try:
            stuck = list(service.builds_col().find({"status": "running"}, {"buildId": 1}))
            for row in stuck:
                service.builds_col().update_one(
                    {"_id": row["_id"]},
                    {"$set": {"status": "queued", "error": "requeued after restart"}},
                )
                await self.enqueue(row["buildId"])
                n += 1

            queued = list(service.builds_col().find({"status": "queued"}, {"buildId": 1}))
            for row in queued:
                if await self.enqueue(row["buildId"]):
                    n += 1
        except Exception:
            log.warning("queue recover fail", exc_info=True)

        if n:
            log.info("queue recover — %d build requeued", n)
        return n

    # ---------------------------------------------------------------- public

    async def enqueue(self, build_id: str) -> bool:
        if build_id in self._pending or build_id in self._running:
            return False
        self._pending.add(build_id)
        try:
            self._q.put_nowait(build_id)
        except asyncio.QueueFull:
            self._pending.discard(build_id)
            log.warning("queue full — %s drop", build_id)
            return False
        return True

    def cancel(self, build_id: str) -> None:
        self._canceled.add(build_id)

    def is_canceled(self, build_id: str) -> bool:
        return build_id in self._canceled

    def stats(self) -> dict:
        return {
            "concurrency": self.concurrency,
            "queued": self._q.qsize(),
            "pending_set": len(self._pending),
            "running": len(self._running),
            "running_ids": sorted(self._running),
        }

    # ----------------------------------------------------------------- loop

    async def _loop(self, idx: int) -> None:
        from .worker import run_build

        while True:
            build_id = await self._q.get()
            self._pending.discard(build_id)
            self._running[build_id] = idx

            try:
                await run_build(
                    build_id,
                    emit=self._emit,
                    should_cancel=self.is_canceled,
                )
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.exception("build %s crash: %s", build_id, e)
                await self._mark_failed(build_id, f"worker crash: {e}")
            finally:
                self._running.pop(build_id, None)
                self._canceled.discard(build_id)
                self._q.task_done()

    async def _mark_failed(self, build_id: str, message: str) -> None:
        from . import service
        try:
            doc = service.builds_col().find_one({"buildId": build_id})
            if not doc or doc.get("status") in ("success", "canceled"):
                return
            service.builds_col().update_one(
                {"_id": doc["_id"]},
                {"$set": {
                    "status": "failed",
                    "error": message[:1000],
                    "finished_at": service._now(),
                    "updated_at": service._now(),
                }},
            )
            if self._emit:
                self._emit(doc["userId"], {
                    "type": "build",
                    "data": {"buildId": build_id, "appId": doc["appId"],
                             "status": "failed", "error": message[:300]},
                })
        except Exception:
            pass


# module-level singleton — app.py isko start/stop karta hai
build_queue: Optional[BuildQueue] = None


def get_queue() -> BuildQueue:
    global build_queue
    if build_queue is None:
        build_queue = BuildQueue()
    return build_queue


def init_queue(emit: Optional[EmitFn] = None) -> BuildQueue:
    global build_queue
    build_queue = BuildQueue(emit=emit)
    return build_queue