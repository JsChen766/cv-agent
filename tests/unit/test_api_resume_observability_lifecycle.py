from __future__ import annotations

from typing import Any

from app.api.observability import finish_trace_best_effort, start_trace_best_effort
from app.core.observability import TraceRecorder


def _recorder(run_id: str = "rgrun-api-test") -> TraceRecorder:
    return TraceRecorder(
        run_id=run_id,
        request_id="request-api-test",
        thread_id="thread-api-test",
        turn_id="turn-api-test",
        trigger="chat",
    )


class _RecordingService:
    def __init__(self) -> None:
        self.starts: list[Any] = []
        self.finishes: list[Any] = []

    async def start_run(self, data: object) -> None:
        self.starts.append(data)

    async def finish_run(self, data: object) -> bool:
        self.finishes.append(data)
        return True


class _FailingService(_RecordingService):
    def __init__(self, *, fail_start: bool = False, fail_finish: bool = False) -> None:
        super().__init__()
        self.fail_start = fail_start
        self.fail_finish = fail_finish

    async def start_run(self, data: object) -> None:
        await super().start_run(data)
        if self.fail_start:
            raise RuntimeError("telemetry start unavailable")

    async def finish_run(self, data: object) -> bool:
        await super().finish_run(data)
        if self.fail_finish:
            raise RuntimeError("telemetry finish unavailable")
        return True


async def test_trace_start_and_finish_are_persisted_exactly_once() -> None:
    recorder = _recorder()
    service = _RecordingService()

    for _ in range(2):
        await start_trace_best_effort(
            recorder,
            user_id="user-api-test",
            service=service,  # type: ignore[arg-type]
        )

    for status in ("completed", "failed"):
        await finish_trace_best_effort(
            recorder,
            user_id="user-api-test",
            service=service,  # type: ignore[arg-type]
            status=status,  # type: ignore[arg-type]
        )

    assert len(service.starts) == 1
    assert len(service.finishes) == 1
    assert service.finishes[0].status == "completed"


async def test_trace_start_failure_is_best_effort() -> None:
    recorder = _recorder("rgrun-start-failure")
    service = _FailingService(fail_start=True)

    await start_trace_best_effort(
        recorder,
        user_id="user-api-test",
        service=service,  # type: ignore[arg-type]
    )

    assert len(service.starts) == 1
    assert recorder.telemetry_persist_failed is True
    assert recorder.status == "running"


async def test_trace_finish_failure_is_best_effort() -> None:
    recorder = _recorder("rgrun-finish-failure")
    service = _FailingService(fail_finish=True)
    await start_trace_best_effort(
        recorder,
        user_id="user-api-test",
        service=service,  # type: ignore[arg-type]
    )

    await finish_trace_best_effort(
        recorder,
        user_id="user-api-test",
        service=service,  # type: ignore[arg-type]
        status="completed",
    )

    assert len(service.finishes) == 1
    assert recorder.telemetry_persist_failed is True
    assert recorder.status == "completed"
