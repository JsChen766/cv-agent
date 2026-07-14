from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.graphs.application.nodes import (
    generate_application_artifacts_node,
    plan_application_package_node,
)
from app.graphs.application.state import ApplicationPackageState
from app.graphs.resume.nodes import (
    context_assembly_node,
    cot_planning_node,
    draft_generation_node,
    output_node,
    output_route,
    persist_resume_draft_node,
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
    builder.add_node("self_review", self_review_node)
    builder.add_node("revision", revision_node)
    builder.add_node("persist_draft", persist_resume_draft_node)
    builder.add_node("output", output_node)

    builder.add_edge(START, "context_assembly")
    builder.add_edge("context_assembly", "package_plan")
    builder.add_edge("package_plan", "package_artifacts")
    builder.add_edge("package_artifacts", "cot_planning")
    builder.add_edge("cot_planning", "draft_generation")
    builder.add_edge("draft_generation", "self_review")
    builder.add_conditional_edges(
        "self_review", review_route, {"revision": "revision", "output": "persist_draft"}
    )
    builder.add_edge("revision", "draft_generation")
    builder.add_edge("persist_draft", "output")
    builder.add_conditional_edges(
        "output", output_route, {"revision": "draft_generation", "end": END}
    )
    return builder
