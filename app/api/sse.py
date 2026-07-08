"""
SSE streaming utilities for the Copilot endpoint.

stream_graph_events() runs a LangGraph invocation and yields SSE lines
so the FastAPI route can return a StreamingResponse.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator, AsyncIterator, Mapping
from datetime import UTC, datetime
from typing import Any, Protocol, cast

from langchain_core.runnables import RunnableConfig

from app.core.events import format_sse
from app.core.types import generate_id
from app.graphs.activity import (
    activity_from_interrupt,
    activity_from_node_event,
    activity_from_tool_event,
)
from app.graphs.state import MainState
from app.memory.thread_state import ActiveWorkspace

logger = logging.getLogger(__name__)


class EventStreamingGraph(Protocol):
    def astream_events(
        self,
        input: MainState,
        *,
        config: RunnableConfig,
        version: str,
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

    def commit_activity(event: dict[str, Any] | None) -> dict[str, Any] | None:
        nonlocal activity_sequence
        if event is None:
            return None
        activity_sequence += 1
        event["sequence"] = activity_sequence
        return event

    try:
        async for event in graph.astream_events(initial_state, config=config, version="v2"):
            event_type = event.get("event", "")
            event_name = event.get("name", "")
            data = event.get("data", {})

            if event_type == "on_chain_start":
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
                    sse_events = output.get("pending_sse_events", [])
                    for sse_evt in sse_events:
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
                        activity = activity_from_interrupt(
                            interrupt_payload,
                            thread_id=thread_id,
                            turn_id=turn_id,
                            sequence=activity_sequence + 1,
                        )
                        committed_activity = commit_activity(activity)
                        if committed_activity is not None:
                            yield format_sse(committed_activity)
                        yield format_sse(
                            {
                                "event": "agent.interrupt",
                                "interrupt_type": interrupt_payload.get("type", "confirmation"),
                                "data": interrupt_payload,
                            }
                        )
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
                activity = activity_from_interrupt(
                    payload,
                    thread_id=thread_id,
                    turn_id=turn_id,
                    sequence=activity_sequence + 1,
                )
                committed_activity = commit_activity(activity)
                if committed_activity is not None:
                    yield format_sse(committed_activity)
                interrupt_sse = {
                    "event": "agent.interrupt",
                    "interrupt_type": payload.get("interrupt_type", "confirmation"),
                    "data": payload.get("data", payload),
                }
                yield format_sse(interrupt_sse)
                return  # Suspend streaming; client polls /threads/{id}/state

    except Exception as exc:
        logger.exception("Graph execution error: %s", exc)
        failed_event = {
            "event": "agent.failed",
            "error": {"code": "GRAPH_ERROR", "message": str(exc)},
        }
        yield format_sse(failed_event)
        return

    snapshot_interrupt = await _snapshot_interrupt_payload(graph, config)
    if snapshot_interrupt is not None:
        activity = activity_from_interrupt(
            snapshot_interrupt,
            thread_id=thread_id,
            turn_id=turn_id,
            sequence=activity_sequence + 1,
        )
        committed_activity = commit_activity(activity)
        if committed_activity is not None:
            yield format_sse(committed_activity)
        yield format_sse(
            {
                "event": "agent.interrupt",
                "interrupt_type": snapshot_interrupt.get("type", "confirmation"),
                "data": snapshot_interrupt,
            }
        )
        return

    # Normal completion
    completed_event = {
        "event": "agent.completed",
        "threadId": thread_id,
        "turnId": turn_id,
        "response": _build_completed_response(final_state),
    }
    yield format_sse(completed_event)


def _build_initial_state(
    thread_id: str,
    user_id: str,
    message: str,
    workspace: Mapping[str, object] | None,
    turn_id: str,
) -> MainState:
    """Build the initial state dict for a new turn."""
    return {
        "thread_id": thread_id,
        "user_id": user_id,
        "messages": [{"role": "user", "content": message, "turn_id": turn_id}],
        "workspace": cast("ActiveWorkspace", dict(workspace or {})),
        "pending_sse_events": [],
        "current_turn_id": turn_id,
        "turn_count": 0,
    }


def _build_completed_response(state: Mapping[str, Any]) -> dict[str, Any]:
    thread_id = str(state.get("thread_id") or "")
    turn_id = str(state.get("current_turn_id") or "")
    workspace = state.get("workspace")
    interrupt = state.get("interrupt_payload")
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
    interrupts = getattr(snapshot, "interrupts", None)
    if isinstance(interrupts, (list, tuple)) and interrupts:
        value = getattr(interrupts[0], "value", None)
        return value if isinstance(value, dict) else None
    for task in getattr(snapshot, "tasks", ()) or ():
        task_interrupts = getattr(task, "interrupts", None)
        if isinstance(task_interrupts, (list, tuple)) and task_interrupts:
            value = getattr(task_interrupts[0], "value", None)
            if isinstance(value, dict):
                return value
    return None
