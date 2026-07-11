from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.graphs.main import build_main_graph
from app.graphs.state import MainState


def _jd_passthrough_subgraph() -> StateGraph[MainState]:
    builder = StateGraph(MainState)

    async def passthrough(state: MainState) -> dict[str, object]:
        extracted = state.get("extracted_params", {})
        workspace = dict(state.get("workspace", {}))
        workspace["jd_id"] = "jd-created"
        return {
            "assistant_message": str(extracted.get("raw_text", "")),
            "extracted_params": extracted,
            "workspace": workspace,
        }

    builder.add_node("passthrough", passthrough)
    builder.add_edge(START, "passthrough")
    builder.add_edge("passthrough", END)
    return builder


async def test_main_graph_preserves_route_parameters_through_subgraph(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.main.build_jd_subgraph", _jd_passthrough_subgraph)
    graph = build_main_graph()
    state: MainState = {
        "thread_id": "thread-1",
        "user_id": "user-1",
        "messages": [{"role": "user", "content": "save this JD"}],
        "workspace": {"resume_id": "resume-1"},
        "target_subgraph": "jd",
        "intent_description": "Save supplied JD",
        "context_hints": ["active_jd"],
        "extracted_params": {"raw_text": "Python backend role"},
        "pending_sse_events": [],
    }

    result = await graph.ainvoke(state)

    assert result["extracted_params"]["raw_text"] == "Python backend role"
    assert result["assistant_message"] == "Python backend role"
    assert result["workspace"] == {"resume_id": "resume-1", "jd_id": "jd-created"}
