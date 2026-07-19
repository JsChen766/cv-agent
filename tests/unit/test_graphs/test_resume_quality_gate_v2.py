from __future__ import annotations

import pytest

from app.domain.resume.layout_service import ResumeLayoutService
from app.graphs.resume.nodes import (
    deterministic_quality_gate_node,
    deterministic_quality_gate_route,
    local_candidate_repair_node,
    local_candidate_repair_route,
)
from app.infra.layout import PillowFontMetrics
from app.tools.base import ServiceContainer
from tests.unit.test_domain.test_resume_quality_gate import (
    _BoundedRepairProvider,
    _fixture,
)


async def test_v2_quality_node_passes_without_legacy_self_review() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture()

    result = await deterministic_quality_gate_node(
        {
            "resume_plan": plan.model_dump(mode="json"),
            "fact_retrieval_result": retrieval.model_dump(mode="json"),
            "resume_candidate_bullets": [value.model_dump(mode="json") for value in candidates],
            "compiled_resume": compiled.model_dump(mode="json"),
            "layout_constraint": constraint.model_dump(mode="json"),
        }
    )

    assert result["quality_validation_status"] == "passed"
    assert result["quality_status"] == "passed"
    assert deterministic_quality_gate_route(result) == "passed"


async def test_v2_quality_node_repairs_once_then_returns_to_compiler(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture(fit_status="awkward_wrap")
    state = {
        "resume_plan": plan.model_dump(mode="json"),
        "fact_retrieval_result": retrieval.model_dump(mode="json"),
        "resume_candidate_bullets": [value.model_dump(mode="json") for value in candidates],
        "compiled_resume": compiled.model_dump(mode="json"),
        "layout_constraint": constraint.model_dump(mode="json"),
        "quality_local_repair_call_count": 0,
        "quality_local_repair_provider_attempts": 0,
        "generation_call_count": 1,
    }
    validated = await deterministic_quality_gate_node(state)  # type: ignore[arg-type]
    provider = _BoundedRepairProvider()
    monkeypatch.setattr("app.graphs.resume.nodes.get_provider", lambda: provider)
    services = ServiceContainer.model_construct(
        resume_layout=ResumeLayoutService(PillowFontMetrics())
    )

    repaired = await local_candidate_repair_node(
        {**state, **validated},  # type: ignore[arg-type]
        {"configurable": {"services": services}},
    )

    assert repaired["quality_local_repair_status"] == "applied"
    assert repaired["quality_local_repair_call_count"] == 1
    assert repaired["quality_local_repair_provider_attempts"] == 1
    assert local_candidate_repair_route(repaired) == "layout_compile"
    assert provider.calls == [(15.0, 1)]


def test_v2_quality_route_fails_after_single_repair_budget_is_consumed() -> None:
    assert (
        deterministic_quality_gate_route(
            {
                "quality_validation_status": "repairable",
                "quality_local_repair_call_count": 1,
            }
        )
        == "failed"
    )
