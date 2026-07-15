"""Artifact Generation subgraph.

Uses a tool-assisted LLM approach: the model explicitly calls list_experiences /
get_experience to fetch the user's real data, then generates free-form markdown.
No structured JSON schemas — eliminates hallucination from prompt-injection-only
approaches.
"""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.graphs.artifact.nodes import artifact_generate_node
from app.graphs.state import MainState


def build_artifact_subgraph() -> StateGraph[MainState]:
    builder = StateGraph(MainState)
    builder.add_node("generate", artifact_generate_node)
    builder.add_edge(START, "generate")
    builder.add_edge("generate", END)
    return builder
