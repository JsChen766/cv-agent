"""
Main LangGraph graph.

Assembles all subgraphs and the router into a single compiled graph.
"""

from typing import Any

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

    # ── Subgraphs compiled with same checkpointer ──────────────────────────
    jd_subgraph = build_jd_subgraph().compile(checkpointer=checkpointer)
    resume_subgraph = build_resume_subgraph().compile(checkpointer=checkpointer)
    artifact_subgraph = build_artifact_subgraph().compile(checkpointer=checkpointer)
    experience_subgraph = build_experience_import_subgraph().compile(checkpointer=checkpointer)

    # ── Nodes ──────────────────────────────────────────────────────────────────
    builder.add_node("router", router_node)
    builder.add_node("open_ended", open_ended_node)
    builder.add_node("jd", jd_subgraph)
    builder.add_node("resume_generation", resume_subgraph)
    builder.add_node("artifact", artifact_subgraph)
    builder.add_node("experience_import", experience_subgraph)

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
