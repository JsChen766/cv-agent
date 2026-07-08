"""Experience Import subgraph."""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.graphs.experience.nodes import parse_import_node, review_import_node, save_import_node
from app.graphs.state import MainState


def build_experience_import_subgraph() -> StateGraph[MainState]:
    builder = StateGraph(MainState)

    builder.add_node("parse", parse_import_node)
    builder.add_node("review", review_import_node)
    builder.add_node("save", save_import_node)

    builder.add_edge(START, "parse")
    builder.add_edge("parse", "review")
    builder.add_edge("review", "save")
    builder.add_edge("save", END)

    return builder
