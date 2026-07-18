"""Best-effort lifecycle wiring for resume generation traces."""

from __future__ import annotations

import logging
import random
from typing import Literal, cast

from langchain_core.runnables import RunnableConfig

from app.core.config import settings
from app.core.observability import TRACE_VERSION, TraceRecorder, TraceStatus, utc_now
from app.core.types import generate_id
from app.domain.resume.observability_models import (
    ResumeGenerationRunFinish,
    ResumeGenerationRunStart,
    RunTrigger,
)
from app.domain.resume.observability_service import ResumeObservabilityService

logger = logging.getLogger(__name__)


def create_resume_trace(
    *,
    request_id: str | None,
    thread_id: str | None,
    turn_id: str | None,
    trigger: RunTrigger,
    parent_run_id: str | None = None,
) -> TraceRecorder | None:
    if not settings.resume_observability_enabled:
        return None
    if random.random() > settings.resume_observability_sample_rate:
        return None
    return TraceRecorder(
        run_id=generate_id("rgrun-"),
        request_id=request_id,
        thread_id=thread_id,
        turn_id=turn_id,
        trigger=trigger,
        parent_run_id=parent_run_id,
    )


def inject_trace(config: RunnableConfig, recorder: TraceRecorder | None) -> None:
    if recorder is None:
        return
    configurable = config.setdefault("configurable", {})
    configurable["trace_recorder"] = recorder


async def start_trace_best_effort(
    recorder: TraceRecorder,
    *,
    user_id: str,
    service: ResumeObservabilityService | None,
) -> None:
    if service is None or not recorder.claim_persist_start():
        return
    try:
        await service.start_run(
            ResumeGenerationRunStart(
                id=recorder.run_id,
                user_id=user_id,
                request_id=recorder.request_id,
                thread_id=recorder.thread_id,
                turn_id=recorder.turn_id,
                parent_run_id=recorder.parent_run_id,
                trigger=cast("RunTrigger", recorder.trigger),
                trace_version=TRACE_VERSION,
                provider=recorder.provider,
                model=recorder.model,
                started_at=recorder.started_at,
            )
        )
    except Exception as exc:  # noqa: BLE001
        recorder.telemetry_persist_failed = True
        logger.warning("Resume trace start failed for %s: %s", recorder.run_id, exc)


async def finish_trace_best_effort(
    recorder: TraceRecorder | None,
    *,
    user_id: str,
    service: ResumeObservabilityService | None,
    status: TraceStatus,
    graph_duration_ms: int | None = None,
    error_code: str | None = None,
) -> None:
    if recorder is None:
        return
    recorder.finish(
        status,
        graph_duration_ms=graph_duration_ms,
        endpoint_duration_ms=recorder.elapsed_ms(),
        error_code=error_code,
    )
    if (
        service is None
        or not recorder.persist_started
        or not recorder.claim_persist_finish()
    ):
        return
    snapshot = recorder.snapshot(
        include_payload=settings.resume_observability_capture_payloads
    )
    counts = recorder.summary_counts()
    try:
        await service.finish_run(
            ResumeGenerationRunFinish(
                id=recorder.run_id,
                user_id=user_id,
                status=cast(
                    "Literal['completed', 'interrupted', 'failed', 'cancelled']",
                    recorder.status,
                ),
                resume_id=recorder.resume_id,
                variant_id=recorder.variant_id,
                provider=recorder.provider,
                model=recorder.model,
                graph_duration_ms=recorder.graph_duration_ms,
                endpoint_duration_ms=recorder.endpoint_duration_ms,
                llm_logical_calls=counts["llm_logical_calls"],
                llm_physical_requests=counts["llm_physical_requests"],
                input_tokens=counts["input_tokens"],
                output_tokens=counts["output_tokens"],
                payload_hash=recorder.payload_hash,
                payload_snapshot=(
                    snapshot.get("payload_snapshot")
                    if settings.resume_observability_capture_payloads
                    else None
                ),
                layout_report=recorder.layout_report,
                metrics=recorder.metrics(),
                error_code=recorder.error_code,
                completed_at=recorder.completed_at or utc_now(),
            )
        )
    except Exception as exc:  # noqa: BLE001
        recorder.telemetry_persist_failed = True
        logger.warning("Resume trace finish failed for %s: %s", recorder.run_id, exc)
