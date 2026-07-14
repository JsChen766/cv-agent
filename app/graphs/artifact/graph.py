"""Artifact Generation subgraph."""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.graphs.artifact.nodes import (
    artifact_context_assembly_node,
    artifact_coverage_check_node,
    artifact_draft_node,
    artifact_fact_check_node,
    artifact_persist_node,
    artifact_review_route,
    artifact_revision_node,
    artifact_self_review_node,
)
from app.graphs.state import MainState


def build_artifact_subgraph() -> StateGraph[MainState]:
    builder = StateGraph(MainState)
    builder.add_node("context_assembly", artifact_context_assembly_node)
    builder.add_node("draft_generation", artifact_draft_node)
    builder.add_node("fact_check", artifact_fact_check_node)
    builder.add_node("coverage_check", artifact_coverage_check_node)
    builder.add_node("self_review", artifact_self_review_node)
    builder.add_node("revision", artifact_revision_node)
    builder.add_node("persist", artifact_persist_node)

    builder.add_edge(START, "context_assembly")
    builder.add_edge("context_assembly", "draft_generation")
    builder.add_edge("draft_generation", "fact_check")
    builder.add_edge("fact_check", "coverage_check")
    builder.add_edge("coverage_check", "self_review")
    builder.add_conditional_edges(
        "self_review", artifact_review_route, {"revision": "revision", "end": "persist"}
    )
    builder.add_edge("revision", "draft_generation")
    builder.add_edge("persist", END)
    return builder
