from __future__ import annotations

from datetime import date

from app.domain.resume.candidates.models import CandidateBatchDraft
from app.domain.resume.candidates.service import (
    CandidatePoolService,
    plan_incremental_candidate_reuse,
)
from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.planning.models import ResumePlan
from app.domain.resume.retrieval.models import (
    FactScoreBreakdown,
    HybridRetrievalResult,
    RankedFact,
    RetrievalDiagnostics,
    RetrievalExperience,
    RetrievalRequirement,
)
from app.infra.layout import PillowFontMetrics


def candidate_inputs() -> tuple[ResumePlan, HybridRetrievalResult]:
    requirement = RetrievalRequirement(
        requirement_id="req-python",
        description="Python backend engineering",
        category="technology",
        keywords=("Python",),
        importance="must_have",
        weight=1.0,
    )
    experiences = (
        RetrievalExperience(
            experience_id="exp-work",
            revision_id="rev-work",
            revision_hash="hash-work",
            title="Backend Engineer",
            organization="Example",
            role="Engineer",
            category="work",
            start_date=date(2022, 1, 1),
            end_date=date(2024, 1, 1),
            tags=("Python",),
            content="Built grounded backend systems",
            factbank_status="ready",
        ),
        RetrievalExperience(
            experience_id="exp-education",
            revision_id="rev-education",
            revision_hash="hash-education",
            title="Computer Science",
            organization="Example University",
            category="education",
            start_date=date(2018, 1, 1),
            end_date=date(2022, 1, 1),
            content="BSc Computer Science",
            factbank_status="ready",
        ),
    )
    facts = tuple(
        RankedFact(
            fact_id=f"fact-{index}",
            experience_id="exp-work",
            source_revision_id="rev-work",
            source_text=text,
            technologies=("Python",),
            selected=True,
            score=FactScoreBreakdown(
                semantic_similarity=0.9,
                lexical_technology_match=0.8,
                uncovered_requirement_gain=0.5,
                evidence_strength=0.8,
                recency=0.5,
                weighted_total=0.75,
            ),
            marginal_value=0.75,
            matched_requirement_ids=("req-python",),
        )
        for index, text in enumerate(
            (
                "使用 Python 设计并交付订单处理服务，建立自动化测试与发布流程",
                "优化数据库查询和缓存策略，降低核心接口响应延迟",
            ),
            start=1,
        )
    )
    retrieval = HybridRetrievalResult(
        requirements=(requirement,),
        experiences=experiences,
        facts=facts,
        selected_fact_ids=("fact-1", "fact-2"),
        diagnostics=RetrievalDiagnostics(
            total_experiences=2,
            total_facts=2,
            selected_facts=2,
            ready_facts=2,
            fallback_facts=0,
            ranking_version="test",
        ),
    )
    plan = ResumePlan(
        plan_version="test-plan",
        requirements=(requirement,),
        selected_experience_ids=("exp-work", "exp-education"),
        selected_fact_ids=("fact-1", "fact-2"),
        fact_requirement_map={
            "fact-1": ("req-python",),
            "fact-2": ("req-python",),
        },
        section_height_budgets_mm={"contact": 10.0, "education": 20.0, "work": 60.0},
        experience_height_budgets_mm={"exp-work": 55.0},
        target_candidate_lines=4,
        target_final_usage_ratio=0.9,
        estimated_page_height_mm=90.0,
        estimated_usage_ratio=0.9,
        objective_score=0.8,
        selection_reasons={"fact-1": ("selected",), "fact-2": ("selected",)},
        rejection_reasons={},
    )
    return plan, retrieval


def test_candidate_pool_rejects_unknown_grounding_and_fills_missing_fact() -> None:
    plan, retrieval = candidate_inputs()
    draft = CandidateBatchDraft.model_validate(
        {
            "groups": [
                {
                    "experience_id": "exp-work",
                    "source_fact_ids": ["fact-1"],
                    "covered_requirement_ids": ["req-python", "invented-requirement"],
                    "variants": [
                        {"length_variant": "short", "text": "使用 Python 交付订单服务。"},
                        {
                            "length_variant": "medium",
                            "text": "使用 Python 设计并交付订单处理服务，建立自动化测试流程",
                        },
                        {
                            "length_variant": "long",
                            "text": "使用 Python 设计并交付订单处理服务，建立自动化测试与发布流程",
                        },
                    ],
                },
                {
                    "experience_id": "exp-work",
                    "source_fact_ids": ["unknown-fact"],
                    "variants": [{"length_variant": "medium", "text": "invented"}],
                },
            ]
        }
    )

    pool = CandidatePoolService(ResumeLayoutService(PillowFontMetrics())).build(
        plan,
        retrieval,
        draft,
        language="zh-CN",
        candidate_pool_target_ratio=1.2,
        physical_attempts=1,
        provider_protocol="json_schema",
    )

    assert pool.diagnostics.accepted_model_groups == 1
    assert pool.diagnostics.rejected_model_groups == 1
    assert pool.diagnostics.fallback_groups == 1
    assert pool.diagnostics.generation_source == "mixed"
    assert {value.source_fact_ids for value in pool.candidates} == {
        ("fact-1",),
        ("fact-2",),
    }
    fact_one = [value for value in pool.candidates if value.source_fact_ids == ("fact-1",)]
    assert {value.length_variant for value in fact_one} == {"short", "medium", "long"}
    assert all(value.covered_requirement_ids == ("req-python",) for value in fact_one)
    assert all(not value.text.endswith("。") for value in pool.candidates)


def test_deterministic_fallback_is_stable_and_fully_grounded() -> None:
    plan, retrieval = candidate_inputs()
    service = CandidatePoolService(ResumeLayoutService(PillowFontMetrics()))

    first = service.build(
        plan,
        retrieval,
        None,
        language="zh-CN",
        candidate_pool_target_ratio=1.2,
        physical_attempts=2,
        provider_protocol=None,
        provider_error_category="TimeoutError",
    )
    second = service.build(
        plan,
        retrieval,
        None,
        language="zh-CN",
        candidate_pool_target_ratio=1.2,
        physical_attempts=2,
        provider_protocol=None,
        provider_error_category="TimeoutError",
    )

    assert first == second
    assert first.diagnostics.generation_source == "deterministic_fallback"
    assert first.diagnostics.physical_attempts == 2
    assert first.diagnostics.provider_error_category == "TimeoutError"
    assert {value.source_fact_ids for value in first.candidates} == {
        ("fact-1",),
        ("fact-2",),
    }
    assert all(value.length_variant == "medium" for value in first.candidates)


def test_candidate_pool_rejects_variant_with_unsourced_number() -> None:
    plan, retrieval = candidate_inputs()
    draft = CandidateBatchDraft.model_validate(
        {
            "groups": [
                {
                    "experience_id": "exp-work",
                    "source_fact_ids": ["fact-1"],
                    "covered_requirement_ids": ["req-python"],
                    "variants": [
                        {
                            "length_variant": "short",
                            "text": "使用 Python 交付订单服务",
                        },
                        {
                            "length_variant": "long",
                            "text": "使用 Python 交付订单服务，性能提升99%",
                        },
                    ],
                }
            ]
        }
    )

    pool = CandidatePoolService(ResumeLayoutService(PillowFontMetrics())).build(
        plan,
        retrieval,
        draft,
        language="zh-CN",
        candidate_pool_target_ratio=1.2,
        physical_attempts=1,
        provider_protocol="json_schema",
    )

    fact_one = [value for value in pool.candidates if value.source_fact_ids == ("fact-1",)]
    assert {value.length_variant for value in fact_one} == {"short"}
    assert pool.diagnostics.rejected_model_variants == 1
    assert "ungrounded_model_candidate_variants_rejected" in pool.diagnostics.warnings


def test_logical_candidate_capacity_reports_the_required_ratio_band() -> None:
    plan, retrieval = candidate_inputs()
    plan = plan.model_copy(update={"target_candidate_lines": 2})

    pool = CandidatePoolService(ResumeLayoutService(PillowFontMetrics())).build(
        plan,
        retrieval,
        None,
        language="zh-CN",
        candidate_pool_target_ratio=1.2,
        candidate_pool_max_ratio=1.35,
        physical_attempts=2,
        provider_protocol=None,
    )

    assert 1.20 <= pool.diagnostics.logical_pool_ratio <= 1.35
    assert "candidate_pool_under_target" not in pool.diagnostics.warnings
    assert "candidate_pool_over_target" not in pool.diagnostics.warnings


def test_incremental_reuse_regenerates_only_changed_revision() -> None:
    previous_plan, previous_retrieval = _two_experience_candidate_inputs()
    layout = ResumeLayoutService(PillowFontMetrics())
    previous_pool = CandidatePoolService(layout).build(
        previous_plan,
        previous_retrieval,
        None,
        language="zh-CN",
        candidate_pool_target_ratio=1.2,
        physical_attempts=0,
        provider_protocol=None,
    )
    current_retrieval = previous_retrieval.model_copy(
        update={
            "experiences": tuple(
                value.model_copy(update={"revision_id": "rev-work-2"})
                if value.experience_id == "exp-work"
                else value
                for value in previous_retrieval.experiences
            ),
            "facts": tuple(
                value.model_copy(
                    update={
                        "fact_id": f"{value.fact_id}-new",
                        "source_revision_id": "rev-work-2",
                    }
                )
                if value.experience_id == "exp-work"
                else value
                for value in previous_retrieval.facts
            ),
        }
    )
    current_plan = previous_plan.model_copy(
        update={
            "plan_version": "test-plan-2",
            "selected_fact_ids": ("fact-1-new", "fact-2-new", "fact-3"),
            "fact_requirement_map": {
                "fact-1-new": ("req-python",),
                "fact-2-new": ("req-python",),
                "fact-3": ("req-python",),
            },
        }
    )

    reuse = plan_incremental_candidate_reuse(
        previous_plan,
        previous_retrieval,
        previous_pool.candidates,
        current_plan,
        current_retrieval,
        invalidated_experience_ids=("exp-work",),
    )

    assert reuse.mode == "incremental"
    assert reuse.generation_experience_ids == ("exp-work",)
    assert reuse.generation_fact_ids == ("fact-1-new", "fact-2-new")
    assert {value.experience_id for value in reuse.reusable_candidates} == {"exp-project"}
    assert "current_revision_changed" in reuse.invalidation_reasons["exp-work"]


def test_incremental_reuse_regenerates_unchanged_revision_when_plan_facts_change() -> None:
    previous_plan, previous_retrieval = _two_experience_candidate_inputs()
    previous_pool = CandidatePoolService(ResumeLayoutService(PillowFontMetrics())).build(
        previous_plan,
        previous_retrieval,
        None,
        language="zh-CN",
        candidate_pool_target_ratio=1.2,
        physical_attempts=0,
        provider_protocol=None,
    )
    extra = previous_retrieval.facts[-1].model_copy(
        update={"fact_id": "fact-4", "source_text": "使用 Python 建立项目质量检查流程"}
    )
    current_retrieval = previous_retrieval.model_copy(
        update={"facts": (*previous_retrieval.facts, extra)}
    )
    current_plan = previous_plan.model_copy(
        update={
            "plan_version": "test-plan-2",
            "selected_fact_ids": (*previous_plan.selected_fact_ids, "fact-4"),
            "fact_requirement_map": {
                **previous_plan.fact_requirement_map,
                "fact-4": ("req-python",),
            },
        }
    )

    reuse = plan_incremental_candidate_reuse(
        previous_plan,
        previous_retrieval,
        previous_pool.candidates,
        current_plan,
        current_retrieval,
    )

    assert reuse.generation_experience_ids == ("exp-project",)
    assert reuse.generation_fact_ids == ("fact-3", "fact-4")
    assert {value.experience_id for value in reuse.reusable_candidates} == {"exp-work"}
    assert "selected_fact_set_changed" in reuse.invalidation_reasons["exp-project"]


def _two_experience_candidate_inputs() -> tuple[ResumePlan, HybridRetrievalResult]:
    plan, retrieval = candidate_inputs()
    project = retrieval.experiences[0].model_copy(
        update={
            "experience_id": "exp-project",
            "revision_id": "rev-project",
            "revision_hash": "hash-project",
            "title": "Automation Project",
            "organization": None,
            "role": None,
            "category": "project",
            "content": "使用 Python 建立自动化质量检查流程",
        }
    )
    project_fact = retrieval.facts[0].model_copy(
        update={
            "fact_id": "fact-3",
            "experience_id": "exp-project",
            "source_revision_id": "rev-project",
            "source_text": "使用 Python 建立自动化质量检查流程",
        }
    )
    retrieval = retrieval.model_copy(
        update={
            "experiences": (*retrieval.experiences, project),
            "facts": (*retrieval.facts, project_fact),
            "selected_fact_ids": ("fact-1", "fact-2", "fact-3"),
        }
    )
    plan = plan.model_copy(
        update={
            "selected_experience_ids": (*plan.selected_experience_ids, "exp-project"),
            "selected_fact_ids": ("fact-1", "fact-2", "fact-3"),
            "fact_requirement_map": {
                **plan.fact_requirement_map,
                "fact-3": ("req-python",),
            },
            "experience_height_budgets_mm": {
                **plan.experience_height_budgets_mm,
                "exp-project": 25.0,
            },
        }
    )
    return plan, retrieval
