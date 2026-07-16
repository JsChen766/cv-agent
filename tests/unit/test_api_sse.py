import json
from collections.abc import AsyncIterator
from typing import Any, cast

from langchain_core.runnables import RunnableConfig

from app.api.sse import stream_graph_events
from app.graphs.state import MainState


class FakeGraph:
    async def astream_events(
        self,
        initial_state: MainState,
        *,
        config: RunnableConfig,
        version: str,
        stream_mode: list[str],
    ) -> AsyncIterator[dict[str, Any]]:
        yield {"event": "on_chain_start", "name": "router", "data": {}}
        yield {"event": "on_chain_end", "name": "router", "data": {"output": {}}}
        yield {
            "event": "on_chain_end",
            "name": "open_ended",
            "data": {
                "output": {
                    "pending_sse_events": [
                        {"event": "agent.tool.started", "tool": "list_resumes", "input": {}}
                    ],
                    "assistant_message": "Done from graph.",
                    "workspace": {"jd_id": "jd-1"},
                }
            },
        }


class InterruptGraph:
    async def astream_events(
        self,
        initial_state: MainState,
        *,
        config: RunnableConfig,
        version: str,
        stream_mode: list[str],
    ) -> AsyncIterator[dict[str, Any]]:
        yield {
            "event": "on_chain_end",
            "name": "experience_import",
            "data": {
                "output": {
                    "__interrupt__": [
                        type(
                            "Interrupt",
                            (),
                            {
                                "value": {
                                    "type": "experience_import",
                                    "message": "Review before saving.",
                                    "candidates": [{"title": "Platform migration"}],
                                }
                            },
                        )()
                    ]
                }
            },
        }


class CumulativeEventGraph:
    async def astream_events(
        self,
        initial_state: MainState,
        *,
        config: RunnableConfig,
        version: str,
        stream_mode: list[str],
    ) -> AsyncIterator[dict[str, Any]]:
        first = {"event": "agent.route.completed", "target": "open_ended"}
        second = {"event": "agent.message.completed", "content": "Done"}
        yield {
            "event": "on_chain_end",
            "name": "router",
            "data": {"output": {"pending_sse_events": [first]}},
        }
        yield {
            "event": "on_chain_end",
            "name": "open_ended",
            "data": {
                "output": {
                    "pending_sse_events": [first, second],
                    "assistant_message": "Done",
                }
            },
        }


class CustomDeltaGraph:
    """Graph double that emits two writer-backed token chunks."""

    def __init__(self) -> None:
        self.stream_modes: list[list[str]] = []

    async def astream_events(
        self,
        initial_state: MainState,
        *,
        config: RunnableConfig,
        version: str,
        stream_mode: list[str],
    ) -> AsyncIterator[dict[str, Any]]:
        self.stream_modes.append(stream_mode)
        yield {
            "event": "on_chain_stream",
            "name": "open_ended",
            "data": {
                "chunk": (
                    "custom",
                    {"event": "agent.message.delta", "content": "first "},
                )
            },
        }
        yield {
            "event": "on_chain_stream",
            "name": "open_ended",
            "data": {
                "chunk": (
                    "custom",
                    {"event": "agent.message.delta", "content": "second"},
                )
            },
        }
        yield {
            "event": "on_chain_end",
            "name": "open_ended",
            "data": {
                "output": {
                    "assistant_message": "first second",
                    "pending_sse_events": [
                        {"event": "agent.message.completed", "content": "first second"}
                    ],
                }
            },
        }


async def test_stream_graph_events_projects_activity_events() -> None:
    initial_state: MainState = {
        "thread_id": "thread-1",
        "current_turn_id": "turn-1",
        "messages": [],
        "workspace": {},
        "pending_sse_events": [],
    }

    chunks = [
        chunk async for chunk in stream_graph_events(FakeGraph(), initial_state, config={})
    ]
    payloads = [_payload(chunk) for chunk in chunks]
    activity_events = [
        payload for payload in payloads if payload["event"] == "agent.activity.updated"
    ]

    assert activity_events[0]["agent_role"] == "frontdesk"
    assert activity_events[0]["status"] == "running"
    assert activity_events[0]["thread_id"] == "thread-1"
    assert activity_events[0]["turn_id"] == "turn-1"
    assert any(event.get("tool", {}).get("name") == "list_resumes" for event in activity_events)

    completed = next(payload for payload in payloads if payload["event"] == "agent.completed")
    assert completed["response"]["assistantMessage"]["content"] == "Done from graph."
    assert completed["response"]["workspace"] == {"jd_id": "jd-1"}


async def test_stream_graph_events_surfaces_interrupt_payload() -> None:
    initial_state: MainState = {
        "thread_id": "thread-1",
        "current_turn_id": "turn-1",
        "messages": [],
        "workspace": {},
        "pending_sse_events": [],
    }

    chunks = [
        chunk async for chunk in stream_graph_events(InterruptGraph(), initial_state, config={})
    ]
    payloads = [_payload(chunk) for chunk in chunks]

    interrupt = next(payload for payload in payloads if payload["event"] == "agent.interrupt")
    assert interrupt["interrupt_type"] == "experience_import"
    assert interrupt["data"]["candidates"] == [{"title": "Platform migration"}]
    assert not any(payload["event"] == "agent.completed" for payload in payloads)


async def test_stream_graph_events_emits_cumulative_queue_items_once() -> None:
    initial_state: MainState = {
        "thread_id": "thread-1",
        "current_turn_id": "turn-1",
        "messages": [],
        "workspace": {},
        "pending_sse_events": [],
    }

    chunks = [
        chunk
        async for chunk in stream_graph_events(CumulativeEventGraph(), initial_state, config={})
    ]
    payloads = [_payload(chunk) for chunk in chunks]

    assert sum(payload["event"] == "agent.route.completed" for payload in payloads) == 1
    assert sum(payload["event"] == "agent.message.completed" for payload in payloads) == 1


async def test_stream_graph_events_forwards_custom_delta_chunks_individually() -> None:
    initial_state: MainState = {
        "thread_id": "thread-1",
        "current_turn_id": "turn-1",
        "messages": [],
        "workspace": {},
        "pending_sse_events": [],
    }
    graph = CustomDeltaGraph()

    chunks = [
        chunk async for chunk in stream_graph_events(graph, initial_state, config={})
    ]
    payloads = [_payload(chunk) for chunk in chunks]
    delta_chunks = [
        chunk for chunk in chunks if _payload(chunk).get("event") == "agent.message.delta"
    ]
    delta_payloads = [_payload(chunk) for chunk in delta_chunks]

    # `stream_mode=["custom"]` is required for events sent with
    # get_stream_writer(). Keep each callback chunk as a separate SSE output so
    # the client can render it as soon as it arrives.
    assert graph.stream_modes == [["custom"]]
    assert [payload["content"] for payload in delta_payloads] == ["first ", "second"]
    assert len(delta_chunks) == 2
    event_names = [payload["event"] for payload in payloads]
    assert event_names.index("agent.message.completed") > event_names.index(
        "agent.message.delta"
    )
    assert payloads[-1]["event"] == "agent.completed"


def _payload(chunk: str) -> dict[str, Any]:
    data_line = next(line for line in chunk.splitlines() if line.startswith("data: "))
    return cast("dict[str, Any]", json.loads(data_line.removeprefix("data: ")))
