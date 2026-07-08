"""JD subgraph — save JD + parse requirements."""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.graphs.jd.nodes import parse_requirements_node, save_jd_node
from app.graphs.state import MainState


def build_jd_subgraph() -> StateGraph[MainState]:
    builder = StateGraph(MainState)
    builder.add_node("save_jd", save_jd_node)
    builder.add_node("parse_requirements", parse_requirements_node)
    builder.add_edge(START, "save_jd")
    builder.add_edge("save_jd", "parse_requirements")
    builder.add_edge("parse_requirements", END)
    return builder
