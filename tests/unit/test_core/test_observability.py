from __future__ import annotations

import asyncio

import pytest

from app.core.observability import (
    TraceRecorder,
    canonical_payload_hash,
    current_recorder,
    observation_span,
    sanitize_attributes,
)


def _recorder(run_id: str = "rgrun-test") -> TraceRecorder:
    return TraceRecorder(
        run_id=run_id,
        request_id="request-test",
        thread_id="thread-test",
        turn_id="turn-test",
        trigger="chat",
    )


def test_recorder_preserves_repeated_node_attempts_and_nested_spans() -> None:
    recorder = _recorder()

    with recorder.activate(node="layout_measure"):
        with recorder.span("nodes", "layout_measure"), recorder.span(
            "layout_calls", "layout.measure_resume"
        ):
            pass
        with recorder.span("nodes", "layout_measure"):
            pass

    metrics = recorder.metrics()
    nodes = metrics["nodes"]
    assert [node["attempt"] for node in nodes] == [1, 2]
    assert metrics["layout_calls"][0]["node"] == "layout_measure"
    assert all(node["status"] == "completed" for node in nodes)


async def test_contextvars_isolate_parallel_recorders() -> None:
    first = _recorder("rgrun-first")
    second = _recorder("rgrun-second")

    async def work(recorder: TraceRecorder, operation: str) -> str:
        with recorder.activate(node=operation):
            await asyncio.sleep(0)
            assert current_recorder() is recorder
            with observation_span("database_calls", operation):
                await asyncio.sleep(0)
            return operation

    assert await asyncio.gather(work(first, "first"), work(second, "second")) == [
        "first",
        "second",
    ]
    assert first.metrics()["database_calls"][0]["operation"] == "first"
    assert second.metrics()["database_calls"][0]["operation"] == "second"


def test_span_finishes_failed_and_cancelled_paths() -> None:
    failed = _recorder("rgrun-failed")
    with (
        pytest.raises(ValueError),
        failed.activate(),
        failed.span("nodes", "draft_generation"),
    ):
        raise ValueError("private user text must not be captured")
    assert failed.metrics()["nodes"][0]["status"] == "failed"
    assert failed.metrics()["nodes"][0]["error_category"] == "ValueError"


def test_hash_is_canonical_and_attributes_drop_pii() -> None:
    assert canonical_payload_hash({"b": 2, "a": 1}) == canonical_payload_hash(
        {"a": 1, "b": 2}
    )
    attributes = sanitize_attributes(
        {
            "model": "test-model",
            "prompt": "secret resume",
            "email": "person@example.com",
            "row_count": 3,
        }
    )
    assert attributes == {"model": "test-model", "row_count": 3}


def test_finish_is_idempotent() -> None:
    recorder = _recorder()
    recorder.finish("completed", endpoint_duration_ms=10)
    recorder.finish("failed", endpoint_duration_ms=20, error_code="late")
    snapshot = recorder.snapshot()
    assert snapshot["status"] == "completed"
    assert snapshot["endpoint_duration_ms"] == 10
    assert snapshot["error_code"] is None
