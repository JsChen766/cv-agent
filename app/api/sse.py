"""
SSE streaming utilities for the Copilot endpoint.

stream_graph_events() runs a LangGraph invocation and yields SSE lines
so the FastAPI route can return a StreamingResponse.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator
from typing import Any

from app.core.events import format_sse
from app.graphs.activity import (
    activity_from_interrupt,
    activity_from_node_event,
    activity_from_tool_event,
)
from app.graphs.state import MainState

logger = logging.getLogger(__name__)


async def stream_graph_events(
    graph,
    initial_state: MainState,
    config: dict[str, Any],
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
                activity = commit_activity(activity)
                if activity is not None:
                    yield format_sse(activity)

            # LangGraph on_chain_end carries state updates from nodes.
            # We look for pending_sse_events added by nodes and flush them.
            if event_type == "on_chain_end":
                output = data.get("output", {})
                if isinstance(output, dict):
                    sse_events = output.get("pending_sse_events", [])
                    for sse_evt in sse_events:
                        activity = activity_from_tool_event(
                            sse_evt,
                            thread_id=thread_id,
                            turn_id=turn_id,
                            sequence=activity_sequence + 1,
                        )
                        activity = commit_activity(activity)
                        if activity is not None:
                            yield format_sse(activity)
                        yield format_sse(sse_evt)
                activity = activity_from_node_event(
                    event_name,
                    "completed",
                    thread_id=thread_id,
                    turn_id=turn_id,
                    sequence=activity_sequence + 1,
                )
                activity = commit_activity(activity)
                if activity is not None:
                    yield format_sse(activity)

            # Interrupt events are surfaced as on_chain_end on the graph
            elif event_type == "on_interrupt":
                payload = data.get("value", {})
                activity = activity_from_interrupt(
                    payload,
                    thread_id=thread_id,
                    turn_id=turn_id,
                    sequence=activity_sequence + 1,
                )
                activity = commit_activity(activity)
                yield format_sse(activity)
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

    # Normal completion
    completed_event = {"event": "agent.completed"}
    yield format_sse(completed_event)


def _build_initial_state(
    thread_id: str,
    user_id: str,
    message: str,
    workspace: dict[str, Any] | None,
    turn_id: str,
) -> MainState:
    """Build the initial state dict for a new turn."""
    return {
        "thread_id": thread_id,
        "user_id": user_id,
        "messages": [{"role": "user", "content": message}],
        "workspace": workspace or {},
        "pending_sse_events": [],
        "current_turn_id": turn_id,
        "turn_count": 0,
    }
