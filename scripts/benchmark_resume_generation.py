#!/usr/bin/env python3
"""Summarize persisted resume-generation run exports without contacting an LLM.

Percentiles use nearest-rank. P95 is deliberately withheld for cohorts with
fewer than 20 valid measured runs.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import sys
import tempfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

TERMINAL_STATUSES = frozenset({"completed", "interrupted", "failed", "cancelled"})
SPAN_CATEGORIES = (
    "nodes",
    "llm_calls",
    "embedding_calls",
    "database_calls",
    "layout_calls",
    "persistence_calls",
)
ENVIRONMENT_ALLOWLIST = frozenset(
    {
        "git_commit",
        "python",
        "os",
        "database_location",
        "provider",
        "model",
        "embedding_provider",
        "embedding_model",
        "layout_profile_version",
        "layout_profile_hash",
        "feature_flags",
        "base_url_host_hash",
    }
)


class BenchmarkError(ValueError):
    """Raised for malformed benchmark input or invalid CLI values."""


def is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def nearest_rank(values: Iterable[float | int], percentile: float) -> float | int:
    ordered = sorted(values)
    if not ordered:
        raise BenchmarkError("nearest_rank requires at least one value")
    if not 0 < percentile <= 1:
        raise BenchmarkError("percentile must be in (0, 1]")
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def distribution(values: Iterable[float | int]) -> dict[str, object]:
    collected = list(values)
    if not collected:
        return {
            "sample_count": 0,
            "p50": None,
            "p95": None,
            "p95_published": False,
            "max": None,
        }
    publish_p95 = len(collected) >= 20
    return {
        "sample_count": len(collected),
        "p50": nearest_rank(collected, 0.50),
        "p95": nearest_rank(collected, 0.95) if publish_p95 else None,
        "p95_published": publish_p95,
        "max": max(collected),
    }


def as_mapping(value: object) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    return {str(key): item for key, item in value.items()}


def load_export(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise BenchmarkError(f"input does not exist: {path}") from exc
    if not raw:
        raise BenchmarkError("input is empty")
    try:
        parsed: object = json.loads(raw)
    except json.JSONDecodeError:
        try:
            parsed = [json.loads(line) for line in raw.splitlines() if line.strip()]
        except json.JSONDecodeError as exc:
            raise BenchmarkError(f"input is neither JSON nor JSONL: {exc}") from exc

    environment: dict[str, Any] = {}
    if isinstance(parsed, list):
        raw_runs = parsed
    elif isinstance(parsed, Mapping):
        raw_runs = parsed.get("runs", [parsed])
        raw_environment = as_mapping(parsed.get("environment")) or {}
        environment = {
            key: value for key, value in raw_environment.items() if key in ENVIRONMENT_ALLOWLIST
        }
    else:
        raise BenchmarkError("input root must be an object, an array, or JSONL objects")
    if not isinstance(raw_runs, list):
        raise BenchmarkError("runs must be an array")
    runs: list[dict[str, Any]] = []
    for index, value in enumerate(raw_runs):
        run = as_mapping(value)
        if run is None:
            raise BenchmarkError(f"run at index {index} is not an object")
        run["_source_index"] = index
        runs.append(run)
    return runs, environment


def run_id(run: Mapping[str, Any]) -> str:
    value = run.get("run_id") or run.get("id")
    return str(value) if value else f"source-index-{run.get('_source_index', 'unknown')}"


def case_id(run: Mapping[str, Any]) -> str:
    value = run.get("case_id") or run.get("caseId")
    return str(value) if value else "unclassified"


def entrypoint(run: Mapping[str, Any]) -> str:
    explicit = run.get("entrypoint")
    if explicit in {"stream", "non_stream"}:
        return str(explicit)
    return "stream" if run.get("trigger") == "chat_stream" else "non_stream"


def metrics_for(run: Mapping[str, Any]) -> dict[str, Any]:
    nested = as_mapping(run.get("metrics"))
    if nested is not None:
        return nested
    return {category: run.get(category, []) for category in SPAN_CATEGORIES}


def observations_for(run: Mapping[str, Any]) -> list[dict[str, Any]]:
    for key in ("layout_observations", "observations"):
        value = run.get(key)
        if isinstance(value, list):
            return [mapping for item in value if (mapping := as_mapping(item)) is not None]
    single = as_mapping(run.get("dom_observation"))
    return [single] if single is not None else []


def layout_report_for(run: Mapping[str, Any]) -> dict[str, Any] | None:
    direct = as_mapping(run.get("layout_report"))
    if direct is not None:
        return direct
    metrics = metrics_for(run)
    return as_mapping(metrics.get("layout_report"))


def numeric_field(run: Mapping[str, Any], field: str) -> float | int | None:
    value = run.get(field)
    return value if is_number(value) and value >= 0 else None


def validate_run(run: Mapping[str, Any], *, require_dom: bool) -> list[str]:
    reasons: list[str] = []
    if not run.get("run_id") and not run.get("id"):
        reasons.append("missing_run_id")
    if run.get("status") not in TERMINAL_STATUSES:
        reasons.append("non_terminal_status")
    for field in ("graph_duration_ms", "endpoint_duration_ms"):
        if numeric_field(run, field) is None:
            reasons.append(f"missing_{field}")
    metrics = metrics_for(run)
    if not any(
        isinstance(metrics.get(category), list) and metrics.get(category)
        for category in SPAN_CATEGORIES
    ):
        reasons.append("missing_metrics")
    report = layout_report_for(run)
    if report is None or not report.get("profile_hash"):
        reasons.append("missing_layout_profile_hash")
    observations = observations_for(run)
    if require_dom and not observations:
        reasons.append("missing_dom_observation")
    if observations and report is not None:
        backend_hash = report.get("profile_hash")
        for observation in observations:
            dom_hash = observation.get("profile_hash") or observation.get("profileHash")
            profile_matches = observation.get("profile_matches")
            if profile_matches is False or (dom_hash and backend_hash and dom_hash != backend_hash):
                reasons.append("profile_hash_mismatch")
                break
    if run.get("telemetry_persist_failed") is True:
        reasons.append("telemetry_persist_failed")
    return sorted(set(reasons))


def spans(run: Mapping[str, Any], category: str) -> list[dict[str, Any]]:
    value = metrics_for(run).get(category)
    if not isinstance(value, list):
        return []
    return [mapping for item in value if (mapping := as_mapping(item)) is not None]


def union_duration_ms(items: Iterable[Mapping[str, Any]]) -> float:
    intervals: list[tuple[float, float]] = []
    for item in items:
        start = item.get("started_offset_ms")
        duration = item.get("duration_ms")
        if is_number(start) and is_number(duration) and start >= 0 and duration >= 0:
            intervals.append((float(start), float(start + duration)))
    if not intervals:
        return 0.0
    intervals.sort()
    total = 0.0
    current_start, current_end = intervals[0]
    for start, end in intervals[1:]:
        if start <= current_end:
            current_end = max(current_end, end)
        else:
            total += current_end - current_start
            current_start, current_end = start, end
    return round(total + current_end - current_start, 3)


def call_count(call: Mapping[str, Any], primary: str, fallback: str) -> int:
    value = call.get(primary)
    if is_number(value):
        return max(0, int(value))
    fallback_value = call.get(fallback)
    if is_number(fallback_value):
        return max(0, int(fallback_value))
    if isinstance(fallback_value, list):
        return len(fallback_value)
    return 0


def llm_summary(run: Mapping[str, Any]) -> dict[str, int]:
    calls = spans(run, "llm_calls")
    logical = run.get("llm_logical_calls")
    logical_count = int(logical) if is_number(logical) else len(calls)
    protocol_count = sum(
        call_count(call, "protocol_attempt_count", "protocol_attempts") for call in calls
    )
    if calls and protocol_count == 0:
        protocol_count = len(calls)
    physical = run.get("llm_physical_requests")
    physical_count = (
        int(physical)
        if is_number(physical)
        else sum(call_count(call, "physical_request_count", "transport_attempts") for call in calls)
    )
    input_tokens = run.get("input_tokens")
    output_tokens = run.get("output_tokens")
    return {
        "logical_calls": logical_count,
        "protocol_attempts": protocol_count,
        "physical_requests": physical_count,
        "input_tokens": (
            int(input_tokens)
            if is_number(input_tokens)
            else sum(
                int(call.get("input_tokens", 0))
                for call in calls
                if is_number(call.get("input_tokens"))
            )
        ),
        "output_tokens": (
            int(output_tokens)
            if is_number(output_tokens)
            else sum(
                int(call.get("output_tokens", 0))
                for call in calls
                if is_number(call.get("output_tokens"))
            )
        ),
    }


def outcome(run: Mapping[str, Any]) -> str:
    status = str(run.get("status"))
    if status in {"failed", "cancelled"}:
        return status
    quality = as_mapping(run.get("quality_result")) or {}
    quality_status = quality.get("quality_status") or run.get("quality_status")
    if quality_status in {"content_gap", "needs_user_decision", "quality_failed"}:
        return str(quality_status)
    return "business_terminal"


def backend_dom_difference(run: Mapping[str, Any]) -> dict[str, object] | None:
    report = layout_report_for(run)
    observations = observations_for(run)
    if report is None or not observations:
        return None
    preview = next(
        (
            item
            for item in observations
            if (item.get("surface") or item.get("measurementSurface")) == "preview"
        ),
        observations[0],
    )
    backend_page_count = report.get("page_count")
    dom_page_count = preview.get("page_count") or preview.get("pageCount")
    backend_ratios = {
        item.get("bullet_id"): item.get("last_line_ratio")
        for item in report.get("bullet_fits", [])
        if isinstance(item, Mapping)
        and item.get("bullet_id")
        and is_number(item.get("last_line_ratio"))
    }
    raw_bullets = preview.get("bullet_metrics") or preview.get("bullets") or []
    ratio_deltas: list[float] = []
    if isinstance(raw_bullets, list):
        for raw in raw_bullets:
            bullet = as_mapping(raw)
            if bullet is None:
                continue
            bullet_id = bullet.get("bullet_id") or bullet.get("bulletId")
            dom_ratio = bullet.get("last_line_ratio")
            if not is_number(dom_ratio):
                width = bullet.get("last_line_width_px") or bullet.get("lastLineWidthPx")
                available = bullet.get("available_line_width_px") or bullet.get(
                    "availableLineWidthPx"
                )
                if is_number(width) and is_number(available) and available > 0:
                    dom_ratio = width / available
            backend_ratio = backend_ratios.get(bullet_id)
            if is_number(dom_ratio) and is_number(backend_ratio):
                ratio_deltas.append(abs(float(dom_ratio) - float(backend_ratio)))
    return {
        "run_id": run_id(run),
        "backend_page_count": backend_page_count,
        "dom_page_count": dom_page_count,
        "page_count_differs": backend_page_count != dom_page_count,
        "max_tail_ratio_absolute_delta": round(max(ratio_deltas), 6) if ratio_deltas else None,
    }


def aggregate_runs(runs: Sequence[Mapping[str, Any]]) -> dict[str, object]:
    endpoint_values = [
        value for run in runs if (value := numeric_field(run, "endpoint_duration_ms")) is not None
    ]
    graph_values = [
        value for run in runs if (value := numeric_field(run, "graph_duration_ms")) is not None
    ]
    llm_by_run = [llm_summary(run) for run in runs]
    stage_values: dict[str, list[float]] = defaultdict(list)
    stage_percentages: dict[str, list[float]] = defaultdict(list)
    node_values: dict[str, list[float]] = defaultdict(list)
    critical_path_values: list[float] = []
    differences: list[dict[str, object]] = []
    for run in runs:
        endpoint = numeric_field(run, "endpoint_duration_ms")
        all_spans: list[dict[str, Any]] = []
        for category in SPAN_CATEGORIES:
            category_spans = spans(run, category)
            all_spans.extend(category_spans)
            duration = union_duration_ms(category_spans)
            stage_values[category].append(duration)
            if endpoint and endpoint > 0:
                stage_percentages[category].append(round(duration / endpoint, 6))
        critical_path_values.append(union_duration_ms(all_spans))
        for node in spans(run, "nodes"):
            operation = str(node.get("node") or node.get("operation") or "unknown")
            duration = node.get("duration_ms")
            if is_number(duration):
                node_values[operation].append(float(duration))
        difference = backend_dom_difference(run)
        if difference is not None:
            differences.append(difference)

    return {
        "latency_ms": {
            "endpoint": distribution(endpoint_values),
            "graph": distribution(graph_values),
            "observed_span_critical_path": distribution(critical_path_values),
        },
        "outcomes": dict(sorted(Counter(outcome(run) for run in runs).items())),
        "stages": {
            category: {
                "critical_path_wall_ms": distribution(stage_values[category]),
                "endpoint_ratio": distribution(stage_percentages[category]),
            }
            for category in SPAN_CATEGORIES
        },
        "nodes": {
            node: {"calls": len(values), "duration_ms": distribution(values)}
            for node, values in sorted(node_values.items())
        },
        "llm": {
            field: distribution([summary[field] for summary in llm_by_run])
            for field in (
                "logical_calls",
                "protocol_attempts",
                "physical_requests",
                "input_tokens",
                "output_tokens",
            )
        },
        "backend_dom": {
            "compared_run_count": len(differences),
            "page_count_mismatch_count": sum(
                1 for difference in differences if difference["page_count_differs"]
            ),
            "runs": differences,
        },
    }


def write_json_atomic(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
        ) as temporary:
            temporary.write(rendered)
            temporary_name = temporary.name
        os.replace(temporary_name, path)
    finally:
        if temporary_name is not None:
            temporary_path = Path(temporary_name)
            if temporary_path.exists():
                temporary_path.unlink()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Summarize persisted resume-generation run JSON using nearest-rank percentiles."
    )
    parser.add_argument("--input", type=Path, required=True, help="JSON or JSONL run export")
    parser.add_argument("--output", type=Path, help="Write report JSON; stdout when omitted")
    parser.add_argument(
        "--warmup", type=int, default=2, help="Valid runs excluded before measurement"
    )
    parser.add_argument(
        "--runs", type=int, default=30, help="Maximum measured valid runs; 0 means all"
    )
    parser.add_argument("--case", action="append", default=[], help="Repeatable case ID filter")
    parser.add_argument(
        "--entrypoint",
        choices=("all", "stream", "non-stream"),
        default="all",
        help="Report streaming and non-streaming inputs separately",
    )
    parser.add_argument(
        "--require-dom",
        action="store_true",
        help="Mark runs without a matching DOM observation invalid",
    )
    parser.add_argument(
        "--minimum-valid-runs",
        type=int,
        default=30,
        help="Minimum measured runs required for baseline_status=ready",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.warmup < 0 or args.runs < 0 or args.minimum_valid_runs < 1:
        raise BenchmarkError(
            "warmup/runs must be non-negative and minimum-valid-runs must be positive"
        )
    runs, environment = load_export(args.input)
    requested_cases = set(args.case)
    filtered = [run for run in runs if not requested_cases or case_id(run) in requested_cases]
    if args.entrypoint != "all":
        wanted = "stream" if args.entrypoint == "stream" else "non_stream"
        filtered = [run for run in filtered if entrypoint(run) == wanted]

    invalid_samples: list[dict[str, object]] = []
    valid: list[dict[str, Any]] = []
    for run in filtered:
        reasons = validate_run(run, require_dom=args.require_dom)
        if reasons:
            invalid_samples.append({"run_id": run_id(run), "reasons": reasons})
        else:
            valid.append(run)
    warmups = valid[: args.warmup]
    measured = valid[args.warmup :]
    if args.runs:
        measured = measured[: args.runs]

    by_entrypoint = {
        name: aggregate_runs([run for run in measured if entrypoint(run) == name])
        for name in ("stream", "non_stream")
    }
    ready = len(measured) >= args.minimum_valid_runs
    report: dict[str, object] = {
        "schema_version": "resume-generation-baseline-v1",
        "percentile_method": "nearest-rank",
        "p95_minimum_sample_count": 20,
        "baseline_status": "ready" if ready else "pending",
        "environment": environment,
        "reporter_runtime": {"python": platform.python_version(), "os": platform.system()},
        "sample_selection": {
            "input_run_count": len(runs),
            "filtered_run_count": len(filtered),
            "requested_cases": sorted(requested_cases),
            "entrypoint": args.entrypoint,
            "warmup_requested": args.warmup,
            "measured_requested": args.runs,
            "minimum_valid_runs": args.minimum_valid_runs,
            "require_dom": args.require_dom,
        },
        "valid_run_count": len(measured),
        "warmup_run_ids": [run_id(run) for run in warmups],
        "cold_start": {
            "run_ids": [run_id(warmups[0])] if warmups else [],
            "aggregates": aggregate_runs(warmups[:1]),
        },
        "warmup_aggregates": aggregate_runs(warmups),
        "run_ids": [run_id(run) for run in measured],
        "invalid_samples": invalid_samples,
        "aggregates": aggregate_runs(measured),
        "entrypoints": by_entrypoint,
    }
    if args.output:
        write_json_atomic(args.output, report)
        print(json.dumps({"output": str(args.output), "status": report["baseline_status"]}))
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BenchmarkError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
