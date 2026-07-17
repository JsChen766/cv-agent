from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.graphs.application.nodes import (
    generate_application_artifacts_node,
    plan_application_package_node,
)
from app.graphs.application.state import ApplicationPackageState
from app.graphs.resume.nodes import (
    content_gap_node,
    content_gap_route,
    context_assembly_node,
    cot_planning_node,
    coverage_check_node,
    draft_generation_node,
    fact_check_node,
    layout_measure_node,
    layout_revision_node,
    layout_route,
    output_failure_node,
    output_node,
    output_route,
    persist_decision_candidate_node,
    persist_resume_draft_node,
    quality_gate_node,
    quality_gate_route,
    review_route,
    revision_node,
    self_review_node,
)


def build_application_package_subgraph() -> StateGraph[ApplicationPackageState]:
    builder = StateGraph(ApplicationPackageState)
    builder.add_node("context_assembly", context_assembly_node)
    builder.add_node("package_plan", plan_application_package_node)
    builder.add_node("package_artifacts", generate_application_artifacts_node)
    builder.add_node("cot_planning", cot_planning_node)
    builder.add_node("draft_generation", draft_generation_node)
    builder.add_node("layout_measure", layout_measure_node)
    builder.add_node("layout_revision", layout_revision_node)
    builder.add_node("fact_check", fact_check_node)
    builder.add_node("coverage_check", coverage_check_node)
    builder.add_node("self_review", self_review_node)
    builder.add_node("revision", revision_node)
    builder.add_node("quality_gate", quality_gate_node)
    builder.add_node("persist_draft", persist_resume_draft_node)
    builder.add_node("persist_decision_candidate", persist_decision_candidate_node)
    builder.add_node("output", output_node)
    builder.add_node("output_for_decision", output_node)
    builder.add_node("output_failure", output_failure_node)
    builder.add_node("content_gap", content_gap_node)

    builder.add_edge(START, "context_assembly")
    builder.add_edge("context_assembly", "package_plan")
    builder.add_edge("package_plan", "package_artifacts")
    builder.add_edge("package_artifacts", "cot_planning")
    builder.add_edge("cot_planning", "draft_generation")
    builder.add_edge("draft_generation", "layout_measure")
    builder.add_conditional_edges(
        "layout_measure",
        layout_route,
        {
            "revision": "layout_revision",
            "fact_check": "fact_check",
            "content_gap": "content_gap",
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
    builder.add_edge("revision", "draft_generation")
    builder.add_conditional_edges(
        "quality_gate",
        quality_gate_route,
        {
            "passed": "persist_draft",
            "needs_user_decision": "persist_decision_candidate",
            "failed": "output_failure",
        },
    )
    builder.add_edge("persist_draft", "output")
    builder.add_edge("persist_decision_candidate", "output_for_decision")
    builder.add_edge("output_failure", END)
    builder.add_conditional_edges(
        "content_gap",
        content_gap_route,
        {"revision": "cot_planning", "end": END},
    )
    builder.add_conditional_edges(
        "output", output_route, {"revision": "draft_generation", "end": END}
    )
    builder.add_conditional_edges(
        "output_for_decision",
        output_route,
        {"revision": "draft_generation", "end": END},
    )
    return builder
