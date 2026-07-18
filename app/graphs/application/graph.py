from __future__ import annotations

from typing import Any, cast

from langgraph.graph import END, START, StateGraph

from app.graphs.application.nodes import (
    generate_application_artifacts_node,
    plan_application_package_node,
)
from app.graphs.application.state import ApplicationPackageState
from app.graphs.resume.graph import build_resume_subgraph
from app.graphs.resume.nodes import context_assembly_node
from app.graphs.tracing import traced_node


def build_application_package_subgraph() -> StateGraph[ApplicationPackageState]:
    builder = StateGraph(ApplicationPackageState)
    builder.add_node(
        "context_assembly",
        cast(Any, traced_node("context_assembly", context_assembly_node)),
    )
    builder.add_node(
        "package_plan",
        cast(Any, traced_node("package_plan", plan_application_package_node)),
    )
    builder.add_node(
        "package_artifacts",
        cast(Any, traced_node("package_artifacts", generate_application_artifacts_node)),
    )
    builder.add_node("resume_generation", build_resume_subgraph().compile())

    builder.add_edge(START, "context_assembly")
    builder.add_edge("context_assembly", "package_plan")
    builder.add_edge("package_plan", "package_artifacts")
    builder.add_edge("package_artifacts", "resume_generation")
    builder.add_edge("resume_generation", END)
    return builder
