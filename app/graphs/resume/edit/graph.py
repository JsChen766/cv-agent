"""Resume Edit subgraph (Phase 3)."""
from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.graphs.resume.edit.nodes import (
    apply_node,
    edit_classify_node,
    edit_interrupt_node,
    edit_tier3_bridge_node,
    locate_node,
)
from app.graphs.resume.edit.state import ResumeEditState


def _tier_route(state: ResumeEditState) -> str:
    tier = state.get("edit_tier")
    if tier is None:
        return "end"
    if tier == 1:
        return "apply"
    if tier == 2:
        return "locate"
    return "tier3"


def _apply_route(state: ResumeEditState) -> str:
    if state.get("require_review_before_apply"):
        return "interrupt"
    return "end"


def _locate_route(state: ResumeEditState) -> str:
    ops = state.get("edit_operations")
    if ops:
        return "apply"
    return "end"


def build_resume_edit_subgraph() -> StateGraph[ResumeEditState]:
    builder = StateGraph(ResumeEditState)

    builder.add_node("classify", edit_classify_node)
    builder.add_node("locate", locate_node)
    builder.add_node("apply", apply_node)
    builder.add_node("interrupt", edit_interrupt_node)
    builder.add_node("tier3", edit_tier3_bridge_node)

    builder.add_edge(START, "classify")
    builder.add_conditional_edges("classify", _tier_route, {
        "apply": "apply",
        "locate": "locate",
        "tier3": "tier3",
        "end": END,
    })
    builder.add_conditional_edges("locate", _locate_route, {
        "apply": "apply",
        "end": END,
    })
    builder.add_conditional_edges("apply", _apply_route, {
        "interrupt": "interrupt",
        "end": END,
    })
    builder.add_edge("interrupt", END)
    builder.add_edge("tier3", END)

    return builder
