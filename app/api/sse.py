"""
SSE streaming utilities for the Copilot endpoint.

stream_graph_events() runs a LangGraph invocation and yields SSE lines
so the FastAPI route can return a StreamingResponse.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncGenerator
from typing import Any

from app.core.events import format_sse
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
    try:
        async for event in graph.astream_events(initial_state, config=config, version="v2"):
            event_type = event.get("event", "")
            data = event.get("data", {})

            # LangGraph on_chain_end carries state updates from nodes.
            # We look for pending_sse_events added by nodes and flush them.
            if event_type == "on_chain_end":
                output = data.get("output", {})
                if isinstance(output, dict):
                    sse_events = output.get("pending_sse_events", [])
                    for sse_evt in sse_events:
                        yield format_sse(sse_evt)

            # Interrupt events are surfaced as on_chain_end on the graph
            elif event_type == "on_interrupt":
                payload = data.get("value", {})
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
