from __future__ import annotations

from unittest.mock import AsyncMock

from app.domain.resume.factbank.models import FactBankRevisionTask
from app.domain.resume.factbank.service import compute_revision_hash
from app.rag.evidence.factbank_worker import FactBankWorker


def _task(*, attempts: int) -> FactBankRevisionTask:
    content = "Built an API"
    return FactBankRevisionTask(
        revision_id="rev-1",
        experience_id="exp-1",
        user_id="user-1",
        content=content,
        revision_hash=compute_revision_hash(content),
        status="extracting",
        attempt_count=attempts,
    )


def _worker(repository, processor, *, max_attempts: int = 5) -> FactBankWorker:
    return FactBankWorker(
        repository,
        processor,
        schema_version="factbank-v1",
        extractor_version="atomic-facts-v1",
        embedding_model="test-embedding",
        concurrency=1,
        poll_interval_seconds=0.01,
        lease_seconds=60,
        max_attempts=max_attempts,
        legacy_backfill_batch_size=0,
    )


async def test_worker_schedules_retry_without_losing_failed_task() -> None:
    repository = AsyncMock()
    processor = AsyncMock()
    task = _task(attempts=2)
    repository.claim_next.return_value = task
    worker = _worker(repository, processor)

    async def fail_and_stop(_task: FactBankRevisionTask) -> None:
        worker._stop.set()
        raise RuntimeError("provider unavailable")

    processor.process.side_effect = fail_and_stop

    await worker._run_slot(0)

    repository.schedule_retry.assert_awaited_once()
    kwargs = repository.schedule_retry.call_args.kwargs
    assert kwargs["terminal"] is False
    assert kwargs["next_attempt_at"] is not None
    assert "provider unavailable" in kwargs["error"]


async def test_worker_moves_exhausted_task_to_terminal_failed_state() -> None:
    repository = AsyncMock()
    processor = AsyncMock()
    task = _task(attempts=5)
    repository.claim_next.return_value = task
    worker = _worker(repository, processor, max_attempts=5)

    async def fail_and_stop(_task: FactBankRevisionTask) -> None:
        worker._stop.set()
        raise RuntimeError("still unavailable")

    processor.process.side_effect = fail_and_stop

    await worker._run_slot(0)

    kwargs = repository.schedule_retry.call_args.kwargs
    assert kwargs["terminal"] is True
    assert kwargs["next_attempt_at"] is None
