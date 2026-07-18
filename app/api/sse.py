"""
SSE streaming utilities for the Copilot endpoint.

stream_graph_events() runs a LangGraph invocation and yields SSE lines
so the FastAPI route can return a StreamingResponse.
"""

from __future__ import annotations

import logging
import re
from collections.abc import AsyncGenerator, AsyncIterator, Generator, Mapping
from datetime import UTC, datetime
from typing import Any, Protocol, cast

from langchain_core.runnables import RunnableConfig

from app.core.errors import AppError
from app.core.events import format_sse
from app.core.types import generate_id
from app.graphs.activity import (
    activity_from_interrupt,
    activity_from_node_event,
    activity_from_tool_event,
)
from app.graphs.state import MainState
from app.memory.thread_state import ActiveWorkspace, MessageDict

logger = logging.getLogger(__name__)

_TASK_NAME_NOTE = re.compile(r"During task with name '([^']+)'")


class EventStreamingGraph(Protocol):
    def astream_events(
        self,
        input: MainState,
        *,
        config: RunnableConfig,
        version: str,
        stream_mode: list[str],
    ) -> AsyncIterator[dict[str, Any]]: ...


async def stream_graph_events(
    graph: EventStreamingGraph,
    initial_state: MainState,
    config: RunnableConfig,
) -> AsyncGenerator[str, None]:
    """
    Invoke graph with astream_events and yield SSE-formatted strings.

    Events are yielded as:
      data: <json>\\n\\n

    A final `agent.completed` or `agent.failed` event is always emitted.
    """
    thread_id = initial_state.get("thread_id")
    turn_id = initial_state.get("current_turn_id")
    activity_sequence = 0
    final_state: dict[str, Any] = dict(initial_state)
    flushed_pending_event_count = 0
    active_node_name: str | None = None

    def commit_activity(event: dict[str, Any] | None) -> dict[str, Any] | None:
        nonlocal activity_sequence
        if event is None:
            return None
        activity_sequence += 1
        event["sequence"] = activity_sequence
        return event

    try:
        async for event in graph.astream_events(initial_state, config=config, version="v2", stream_mode=["custom"]):
            event_type = event.get("event", "")
            event_name = event.get("name", "")
            data = event.get("data", {})
            metadata = event.get("metadata")

            # Custom events pushed by nodes via get_stream_writer() arrive as
            # on_chain_stream with chunk = ('custom', {...}).  Forward them
            # directly to the client as SSE.
            if event_type == "on_chain_stream":
                chunk = data.get("chunk")
                if isinstance(chunk, tuple) and len(chunk) == 2 and chunk[0] == "custom":
                    custom_data = chunk[1]
                    if isinstance(custom_data, dict) and "event" in custom_data:
                        yield format_sse(custom_data)
                continue

            if event_type == "on_chain_start":
                metadata_node = (
                    metadata.get("langgraph_node")
                    if isinstance(metadata, Mapping)
                    else None
                )
                if isinstance(metadata_node, str) and metadata_node:
                    active_node_name = metadata_node
                activity = activity_from_node_event(
                    event_name,
                    "running",
                    thread_id=thread_id,
                    turn_id=turn_id,
                    sequence=activity_sequence + 1,
                )
                committed_activity = commit_activity(activity)
                if committed_activity is not None:
                    yield format_sse(committed_activity)

            # LangGraph on_chain_end carries state updates from nodes.
            # We look for pending_sse_events added by nodes and flush them.
            if event_type == "on_chain_end":
                output = data.get("output", {})
                if isinstance(output, dict):
                    final_state.update(output)
                    raw_sse_events = output.get("pending_sse_events")
                    sse_events = raw_sse_events if isinstance(raw_sse_events, list) else []
                    # Nodes retain the existing queue and append their own events. LangGraph
                    # exposes that cumulative queue at multiple nested on_chain_end events;
                    # emit only the newly appended suffix so clients never receive duplicates.
                    if "pending_sse_events" in output:
                        new_sse_events = (
                            sse_events[flushed_pending_event_count:]
                            if len(sse_events) >= flushed_pending_event_count
                            else sse_events
                        )
                        flushed_pending_event_count = len(sse_events)
                    else:
                        new_sse_events = []
                    for sse_evt in new_sse_events:
                        activity = activity_from_tool_event(
                            sse_evt,
                            thread_id=thread_id,
                            turn_id=turn_id,
                            sequence=activity_sequence + 1,
                        )
                        committed_activity = commit_activity(activity)
                        if committed_activity is not None:
                            yield format_sse(committed_activity)
                        yield format_sse(sse_evt)
                    interrupt_payload = _extract_interrupt_payload(output)
                    if interrupt_payload is not None:
                        for sse in _emit_interrupt_sse(interrupt_payload, activity_sequence, commit_activity, thread_id, turn_id):
                            yield sse
                        return
                activity = activity_from_node_event(
                    event_name,
                    "completed",
                    thread_id=thread_id,
                    turn_id=turn_id,
                    sequence=activity_sequence + 1,
                )
                committed_activity = commit_activity(activity)
                if committed_activity is not None:
                    yield format_sse(committed_activity)

            # Interrupt events are surfaced as on_chain_end on the graph
            elif event_type == "on_interrupt":
                payload = data.get("value", {})
                for sse in _emit_interrupt_sse(payload, activity_sequence, commit_activity, thread_id, turn_id):
                    yield sse
                return  # Suspend streaming

    except Exception as exc:
        logger.exception("Graph execution error: %s", exc)
        failed_node_name = _failed_node_from_exception(exc, active_node_name)
        error_code = exc.code if isinstance(exc, AppError) else "GRAPH_ERROR"
        failed_event = {
            "event": "agent.failed",
            "error": {
                "code": error_code,
                "message": str(exc),
                "node": failed_node_name,
            },
        }
        yield format_sse(failed_event)
        return

    snapshot_interrupt = await _snapshot_interrupt_payload(graph, config)
    if snapshot_interrupt is not None:
        for sse in _emit_interrupt_sse(snapshot_interrupt, activity_sequence, commit_activity, thread_id, turn_id):
            yield sse
        return

    # Fallback: check final_state for __interrupt__ (helps when checkpointer unavailable)
    from_state = _extract_interrupt_payload(final_state)
    if from_state is not None:
        for sse in _emit_interrupt_sse(from_state, activity_sequence, commit_activity, thread_id, turn_id):
            yield sse
        return

    # Normal completion
    completed_event = {
        "event": "agent.completed",
        "threadId": thread_id,
        "turnId": turn_id,
        "response": _build_completed_response(final_state),
    }
    yield format_sse(completed_event)


def _failed_node_from_exception(exc: Exception, fallback: str | None) -> str | None:
    """Return the leaf LangGraph task name attached to an execution error."""
    notes = getattr(exc, "__notes__", ())
    for note in notes:
        match = _TASK_NAME_NOTE.search(str(note))
        if match:
            return match.group(1)
    return fallback


def _build_initial_state(
    thread_id: str,
    user_id: str,
    messages: list[dict[str, object]],
    workspace: Mapping[str, object] | None,
    turn_id: str,
) -> MainState:
    """Build the initial state dict for a new turn.

    `messages` should be the full conversation list for this turn (historical
    messages from the DB plus the current user message).  All turn-scoped
    routing and generation fields are explicitly reset so a fresh turn is never
    short-circuited by stale checkpoint state.
    """
    return cast("MainState", {
        "thread_id": thread_id,
        "user_id": user_id,
        "messages": cast("list[MessageDict]", messages),
        "workspace": cast("ActiveWorkspace", dict(workspace or {})),
        "pending_sse_events": [],
        "current_turn_id": turn_id,
        "turn_count": 0,
        # ── Reset all turn-scoped fields ──────────────────────────────────
        "target_subgraph": None,
        "intent_description": None,
        "assistant_message": None,
        "interrupt_payload": None,
        "extracted_params": {},
        "context_hints": [],
        "router_confidence": 0.0,
        "artifact_type": None,
        "resume_variants": [],
        "import_candidates": [],
        "current_diff": None,
        "review_result": None,
        "review_iteration": 0,
        "variants": [],
        "layout_constraint": {},
        "layout_report": None,
        "layout_revision_iteration": 0,
        "layout_status": None,
        "quality_status": None,
        "quality_issues": [],
        "coverage_before_layout": [],
        "generation_call_count": 0,
        "final_candidate_emitted": False,
        "revision_instruction": None,
        "resume_user_action": None,
        "fact_mismatches": [],
        "resume_structure": None,
        "coverage_report": None,
        "uncovered_jd_requirement_ids": [],
        "jd_requirements": None,
        "relevant_experiences": [],
        "guideline_instructions": [],
        "user_preferences": [],
        "user_profile": None,
        "evidence_pack": None,
        "assembled_jd_text": None,
        "assembled_experiences": [],
        "assembled_guideline_instructions": [],
        "assembled_preferences": [],
        "assembled_user_profile": None,
        "application_tasks": [],
        "application_deliverables": [],
        "unsupported_requirements": [],
    })


def _emit_interrupt_sse(
    payload: dict[str, Any],
    activity_sequence: int,
    commit_activity: Any,
    thread_id: str | None,
    turn_id: str | None,
) -> Generator[str, None, None]:
    activity = activity_from_interrupt(
        payload,
        thread_id=thread_id,
        turn_id=turn_id,
        sequence=activity_sequence + 1,
    )
    committed_activity = commit_activity(activity)
    if committed_activity is not None:
        yield format_sse(committed_activity)
    yield format_sse({
        "event": "agent.interrupt",
        "interrupt_type": payload.get("type", "confirmation"),
        "data": payload,
    })


def _build_completed_response(state: Mapping[str, Any]) -> dict[str, Any]:
    thread_id = str(state.get("thread_id") or "")
    turn_id = str(state.get("current_turn_id") or "")
    workspace = state.get("workspace")
    interrupt = state.get("interrupt_payload")
    if not isinstance(interrupt, dict):
        interrupt = _extract_interrupt_payload(state)
    return {
        "threadId": thread_id,
        "turnId": turn_id,
        "assistantMessage": {
            "id": generate_id("msg"),
            "role": "assistant",
            "content": str(state.get("assistant_message") or ""),
            "createdAt": datetime.now(UTC).isoformat(),
        },
        "workspace": workspace if isinstance(workspace, dict) else {},
        "nextActions": [],
        "suggestedPrompts": [],
        "interrupt": interrupt if isinstance(interrupt, dict) else None,
    }


def _extract_interrupt_payload(output: Mapping[str, Any]) -> dict[str, Any] | None:
    direct = output.get("interrupt_payload")
    if isinstance(direct, dict):
        return direct
    interrupts = output.get("__interrupt__")
    if not isinstance(interrupts, (list, tuple)) or not interrupts:
        return None
    value = getattr(interrupts[0], "value", None)
    return value if isinstance(value, dict) else None


async def _snapshot_interrupt_payload(
    graph: EventStreamingGraph,
    config: RunnableConfig,
) -> dict[str, Any] | None:
    aget_state = getattr(graph, "aget_state", None)
    if aget_state is None:
        return None
    try:
        snapshot = await aget_state(config)
    except Exception:
        return None
    from app.api.interrupts import pending_interrupt_from_snapshot

    pending = pending_interrupt_from_snapshot(snapshot)
    return pending.payload if pending is not None else None
