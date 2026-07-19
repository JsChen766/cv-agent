"""Resume Generation subgraph."""

from __future__ import annotations

from typing import Any, Protocol

from langgraph.graph import END, START, StateGraph

from app.graphs.resume.nodes import (
    batch_candidate_generation_node,
    batch_candidate_generation_route,
    browser_layout_gate_node,
    browser_layout_gate_route,
    content_gap_node,
    content_gap_route,
    context_assembly_node,
    cot_planning_node,
    coverage_check_node,
    draft_generation_node,
    experience_selection_node,
    fact_check_node,
    layout_measure_node,
    layout_revision_node,
    layout_route,
    material_sufficiency_node,
    material_sufficiency_route,
    output_failure_node,
    output_node,
    output_route,
    persist_resume_draft_node,
    quality_gate_node,
    quality_gate_route,
    resume_planning_node,
    resume_planning_route,
    review_route,
    revision_node,
    self_review_node,
)
from app.graphs.resume.state import ResumeGenerationState
from app.graphs.tracing import traced_node

RESUME_NODE_DEFINITIONS = {
    "batch_candidate_generation": batch_candidate_generation_node,
    "context_assembly": context_assembly_node,
    "material_sufficiency": material_sufficiency_node,
    "resume_planning": resume_planning_node,
    "experience_selection": experience_selection_node,
    "cot_planning": cot_planning_node,
    "draft_generation": draft_generation_node,
    "layout_measure": layout_measure_node,
    "layout_revision": layout_revision_node,
    "fact_check": fact_check_node,
    "coverage_check": coverage_check_node,
    "self_review": self_review_node,
    "revision": revision_node,
    "quality_gate": quality_gate_node,
    "persist_draft": persist_resume_draft_node,
    "browser_layout_gate": browser_layout_gate_node,
    "output": output_node,
    "output_failure": output_failure_node,
    "content_gap": content_gap_node,
}


class _NodeBuilder(Protocol):
    def add_node(self, node: str, action: Any) -> Any: ...


def add_traced_resume_nodes(builder: _NodeBuilder) -> None:
    for node_name, node in RESUME_NODE_DEFINITIONS.items():
        builder.add_node(node_name, traced_node(node_name, node))


def build_resume_subgraph() -> StateGraph[ResumeGenerationState]:
    builder = StateGraph(ResumeGenerationState)

    add_traced_resume_nodes(builder)

    builder.add_edge(START, "context_assembly")
    builder.add_edge("context_assembly", "material_sufficiency")
    builder.add_conditional_edges(
        "material_sufficiency",
        material_sufficiency_route,
        {
            "experience_selection": "experience_selection",
            "resume_planning": "resume_planning",
            "content_gap": "content_gap",
            "failed": "output_failure",
        },
    )
    builder.add_conditional_edges(
        "resume_planning",
        resume_planning_route,
        {
            "batch_generation": "batch_candidate_generation",
            "draft_generation": "draft_generation",
            "failed": "output_failure",
        },
    )
    builder.add_conditional_edges(
        "batch_candidate_generation",
        batch_candidate_generation_route,
        {
            "layout_measure": "layout_measure",
            "failed": "output_failure",
        },
    )
    builder.add_edge("experience_selection", "cot_planning")
    builder.add_edge("cot_planning", "draft_generation")
    builder.add_edge("draft_generation", "layout_measure")
    builder.add_conditional_edges(
        "layout_measure",
        layout_route,
        {
            "revision": "layout_revision",
            "fact_check": "fact_check",
            "content_gap": "content_gap",
            "failed": "output_failure",
        },
    )
    builder.add_edge("layout_revision", "layout_measure")
    builder.add_edge("fact_check", "coverage_check")
    builder.add_edge("coverage_check", "self_review")
    builder.add_conditional_edges(
        "self_review",
        review_route,
        {"revision": "revision", "quality_gate": "quality_gate"},
    )
    builder.add_edge("revision", "draft_generation")  # re-generate after revision
    builder.add_conditional_edges(
        "quality_gate",
        quality_gate_route,
        {
            "passed": "persist_draft",
            "failed": "output_failure",
        },
    )
    builder.add_edge("persist_draft", "browser_layout_gate")
    builder.add_conditional_edges(
        "browser_layout_gate",
        browser_layout_gate_route,
        {
            "passed": "output",
            "repair": "layout_revision",
            "failed": "output_failure",
        },
    )
    builder.add_edge("output_failure", END)
    builder.add_conditional_edges(
        "content_gap",
        content_gap_route,
        {
            "reload": "context_assembly",
            "fact_check": "fact_check",
            "failed": "output_failure",
            "end": END,
        },
    )
    builder.add_conditional_edges(
        "output",
        output_route,
        {
            "batch_generation": "batch_candidate_generation",
            "revision": "draft_generation",
            "end": END,
        },
    )

    return builder
