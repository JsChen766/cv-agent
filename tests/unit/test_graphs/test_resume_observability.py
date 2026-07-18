from __future__ import annotations

import pytest
from langgraph.errors import GraphInterrupt
from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict

from app.core.observability import TraceRecorder, current_recorder
from app.graphs.tracing import traced_node


def _recorder() -> TraceRecorder:
    return TraceRecorder(
        run_id="rgrun-node-test",
        request_id="request-node-test",
        thread_id="thread-node-test",
        turn_id="turn-node-test",
        trigger="chat",
    )


async def test_traced_node_preserves_interrupt_and_repeated_attempts() -> None:
    recorder = _recorder()
    invocations = 0

    async def node(state: dict[str, object]) -> dict[str, object]:
        nonlocal invocations
        invocations += 1
        assert current_recorder() is recorder
        if invocations == 1:
            raise GraphInterrupt()
        return {"result": state["value"]}

    wrapped = traced_node("resume_review", node)
    config = {"configurable": {"trace_recorder": recorder}}

    with pytest.raises(GraphInterrupt):
        await wrapped({"value": "first"}, config)

    assert await wrapped({"value": "second"}, config) == {"result": "second"}
    assert current_recorder() is None

    attempts = recorder.metrics()["nodes"]
    assert [(item["attempt"], item["status"]) for item in attempts] == [
        (1, "interrupted"),
        (2, "completed"),
    ]
    assert attempts[0]["error_category"] == "GraphInterrupt"
    assert all(item["node"] == "resume_review" for item in attempts)
    assert all(item["duration_ms"] is not None for item in attempts)


async def test_langgraph_injects_config_for_wrapped_state_only_node() -> None:
    class State(TypedDict):
        value: str

    recorder = _recorder()

    async def state_only_node(state: State) -> dict[str, object]:
        assert current_recorder() is recorder
        return {"value": state["value"] + "-done"}

    builder = StateGraph(State)
    builder.add_node("state_only", traced_node("state_only", state_only_node))
    builder.add_edge(START, "state_only")
    builder.add_edge("state_only", END)

    result = await builder.compile().ainvoke(
        {"value": "start"},
        config={"configurable": {"trace_recorder": recorder}},
    )

    assert result["value"] == "start-done"
    assert recorder.metrics()["nodes"][0]["node"] == "state_only"
