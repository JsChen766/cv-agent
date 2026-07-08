"""
Main LangGraph graph.

Assembles all subgraphs and the router into a single compiled graph.
"""

from typing import Any, cast

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from app.graphs.artifact.graph import build_artifact_subgraph
from app.graphs.experience.graph import build_experience_import_subgraph
from app.graphs.jd.graph import build_jd_subgraph
from app.graphs.open_ended import open_ended_node
from app.graphs.resume.graph import build_resume_subgraph
from app.graphs.router import route_decision, router_node
from app.graphs.state import MainState


def build_main_graph(checkpointer: Any | None = None) -> Any:
    """Build and compile the main graph with all subgraphs."""
    builder: StateGraph[MainState] = StateGraph(MainState)

    # ── Nodes ──────────────────────────────────────────────────────────────────
    builder.add_node("router", router_node)
    builder.add_node("open_ended", open_ended_node)

    # Subgraphs compiled as nodes
    builder.add_node("jd", _run_jd_subgraph)
    builder.add_node("resume_generation", _run_resume_subgraph)
    builder.add_node("artifact", _run_artifact_subgraph)
    builder.add_node("experience_import", _run_experience_subgraph)

    # ── Edges ──────────────────────────────────────────────────────────────────
    builder.add_edge(START, "router")
    builder.add_conditional_edges(
        "router",
        route_decision,
        {
            "experience_import": "experience_import",
            "jd": "jd",
            "resume_generation": "resume_generation",
            "artifact": "artifact",
            "open_ended": "open_ended",
        },
    )
    builder.add_edge("experience_import", END)
    builder.add_edge("jd", END)
    builder.add_edge("resume_generation", END)
    builder.add_edge("artifact", END)
    builder.add_edge("open_ended", END)

    # ── Compile ────────────────────────────────────────────────────────────────
    if checkpointer is not None:
        return builder.compile(checkpointer=checkpointer)
    return builder.compile()


# Lazy singleton — only built when first needed
_graph: Any | None = None
_graph_checkpointer_id = None


def get_graph(checkpointer: Any | None = None) -> Any:
    global _graph, _graph_checkpointer_id
    checkpointer_id = id(checkpointer) if checkpointer is not None else None
    if _graph is None or _graph_checkpointer_id != checkpointer_id:
        _graph = build_main_graph(checkpointer)
        _graph_checkpointer_id = checkpointer_id
    return _graph


async def _run_jd_subgraph(
    state: MainState, config: RunnableConfig | None = None
) -> dict[str, Any]:
    graph: Any = build_jd_subgraph().compile()
    return cast("dict[str, Any]", await graph.ainvoke(state, config=config))


async def _run_resume_subgraph(
    state: MainState, config: RunnableConfig | None = None
) -> dict[str, Any]:
    graph: Any = build_resume_subgraph().compile()
    return cast("dict[str, Any]", await graph.ainvoke(state, config=config))


async def _run_artifact_subgraph(
    state: MainState, config: RunnableConfig | None = None
) -> dict[str, Any]:
    graph: Any = build_artifact_subgraph().compile()
    return cast("dict[str, Any]", await graph.ainvoke(state, config=config))


async def _run_experience_subgraph(
    state: MainState, config: RunnableConfig | None = None
) -> dict[str, Any]:
    graph: Any = build_experience_import_subgraph().compile()
    return cast("dict[str, Any]", await graph.ainvoke(state, config=config))
