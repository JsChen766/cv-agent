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


def _payload(chunk: str) -> dict[str, Any]:
    data_line = next(line for line in chunk.splitlines() if line.startswith("data: "))
    return cast("dict[str, Any]", json.loads(data_line.removeprefix("data: ")))
