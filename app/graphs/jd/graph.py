"""JD subgraph — extract JD + parse requirements + user confirm + persist."""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.graphs.jd.nodes import (
    extract_jd_node,
    jd_confirm_node,
    jd_persist_node,
    parse_requirements_node,
)
from app.graphs.state import MainState


def build_jd_subgraph() -> StateGraph[MainState]:
    builder = StateGraph(MainState)
    builder.add_node("extract_jd", extract_jd_node)
    builder.add_node("parse_requirements", parse_requirements_node)
    builder.add_node("jd_confirm", jd_confirm_node)
    builder.add_node("jd_persist", jd_persist_node)
    builder.add_edge(START, "extract_jd")
    builder.add_edge("extract_jd", "parse_requirements")
    builder.add_edge("parse_requirements", "jd_confirm")
    builder.add_edge("jd_confirm", "jd_persist")
    builder.add_edge("jd_persist", END)
    return builder
