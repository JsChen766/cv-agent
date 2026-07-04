"""Resume Generation subgraph."""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.graphs.resume.nodes import (
    context_assembly_node,
    cot_planning_node,
    draft_generation_node,
    output_node,
    review_route,
    revision_node,
    self_review_node,
)
from app.graphs.resume.state import ResumeGenerationState


def build_resume_subgraph() -> StateGraph:
    builder = StateGraph(ResumeGenerationState)

    builder.add_node("context_assembly", context_assembly_node)
    builder.add_node("cot_planning", cot_planning_node)
    builder.add_node("draft_generation", draft_generation_node)
    builder.add_node("self_review", self_review_node)
    builder.add_node("revision", revision_node)
    builder.add_node("output", output_node)

    builder.add_edge(START, "context_assembly")
    builder.add_edge("context_assembly", "cot_planning")
    builder.add_edge("cot_planning", "draft_generation")
    builder.add_edge("draft_generation", "self_review")
    builder.add_conditional_edges("self_review", review_route, {"revision": "revision", "output": "output"})
    builder.add_edge("revision", "draft_generation")  # re-generate after revision
    builder.add_edge("output", END)

    return builder
