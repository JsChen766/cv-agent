from __future__ import annotations

from datetime import date

from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.retrieval.models import (
    FactScoreBreakdown,
    HybridRetrievalResult,
    RankedFact,
    RetrievalDiagnostics,
    RetrievalExperience,
    RetrievalRequirement,
)
from app.domain.resume.sufficiency.service import MaterialSufficiencyService
from app.infra.layout import PillowFontMetrics


def _experience(
    experience_id: str,
    *,
    category: str = "work",
    content: str = "负责后端系统开发",
) -> RetrievalExperience:
    return RetrievalExperience(
        experience_id=experience_id,
        revision_id=f"rev-{experience_id}",
        revision_hash="hash",
        title="后端工程师" if category != "education" else "计算机科学",
        organization="示例公司" if category != "education" else "示例大学",
        role="工程师" if category != "education" else None,
        category=category,
        start_date=date(2022, 1, 1),
        end_date=date(2024, 1, 1),
        tags=("Python",),
        content=content,
        factbank_status="ready",
    )


def _fact(
    fact_id: str,
    experience_id: str,
    *,
    text: str | None = None,
    selected: bool = False,
    matched: bool = True,
    strength: float = 0.8,
) -> RankedFact:
    return RankedFact(
        fact_id=fact_id,
        experience_id=experience_id,
        source_revision_id=f"rev-{experience_id}",
        source_text=text or f"使用 Python 完成模块 {fact_id} 的设计、开发与交付",
        technologies=("Python",),
        selected=selected,
        score=FactScoreBreakdown(
            semantic_similarity=0.8 if matched else 0.0,
            lexical_technology_match=0.8 if matched else 0.0,
            uncovered_requirement_gain=0.5 if matched else 0.0,
            evidence_strength=strength,
            recency=0.5,
            weighted_total=0.65 if matched else 0.08,
        ),
        marginal_value=0.7 if matched else 0.08,
        matched_requirement_ids=("req-python",) if matched else (),
        selection_reasons=("highest_marginal_value",) if selected else (),
        rejection_reasons=() if selected else ("candidate_limit_reached",),
    )


def _retrieval(
    experiences: list[RetrievalExperience],
    facts: list[RankedFact],
    *,
    warnings: tuple[str, ...] = (),
) -> HybridRetrievalResult:
    return HybridRetrievalResult(
        requirements=(
            RetrievalRequirement(
                requirement_id="req-python",
                description="Python 后端开发",
                category="technology",
                keywords=("Python",),
                importance="must_have",
                weight=1.0,
            ),
        ),
        experiences=tuple(experiences),
        facts=tuple(facts),
        selected_fact_ids=tuple(value.fact_id for value in facts if value.selected),
        diagnostics=RetrievalDiagnostics(
            total_experiences=len(experiences),
            total_facts=len(facts),
            selected_facts=sum(value.selected for value in facts),
            ready_facts=len(facts),
            fallback_facts=0,
            warnings=warnings,
            ranking_version="test",
        ),
    )


def _service() -> MaterialSufficiencyService:
    return MaterialSufficiencyService(ResumeLayoutService(PillowFontMetrics()))


def test_full_factbank_can_be_sufficient_even_when_only_two_facts_were_selected() -> None:
    experiences = [_experience(f"exp-{index}") for index in range(5)]
    facts = [
        _fact(
            f"fact-{index}",
            f"exp-{index % 5}",
            selected=index < 2,
            text=(
                f"使用 Python 负责第 {index} 个独立模块的需求分析、接口设计、实现与验证，"
                "形成可交付成果"
            ),
        )
        for index in range(45)
    ]

    result = _service().assess(
        _retrieval(experiences, facts),
        user_profile={"full_name": "测试用户", "email": "user@example.com"},
        minimum_usage_ratio=0.85,
    )

    assert result.status == "sufficient"
    assert result.qualified_facts == 45
    assert sum(
        value.qualified for value in result.fact_estimates if not value.fact_id.endswith("0")
    )
    assert result.global_supported_height_mm >= result.minimum_required_height_mm


def test_truly_sparse_factbank_reports_exact_positive_gap() -> None:
    result = _service().assess(
        _retrieval([_experience("exp-1")], [_fact("fact-1", "exp-1", selected=True)]),
        user_profile={"full_name": "测试用户"},
        minimum_usage_ratio=0.85,
    )

    assert result.status == "insufficient"
    assert result.missing_height_mm == round(
        result.minimum_required_height_mm - result.global_supported_height_mm,
        3,
    )
    assert result.approximate_missing_lines > 0


def test_duplicate_source_fact_is_not_counted_twice() -> None:
    duplicate_text = "使用 Python 构建接口并完成上线验证"
    result = _service().assess(
        _retrieval(
            [_experience("exp-1"), _experience("exp-2")],
            [
                _fact("fact-1", "exp-1", text=duplicate_text),
                _fact("fact-2", "exp-2", text=duplicate_text),
            ],
        ),
        user_profile=None,
        minimum_usage_ratio=0.85,
    )

    assert result.qualified_facts == 1
    duplicate = next(value for value in result.fact_estimates if value.fact_id == "fact-2")
    assert duplicate.exclusion_reasons == ("duplicate_source_fact",)


def test_education_and_skills_are_counted_as_fixed_height() -> None:
    result = _service().assess(
        _retrieval(
            [
                _experience("edu-1", category="education", content="主修课程：算法与数据库"),
                _experience("exp-1"),
            ],
            [_fact("fact-1", "exp-1")],
        ),
        user_profile={"full_name": "测试用户", "phone": "13800000000"},
        minimum_usage_ratio=0.85,
    )

    assert result.fixed_height.contact_height_mm > 0
    assert result.fixed_height.education_height_mm > 0
    assert result.fixed_height.skills_height_mm > 0
    assert result.fixed_height.total_height_mm > result.fixed_height.contact_height_mm


def test_relevance_blind_mode_uses_evidence_strength_without_recency() -> None:
    facts = [_fact("fact-strong", "exp-1", matched=False, strength=0.9)]
    result = _service().assess(
        _retrieval(
            [_experience("exp-1")],
            facts,
            warnings=(
                "semantic_similarity_all_zero",
                "lexical_technology_match_all_zero",
                "uncovered_requirement_gain_all_zero",
            ),
        ),
        user_profile=None,
        minimum_usage_ratio=0.85,
    )

    estimate = result.fact_estimates[0]
    assert estimate.qualified is True
    assert estimate.qualification_reasons == ("evidence_strength_fallback",)
