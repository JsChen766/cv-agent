from __future__ import annotations

import json
from datetime import date

import pytest

from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.retrieval.models import (
    FactScoreBreakdown,
    HybridRetrievalResult,
    RankedFact,
    RetrievalDiagnostics,
    RetrievalExperience,
    RetrievalRequirement,
)
from app.graphs.resume.nodes import (
    batch_candidate_generation_node,
    batch_candidate_generation_route,
    content_gap_node,
    content_gap_route,
    deterministic_quality_gate_node,
    layout_compile_node,
    layout_compile_route,
    material_sufficiency_node,
    material_sufficiency_route,
    resume_planning_node,
    resume_planning_route,
    review_route,
)
from app.infra.layout import PillowFontMetrics
from app.providers.base import StructuredCallBudgetError, StructuredCallResult
from app.tools.base import ServiceContainer


class _BatchProvider:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls = 0

    async def chat_structured_bounded(
        self,
        messages: list[dict[str, str]],
        schema: type,
        **kwargs: object,
    ) -> StructuredCallResult:
        self.calls += 1
        if self.fail:
            raise StructuredCallBudgetError(
                "provider timeout",
                attempts=2,
                protocol="test_json_schema",
                error_category="TimeoutError",
            )
        payload = json.loads(messages[1]["content"])
        facts = {value["fact_id"]: value for value in payload["facts"]}
        groups = [
            {
                "experience_id": facts[fact_id]["experience_id"],
                "source_fact_ids": [fact_id],
                "covered_requirement_ids": facts[fact_id]["matched_requirement_ids"],
                "variants": [
                    {
                        "length_variant": "short",
                        "text": facts[fact_id]["source_text"],
                    },
                    {
                        "length_variant": "medium",
                        "text": facts[fact_id]["source_text"],
                    },
                    {
                        "length_variant": "long",
                        "text": facts[fact_id]["source_text"],
                    },
                ],
            }
            for fact_id in payload["selected_fact_ids"]
        ]
        return StructuredCallResult(
            value=schema.model_validate({"groups": groups}),
            attempts=1,
            protocol="test_json_schema",
        )


def _retrieval(fact_count: int) -> dict[str, object]:
    experience = RetrievalExperience(
        experience_id="exp-1",
        revision_id="rev-1",
        revision_hash="hash",
        title="后端工程师",
        organization="示例公司",
        category="work",
        start_date=date(2022, 1, 1),
        end_date=date(2024, 1, 1),
        tags=("Python",),
        content="负责后端开发",
        factbank_status="ready",
    )
    facts = tuple(
        RankedFact(
            fact_id=f"fact-{index}",
            experience_id="exp-1",
            source_revision_id="rev-1",
            source_text=(f"使用 Python 完成第 {index} 个独立模块的设计、开发、测试和交付"),
            technologies=(f"Python-{index}",),
            selected=index < 2,
            score=FactScoreBreakdown(
                semantic_similarity=0.9,
                lexical_technology_match=0.8,
                uncovered_requirement_gain=0.5,
                evidence_strength=0.8,
                recency=0.5,
                weighted_total=0.7,
            ),
            marginal_value=0.7,
            matched_requirement_ids=("req-python",),
        )
        for index in range(fact_count)
    )
    return HybridRetrievalResult(
        requirements=(
            RetrievalRequirement(
                requirement_id="req-python",
                description="Python",
                category="technology",
                keywords=("Python",),
                importance="must_have",
                weight=1.0,
            ),
        ),
        experiences=(experience,),
        facts=facts,
        selected_fact_ids=tuple(value.fact_id for value in facts if value.selected),
        diagnostics=RetrievalDiagnostics(
            total_experiences=1,
            total_facts=fact_count,
            selected_facts=min(2, fact_count),
            ready_facts=fact_count,
            fallback_facts=0,
            ranking_version="test",
        ),
    ).model_dump(mode="json")


def _config() -> dict[str, object]:
    services = ServiceContainer.model_construct(
        resume_layout=ResumeLayoutService(PillowFontMetrics())
    )
    return {"configurable": {"services": services}}


async def test_material_sufficiency_node_uses_all_retrieved_facts() -> None:
    result = await material_sufficiency_node(
        {
            "fact_retrieval_result": _retrieval(60),
            "user_profile": {"full_name": "测试用户"},
            "extracted_params": {"page_count": 1},
        },
        _config(),
    )

    assert result["material_sufficiency_status"] == "sufficient"
    report = result["material_sufficiency_report"]
    assert report["total_facts"] == 60
    assert report["qualified_facts"] == 60
    assert material_sufficiency_route(result) == "resume_planning"


async def test_material_sufficiency_routes_true_shortage_to_content_gap() -> None:
    result = await material_sufficiency_node(
        {
            "fact_retrieval_result": _retrieval(1),
            "user_profile": {"full_name": "测试用户"},
        },
        _config(),
    )

    assert result["material_sufficiency_status"] == "insufficient"
    assert material_sufficiency_route(result) == "content_gap"


async def test_resume_planning_node_is_the_only_v2_budget_authority() -> None:
    retrieval = _retrieval(60)
    assessed = await material_sufficiency_node(
        {
            "fact_retrieval_result": retrieval,
            "user_profile": {"full_name": "测试用户"},
        },
        _config(),
    )

    result = await resume_planning_node(
        {
            **assessed,
            "fact_retrieval_result": retrieval,
        },
        _config(),
    )

    assert result["resume_plan_status"] == "ready"
    assert resume_planning_route(result) == "batch_generation"
    assert result["experience_selection_result"]["selection_reason"] == (
        "projected_from_resume_plan"
    )
    plan_fact_ids = set(result["resume_plan"]["selected_fact_ids"])
    budget_fact_ids = {
        fact["id"]
        for experience in result["content_budget"]["experiences"]
        for fact in experience["facts"]
    }
    assert budget_fact_ids == plan_fact_ids


async def test_v2_generation_uses_one_complete_batch_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    retrieval = _retrieval(60)
    assessed = await material_sufficiency_node(
        {
            "fact_retrieval_result": retrieval,
            "user_profile": {"full_name": "测试用户"},
        },
        _config(),
    )
    planned = await resume_planning_node(
        {**assessed, "fact_retrieval_result": retrieval},
        _config(),
    )
    provider = _BatchProvider()
    monkeypatch.setattr("app.graphs.resume.nodes.get_provider", lambda: provider)

    result = await batch_candidate_generation_node(
        {
            **planned,
            "fact_retrieval_result": retrieval,
            "user_profile": {"full_name": "测试用户"},
            "pending_sse_events": [],
        },
        _config(),
    )

    assert provider.calls == 1
    assert result["candidate_generation_status"] == "ready"
    assert batch_candidate_generation_route(result) == "layout_compile"
    assert result["generation_strategy"] == "single_batch_candidate_pool"
    assert result["full_generation_call_count"] == 1
    diagnostics = result["candidate_generation_diagnostics"]
    assert diagnostics["physical_attempts"] == 1
    assert diagnostics["generation_source"] == "model"
    plan_fact_ids = set(planned["resume_plan"]["selected_fact_ids"])
    candidate_fact_ids = {
        fact_id
        for value in result["resume_candidate_bullets"]
        for fact_id in value["source_fact_ids"]
    }
    assert candidate_fact_ids == plan_fact_ids


async def test_v2_layout_compiler_consumes_complete_candidate_pool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    retrieval = _retrieval(60)
    assessed = await material_sufficiency_node(
        {"fact_retrieval_result": retrieval, "user_profile": {"full_name": "测试用户"}},
        _config(),
    )
    planned = await resume_planning_node(
        {**assessed, "fact_retrieval_result": retrieval},
        _config(),
    )
    monkeypatch.setattr("app.graphs.resume.nodes.get_provider", lambda: _BatchProvider())
    generated = await batch_candidate_generation_node(
        {
            **planned,
            "fact_retrieval_result": retrieval,
            "user_profile": {"full_name": "测试用户"},
            "pending_sse_events": [],
        },
        _config(),
    )
    candidates = generated["resume_candidate_bullets"]
    for candidate in candidates:
        multiplier = {"short": 1, "medium": 2, "long": 3}[candidate["length_variant"]]
        candidate["text"] = "，".join([candidate["text"]] * multiplier)

    def legacy_optimizer_must_not_run(*args: object, **kwargs: object) -> None:
        raise AssertionError("V2 compiler must not call ResumeLayoutOptimizer")

    monkeypatch.setattr(
        "app.graphs.resume.nodes.ResumeLayoutOptimizer.optimize",
        legacy_optimizer_must_not_run,
    )
    compiled = await layout_compile_node(
        {
            **planned,
            **generated,
            "resume_candidate_bullets": candidates,
        },
        _config(),
    )

    assert compiled["layout_compilation_status"] == "compiled"
    assert layout_compile_route(compiled) == "quality_validate"
    report = compiled["layout_report"]
    assert report["page_count"] == 1
    assert report["overflow_mm"] == 0
    assert 0.85 <= report["pages"][0]["usage_ratio"] <= 0.98
    selected = compiled["compiled_resume"]
    assert len(selected["selected_fact_ids"]) == len(set(selected["selected_fact_ids"]))
    assert compiled["selected_candidate_ids"]

    validated = await deterministic_quality_gate_node(
        {
            **planned,
            **generated,
            **compiled,
            "fact_retrieval_result": retrieval,
            "resume_candidate_bullets": candidates,
        }
    )
    assert validated["grounding_report"]["ungrounded_bullets"] == 0
    assert validated["coverage_report"]["must_have_coverage_ratio"] == 1.0
    assert {value["code"] for value in validated["quality_issues"]}.issubset(
        {"bullet_too_short", "bullet_awkward_wrap"}
    )


async def test_batch_failure_uses_grounded_fallback_after_two_attempt_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    retrieval = _retrieval(60)
    assessed = await material_sufficiency_node(
        {"fact_retrieval_result": retrieval, "user_profile": {"full_name": "测试用户"}},
        _config(),
    )
    planned = await resume_planning_node(
        {**assessed, "fact_retrieval_result": retrieval},
        _config(),
    )
    provider = _BatchProvider(fail=True)
    monkeypatch.setattr("app.graphs.resume.nodes.get_provider", lambda: provider)

    result = await batch_candidate_generation_node(
        {
            **planned,
            "fact_retrieval_result": retrieval,
            "user_profile": {"full_name": "测试用户"},
            "pending_sse_events": [],
        },
        _config(),
    )

    assert provider.calls == 1
    assert result["candidate_generation_status"] == "ready"
    assert result["full_generation_call_count"] == 2
    diagnostics = result["candidate_generation_diagnostics"]
    assert diagnostics["physical_attempts"] == 2
    assert diagnostics["generation_source"] == "deterministic_fallback"
    assert diagnostics["provider_error_category"] == "TimeoutError"


def test_v2_self_review_never_routes_to_complete_regeneration() -> None:
    assert (
        review_route(
            {
                "candidate_generation_status": "ready",
                "review_result": {"verdict": "needs_revision"},
                "review_iteration": 0,
                "generation_call_count": 1,
            }
        )
        == "quality_gate"
    )


async def test_incomplete_retrieval_metadata_fails_without_content_gap() -> None:
    retrieval = _retrieval(2)
    retrieval["experiences"] = []

    result = await material_sufficiency_node(
        {"fact_retrieval_result": retrieval},
        _config(),
    )

    assert result["material_sufficiency_status"] == "unavailable"
    assert result["quality_issues"][0]["code"] == "material_sufficiency_unavailable"
    assert material_sufficiency_route(result) == "failed"


async def test_truncated_fact_payload_fails_without_content_gap() -> None:
    retrieval = _retrieval(2)
    retrieval["facts"] = retrieval["facts"][:1]

    result = await material_sufficiency_node(
        {"fact_retrieval_result": retrieval},
        _config(),
    )

    assert result["material_sufficiency_status"] == "unavailable"
    assert result["quality_issues"][0]["message"] == "incomplete_retrieval_fact_payload"
    assert material_sufficiency_route(result) == "failed"


async def test_fact_revision_mismatch_fails_without_content_gap() -> None:
    retrieval = _retrieval(2)
    retrieval["facts"][0]["source_revision_id"] = "stale-revision"

    result = await material_sufficiency_node(
        {"fact_retrieval_result": retrieval},
        _config(),
    )

    assert result["material_sufficiency_status"] == "unavailable"
    assert result["quality_issues"][0]["message"] == "fact_revision_ownership_mismatch"
    assert material_sufficiency_route(result) == "failed"


async def test_content_gap_is_blocked_when_full_factbank_is_sufficient() -> None:
    assessed = await material_sufficiency_node(
        {
            "fact_retrieval_result": _retrieval(60),
            "user_profile": {"full_name": "测试用户"},
        },
        _config(),
    )
    result = await content_gap_node(assessed)

    assert result["resume_user_action"] == "failed"
    assert result["quality_issues"][0]["code"] == "sufficiency_invariant_violation"
    assert content_gap_route(result) == "failed"


async def test_second_material_gap_does_not_interrupt_again() -> None:
    assessed = await material_sufficiency_node(
        {
            "fact_retrieval_result": _retrieval(1),
            "user_profile": {"full_name": "测试用户"},
        },
        _config(),
    )
    result = await content_gap_node(
        {
            **assessed,
            "content_gap_interaction_count": 1,
        }
    )

    assert result["resume_user_action"] == "failed"
    assert result["quality_issues"][0]["code"] == ("material_still_insufficient_after_supplement")


async def test_true_shortage_emits_one_directional_requirement_question(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assessed = await material_sufficiency_node(
        {
            "fact_retrieval_result": _retrieval(1),
            "user_profile": {"full_name": "测试用户"},
        },
        _config(),
    )
    assessed["material_sufficiency_report"]["uncovered_must_have_requirement_ids"] = ["req-missing"]
    captured: dict[str, object] = {}

    def fake_interrupt(payload: dict[str, object]) -> dict[str, str]:
        captured.update(payload)
        return {"action": "cancel"}

    monkeypatch.setattr("langgraph.types.interrupt", fake_interrupt)
    result = await content_gap_node(
        {
            **assessed,
            "fact_retrieval_result": _retrieval(1),
            "jd_requirements": [
                {"id": "req-missing", "text": "分布式系统经验", "importance": "high"}
            ],
        }
    )

    assert captured["type"] == "resume_content_gap"
    assert captured["missing_requirement_ids"] == ["req-missing"]
    suggestions = captured["suggestions"]
    assert "分布式系统经验" in suggestions[0]["questions"][0]
    assert result["resume_user_action"] == "complete"
