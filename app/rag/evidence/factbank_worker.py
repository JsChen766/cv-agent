from __future__ import annotations

import asyncio
import logging
import uuid
from contextlib import suppress
from datetime import UTC, datetime, timedelta

from app.domain.resume.factbank.repository import FactBankRepository
from app.rag.evidence.factbank_processor import FactBankProcessor

logger = logging.getLogger(__name__)


class FactBankWorker:
    def __init__(
        self,
        repository: FactBankRepository,
        processor: FactBankProcessor,
        *,
        schema_version: str,
        extractor_version: str,
        embedding_model: str,
        concurrency: int,
        poll_interval_seconds: float,
        lease_seconds: float,
        max_attempts: int,
        legacy_backfill_batch_size: int,
    ) -> None:
        self._repository = repository
        self._processor = processor
        self._schema_version = schema_version
        self._extractor_version = extractor_version
        self._embedding_model = embedding_model
        self._concurrency = concurrency
        self._poll_interval_seconds = poll_interval_seconds
        self._lease_seconds = lease_seconds
        self._max_attempts = max_attempts
        self._legacy_backfill_batch_size = legacy_backfill_batch_size
        self._stop = asyncio.Event()
        self._tasks: list[asyncio.Task[None]] = []
        self._worker_group_id = f"factbank-{uuid.uuid4()}"

    def start(self) -> None:
        if self._tasks:
            return
        self._stop.clear()
        self._tasks = [
            asyncio.create_task(
                self._run_slot(index),
                name=f"{self._worker_group_id}-{index}",
            )
            for index in range(self._concurrency)
        ]

    async def stop(self) -> None:
        self._stop.set()
        if not self._tasks:
            return
        try:
            async with asyncio.timeout(5):
                await asyncio.gather(*self._tasks, return_exceptions=True)
        except TimeoutError:
            for task in self._tasks:
                task.cancel()
            await asyncio.gather(*self._tasks, return_exceptions=True)
        finally:
            self._tasks = []

    async def _run_slot(self, slot: int) -> None:
        worker_id = f"{self._worker_group_id}-{slot}"
        while not self._stop.is_set():
            try:
                task = await self._repository.claim_next(
                    worker_id=worker_id,
                    lease_until=datetime.now(UTC) + timedelta(seconds=self._lease_seconds),
                    schema_version=self._schema_version,
                    extractor_version=self._extractor_version,
                    embedding_model=self._embedding_model,
                )
                if task is None:
                    if slot == 0:
                        await self._repository.enqueue_legacy_revisions(
                            limit=self._legacy_backfill_batch_size
                        )
                    await self._wait_for_poll()
                    continue
                try:
                    mode = await self._processor.process(task)
                    logger.info(
                        "FactBank revision ready",
                        extra={
                            "revision_id": task.revision_id,
                            "experience_id": task.experience_id,
                            "mode": mode,
                            "attempt_count": task.attempt_count,
                        },
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - task failures become durable state
                    terminal = task.attempt_count >= self._max_attempts
                    delay = min(300.0, 2 ** max(0, task.attempt_count - 1))
                    next_attempt_at = (
                        None if terminal else datetime.now(UTC) + timedelta(seconds=delay)
                    )
                    await self._repository.schedule_retry(
                        task,
                        error=f"{type(exc).__name__}: {exc}",
                        next_attempt_at=next_attempt_at,
                        terminal=terminal,
                    )
                    logger.warning(
                        "FactBank revision processing failed",
                        extra={
                            "revision_id": task.revision_id,
                            "attempt_count": task.attempt_count,
                            "terminal": terminal,
                        },
                        exc_info=exc,
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - keep the durable worker alive
                logger.warning("FactBank worker polling failed: %s", exc)
                await self._wait_for_poll()

    async def _wait_for_poll(self) -> None:
        with suppress(TimeoutError):
            await asyncio.wait_for(self._stop.wait(), timeout=self._poll_interval_seconds)
