"""Request-scoped, PII-safe observability primitives.

This module deliberately has no imports from ``app``.  It is safe for the
domain and provider layers to depend on it without reversing architecture
boundaries.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import math
import threading
import time
from collections import defaultdict
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

TraceStatus = Literal["running", "completed", "interrupted", "failed", "cancelled"]
SpanStatus = Literal["completed", "interrupted", "failed", "cancelled"]
SpanCategory = Literal[
    "nodes",
    "llm_calls",
    "embedding_calls",
    "database_calls",
    "layout_calls",
    "persistence_calls",
]

TRACE_VERSION = "resume-generation-trace-v1"

_current_recorder: contextvars.ContextVar[TraceRecorder | None] = contextvars.ContextVar(
    "resume_trace_recorder", default=None
)
_current_node: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "resume_trace_node", default=None
)

# Only operational metadata is accepted.  Unknown keys are dropped instead of
# attempting to redact arbitrary user text after it has already been captured.
_SAFE_ATTRIBUTE_KEYS = frozenset(
    {
        "attempt",
        "available_height_px",
        "batch_size",
        "bullet_count",
        "beam_state_count",
        "accepted_candidate_count",
        "width_cache_hits",
        "width_cache_misses",
        "wrap_cache_hits",
        "wrap_cache_misses",
        "width_query_count",
        "cached",
        "candidate_count",
        "category",
        "cold_load",
        "coverage_regression_count",
        "duration_ms",
        "error_category",
        "fact_error_count",
        "fallback_reason",
        "final_fit_status",
        "final_page_count",
        "final_route",
        "final_usage_ratio",
        "first_token_ms",
        "input_char_count",
        "input_tokens",
        "item_count",
        "language",
        "logical_call_count",
        "max_usage_ratio",
        "measure_call_count",
        "mode",
        "model",
        "node",
        "operation",
        "output_tokens",
        "physical_request_count",
        "profile_hash",
        "profile_version",
        "protocol",
        "protocol_attempt_count",
        "protocol_attempts",
        "quality_status",
        "read_write",
        "rejected_candidate_count",
        "repair_rejection_codes",
        "repaired",
        "provider",
        "retry_count",
        "row_count",
        "schema_name",
        "status",
        "total_tokens",
        "transport_attempts",
        "transport_attempt_events",
        "trigger",
        "tuning_attempts",
        "usage_available",
        "vector_count",
        "violation_count",
    }
)


def utc_now() -> datetime:
    return datetime.now(UTC)


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonical_payload_hash(value: object) -> str:
    digest = hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _duration_ms(start_ns: int, end_ns: int) -> int:
    return max(0, (end_ns - start_ns) // 1_000_000)


def _safe_scalar(value: object) -> str | int | float | bool | None:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return str(value)[:120]


def sanitize_attributes(attributes: Mapping[str, object] | None) -> dict[str, object]:
    """Keep only explicitly approved operational attributes."""
    if not attributes:
        return {}
    result: dict[str, object] = {}
    for key, value in attributes.items():
        if key not in _SAFE_ATTRIBUTE_KEYS:
            continue
        if isinstance(value, Mapping):
            result[key] = sanitize_attributes(value)
        elif isinstance(value, (list, tuple)):
            result[key] = [
                sanitize_attributes(item) if isinstance(item, Mapping) else _safe_scalar(item)
                for item in value[:100]
            ]
        else:
            result[key] = _safe_scalar(value)
    return result


@dataclass(slots=True)
class TraceSpan:
    category: SpanCategory
    operation: str
    started_ns: int
    started_offset_ms: int
    attempt: int
    node: str | None
    attributes: dict[str, object] = field(default_factory=dict)
    duration_ms: int | None = None
    status: SpanStatus | None = None
    error_category: str | None = None

    def finish(
        self,
        *,
        ended_ns: int,
        status: SpanStatus,
        error_category: str | None = None,
        attributes: Mapping[str, object] | None = None,
    ) -> None:
        self.duration_ms = _duration_ms(self.started_ns, ended_ns)
        self.status = status
        self.error_category = error_category
        if attributes:
            self.attributes.update(sanitize_attributes(attributes))

    def to_dict(self) -> dict[str, object]:
        value: dict[str, object] = {
            "operation": self.operation,
            "attempt": self.attempt,
            "started_offset_ms": self.started_offset_ms,
            "duration_ms": self.duration_ms,
            "status": self.status,
        }
        if self.category == "nodes":
            value["node"] = self.operation
        elif self.node:
            value["node"] = self.node
        if self.error_category:
            value["error_category"] = self.error_category
        value.update(self.attributes)
        return value


class TraceRecorder:
    """Concurrency-safe in-memory recorder for one HTTP/graph run."""

    def __init__(
        self,
        *,
        run_id: str,
        request_id: str | None,
        thread_id: str | None,
        turn_id: str | None,
        trigger: str,
        parent_run_id: str | None = None,
        started_at: datetime | None = None,
        clock_ns: Any = time.perf_counter_ns,
    ) -> None:
        self.run_id = run_id
        self.request_id = request_id
        self.thread_id = thread_id
        self.turn_id = turn_id
        self.trigger = trigger
        self.parent_run_id = parent_run_id
        self.trace_version = TRACE_VERSION
        self.started_at = started_at or utc_now()
        self.status: TraceStatus = "running"
        self.completed_at: datetime | None = None
        self.graph_duration_ms: int | None = None
        self.endpoint_duration_ms: int | None = None
        self.resume_id: str | None = None
        self.variant_id: str | None = None
        self.payload_hash: str | None = None
        self.payload_snapshot: object | None = None
        self.layout_report: object | None = None
        self.quality_result: dict[str, object] = {}
        self.error_code: str | None = None
        self.telemetry_persist_failed = False
        self.persist_started = False
        self.persist_finished = False
        self.provider: str | None = None
        self.model: str | None = None
        self._clock_ns = clock_ns
        self._started_ns = int(clock_ns())
        self._attempts: defaultdict[tuple[str, str], int] = defaultdict(int)
        self._spans: dict[SpanCategory, list[TraceSpan]] = {
            "nodes": [],
            "llm_calls": [],
            "embedding_calls": [],
            "database_calls": [],
            "layout_calls": [],
            "persistence_calls": [],
        }
        self._lock = threading.RLock()

    def claim_persist_start(self) -> bool:
        with self._lock:
            if self.persist_started:
                return False
            self.persist_started = True
            return True

    def claim_persist_finish(self) -> bool:
        with self._lock:
            if self.persist_finished:
                return False
            self.persist_finished = True
            return True

    def elapsed_ms(self) -> int:
        return _duration_ms(self._started_ns, int(self._clock_ns()))

    @contextmanager
    def activate(self, *, node: str | None = None) -> Iterator[TraceRecorder]:
        recorder_token = _current_recorder.set(self)
        node_token = _current_node.set(node if node is not None else _current_node.get())
        try:
            yield self
        finally:
            _current_node.reset(node_token)
            _current_recorder.reset(recorder_token)

    def start_span(
        self,
        category: SpanCategory,
        operation: str,
        *,
        attributes: Mapping[str, object] | None = None,
    ) -> TraceSpan:
        now_ns = int(self._clock_ns())
        with self._lock:
            key = (category, operation)
            self._attempts[key] += 1
            span = TraceSpan(
                category=category,
                operation=operation,
                started_ns=now_ns,
                started_offset_ms=_duration_ms(self._started_ns, now_ns),
                attempt=self._attempts[key],
                node=_current_node.get(),
                attributes=sanitize_attributes(attributes),
            )
            self._spans[category].append(span)
            return span

    @contextmanager
    def span(
        self,
        category: SpanCategory,
        operation: str,
        *,
        attributes: Mapping[str, object] | None = None,
    ) -> Iterator[TraceSpan]:
        span = self.start_span(category, operation, attributes=attributes)
        try:
            yield span
        except BaseException as exc:
            status: SpanStatus = "cancelled" if isinstance(exc, KeyboardInterrupt) else "failed"
            # asyncio.CancelledError inherits BaseException on supported Python versions.
            if exc.__class__.__name__ == "CancelledError":
                status = "cancelled"
            elif exc.__class__.__name__ in {"GraphInterrupt", "GraphInterruptError"}:
                status = "interrupted"
            span.finish(
                ended_ns=int(self._clock_ns()),
                status=status,
                error_category=exc.__class__.__name__,
            )
            raise
        else:
            span.finish(ended_ns=int(self._clock_ns()), status="completed")

    def bind_result(
        self,
        *,
        resume_id: str | None = None,
        variant_id: str | None = None,
        structured: object | None = None,
        payload_snapshot: object | None = None,
        layout_report: object | None = None,
        quality_result: Mapping[str, object] | None = None,
        provider: str | None = None,
        model: str | None = None,
    ) -> None:
        with self._lock:
            self.resume_id = resume_id or self.resume_id
            self.variant_id = variant_id or self.variant_id
            if structured is not None:
                self.payload_hash = canonical_payload_hash(structured)
            if payload_snapshot is not None:
                self.payload_snapshot = payload_snapshot
            if layout_report is not None:
                self.layout_report = layout_report
            if quality_result is not None:
                self.quality_result = sanitize_attributes(quality_result)
            self.provider = provider or self.provider
            self.model = model or self.model

    def finish(
        self,
        status: TraceStatus,
        *,
        graph_duration_ms: int | None = None,
        endpoint_duration_ms: int | None = None,
        error_code: str | None = None,
    ) -> None:
        with self._lock:
            if self.status != "running":
                return
            self.status = status
            self.completed_at = utc_now()
            self.graph_duration_ms = graph_duration_ms
            self.endpoint_duration_ms = endpoint_duration_ms
            self.error_code = error_code

    def metrics(self) -> dict[str, object]:
        with self._lock:
            return {
                category: [span.to_dict() for span in spans]
                for category, spans in self._spans.items()
            }

    def summary_counts(self) -> dict[str, int]:
        metrics = self.metrics()
        raw_llm_calls = metrics["llm_calls"]
        llm_calls: list[dict[str, object]] = (
            [call for call in raw_llm_calls if isinstance(call, dict)]
            if isinstance(raw_llm_calls, list)
            else []
        )
        logical = len(llm_calls)
        physical = sum(
            _as_int(call.get("physical_request_count") or call.get("transport_attempts"))
            for call in llm_calls
        )
        input_tokens = sum(
            _as_int(call.get("input_tokens")) for call in llm_calls
        )
        output_tokens = sum(
            _as_int(call.get("output_tokens")) for call in llm_calls
        )
        return {
            "llm_logical_calls": logical,
            "llm_physical_requests": physical,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }

    def snapshot(self, *, include_payload: bool = False) -> dict[str, object]:
        value: dict[str, object] = {
            "run_id": self.run_id,
            "request_id": self.request_id,
            "thread_id": self.thread_id,
            "turn_id": self.turn_id,
            "parent_run_id": self.parent_run_id,
            "trigger": self.trigger,
            "status": self.status,
            "trace_version": self.trace_version,
            "started_at": self.started_at.isoformat().replace("+00:00", "Z"),
            "completed_at": (
                self.completed_at.isoformat().replace("+00:00", "Z")
                if self.completed_at
                else None
            ),
            "graph_duration_ms": self.graph_duration_ms,
            "endpoint_duration_ms": self.endpoint_duration_ms,
            "resume_id": self.resume_id,
            "variant_id": self.variant_id,
            "payload_hash": self.payload_hash,
            "layout_report": self.layout_report,
            "quality_result": self.quality_result,
            "provider": self.provider,
            "model": self.model,
            "error_code": self.error_code,
            "telemetry_persist_failed": self.telemetry_persist_failed,
            **self.metrics(),
            **self.summary_counts(),
        }
        if include_payload:
            value["payload_snapshot"] = self.payload_snapshot
        return value


def current_recorder() -> TraceRecorder | None:
    return _current_recorder.get()


def _as_int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def current_node() -> str | None:
    return _current_node.get()


@contextmanager
def observation_span(
    category: SpanCategory,
    operation: str,
    *,
    attributes: Mapping[str, object] | None = None,
) -> Iterator[TraceSpan | None]:
    recorder = current_recorder()
    if recorder is None:
        yield None
        return
    with recorder.span(category, operation, attributes=attributes) as span:
        yield span
