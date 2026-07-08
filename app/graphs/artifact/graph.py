"""Artifact Generation subgraph."""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.graphs.artifact.nodes import artifact_context_assembly_node, artifact_draft_node
from app.graphs.state import MainState


def build_artifact_subgraph() -> StateGraph[MainState]:
    builder = StateGraph(MainState)
    builder.add_node("context_assembly", artifact_context_assembly_node)
    builder.add_node("draft_generation", artifact_draft_node)
    builder.add_edge(START, "context_assembly")
    builder.add_edge("context_assembly", "draft_generation")
    builder.add_edge("draft_generation", END)
    return builder
