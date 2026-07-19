from __future__ import annotations

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
    content_gap_node,
    content_gap_route,
    material_sufficiency_node,
    material_sufficiency_route,
)
from app.infra.layout import PillowFontMetrics
from app.tools.base import ServiceContainer


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
            technologies=("Python",),
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
    assert material_sufficiency_route(result) == "experience_selection"


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
