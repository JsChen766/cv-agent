from __future__ import annotations

from datetime import date
from itertools import islice, permutations

from app.domain.resume.planning.projection import project_resume_plan
from app.domain.resume.planning.service import ResumePlanService
from app.domain.resume.retrieval.models import (
    FactScoreBreakdown,
    HybridRetrievalResult,
    RankedFact,
    RetrievalDiagnostics,
    RetrievalExperience,
    RetrievalRequirement,
)
from app.domain.resume.sufficiency.models import (
    FactHeightEstimate,
    FixedHeightBreakdown,
    MaterialSufficiencyReport,
    NarrativeExperienceHeightEstimate,
)


def _experience(experience_id: str, category: str, year: int) -> RetrievalExperience:
    return RetrievalExperience(
        experience_id=experience_id,
        revision_id=f"rev-{experience_id}",
        revision_hash="hash",
        title=f"{category}-{experience_id}",
        organization="Example",
        role="Engineer",
        category=category,
        start_date=date(year, 1, 1),
        end_date=date(year + 1, 1, 1),
        tags=("Python",),
        content=f"Grounded content for {experience_id}",
        factbank_status="ready",
    )


def _fact(
    index: int,
    experience_id: str,
    *,
    score: float,
    requirement_id: str,
    text: str | None = None,
) -> RankedFact:
    return RankedFact(
        fact_id=f"fact-{index}",
        experience_id=experience_id,
        source_revision_id=f"rev-{experience_id}",
        source_text=text or f"Delivered unique subsystem capability {index} with verified outcome",
        technologies=(f"Technology-{index}",),
        selected=index < 2,
        score=FactScoreBreakdown(
            semantic_similarity=score,
            lexical_technology_match=score,
            uncovered_requirement_gain=0.5,
            evidence_strength=0.8,
            recency=0.1,
            weighted_total=score,
        ),
        marginal_value=score,
        matched_requirement_ids=(requirement_id,),
    )


def _inputs() -> tuple[HybridRetrievalResult, MaterialSufficiencyReport]:
    experiences = (
        _experience("work-old", "work", 2018),
        _experience("work-new", "work", 2024),
        _experience("project-1", "project", 2022),
        _experience("education-1", "education", 2016),
    )
    facts = tuple(
        _fact(
            index,
            "work-old" if index % 3 == 0 else "work-new" if index % 3 == 1 else "project-1",
            score=0.92 if index % 3 == 0 else 0.7 if index % 3 == 2 else 0.45,
            requirement_id="req-backend" if index % 2 == 0 else "req-data",
        )
        for index in range(28)
    )
    requirements = (
        RetrievalRequirement(
            requirement_id="req-backend",
            description="Backend engineering",
            category="responsibility",
            keywords=("backend",),
            importance="must_have",
            weight=1.0,
        ),
        RetrievalRequirement(
            requirement_id="req-data",
            description="Data systems",
            category="technology",
            keywords=("data",),
            importance="preferred",
            weight=0.6,
        ),
    )
    retrieval = HybridRetrievalResult(
        requirements=requirements,
        experiences=experiences,
        facts=facts,
        selected_fact_ids=("fact-0", "fact-1"),
        diagnostics=RetrievalDiagnostics(
            total_experiences=len(experiences),
            total_facts=len(facts),
            selected_facts=2,
            ready_facts=len(facts),
            fallback_facts=0,
            ranking_version="test",
        ),
    )
    estimates = tuple(
        FactHeightEstimate(
            fact_id=fact.fact_id,
            experience_id=fact.experience_id,
            source_revision_id=fact.source_revision_id,
            qualified=True,
            estimated_lines=2,
            estimated_height_mm=10.0,
            matched_requirement_ids=fact.matched_requirement_ids,
            qualification_reasons=("matches_requirement",),
        )
        for fact in facts
    )
    sufficiency = MaterialSufficiencyReport(
        status="sufficient",
        sufficiency_version="test",
        profile_version="test",
        profile_hash="hash",
        page_available_height_mm=279.0,
        minimum_usage_ratio=0.85,
        minimum_required_height_mm=237.15,
        fixed_height=FixedHeightBreakdown(
            contact_height_mm=10.0,
            education_height_mm=20.0,
            skills_height_mm=10.0,
            total_height_mm=40.0,
        ),
        narrative_section_overheads_mm={"work": 5.0, "project": 5.0},
        narrative_experience_estimates=(
            NarrativeExperienceHeightEstimate(
                experience_id="work-old",
                category="work",
                overhead_height_mm=5.0,
                qualified_fact_height_mm=100.0,
                total_supported_height_mm=105.0,
            ),
            NarrativeExperienceHeightEstimate(
                experience_id="work-new",
                category="work",
                overhead_height_mm=5.0,
                qualified_fact_height_mm=90.0,
                total_supported_height_mm=95.0,
            ),
            NarrativeExperienceHeightEstimate(
                experience_id="project-1",
                category="project",
                overhead_height_mm=5.0,
                qualified_fact_height_mm=90.0,
                total_supported_height_mm=95.0,
            ),
        ),
        narrative_overhead_height_mm=25.0,
        qualified_fact_height_mm=280.0,
        global_supported_height_mm=345.0,
        supported_usage_ratio=1.2366,
        missing_height_mm=0.0,
        approximate_missing_lines=0,
        total_experiences=len(experiences),
        total_facts=len(facts),
        qualified_facts=len(facts),
        excluded_facts=0,
        covered_requirement_ids=("req-backend", "req-data"),
        fact_estimates=estimates,
    )
    return retrieval, sufficiency


def _build() -> tuple[HybridRetrievalResult, MaterialSufficiencyReport, object]:
    retrieval, sufficiency = _inputs()
    result = ResumePlanService(beam_width=128).build(
        retrieval,
        sufficiency,
        minimum_usage_ratio=0.85,
        target_usage_ratio=0.90,
        maximum_usage_ratio=0.98,
        line_height_mm=4.0,
        candidate_pool_target_ratio=1.2,
    )
    return retrieval, sufficiency, result


def test_resume_plan_is_height_feasible_unique_and_preserves_required_categories() -> None:
    _retrieval, _sufficiency, result = _build()

    assert result.status == "ready"
    assert result.plan is not None
    assert 0.85 <= result.plan.estimated_usage_ratio <= 0.98
    assert len(result.plan.selected_fact_ids) == len(set(result.plan.selected_fact_ids))
    assert "education-1" in result.plan.selected_experience_ids
    assert any(value.startswith("work-") for value in result.plan.selected_experience_ids)
    assert "project-1" in result.plan.selected_experience_ids
    assert set(result.plan.fact_requirement_map) == set(result.plan.selected_fact_ids)
    assert (
        abs(
            sum(result.plan.section_height_budgets_mm.values())
            - result.plan.estimated_page_height_mm
        )
        < 0.01
    )


def test_resume_plan_is_deterministic_and_prefers_strong_older_evidence() -> None:
    _retrieval, _sufficiency, first = _build()
    _retrieval, _sufficiency, second = _build()

    assert first == second
    assert first.plan is not None
    selected_old = sum(
        int(fact_id.removeprefix("fact-")) % 3 == 0 for fact_id in first.plan.selected_fact_ids
    )
    selected_new = sum(
        int(fact_id.removeprefix("fact-")) % 3 == 1 for fact_id in first.plan.selected_fact_ids
    )
    assert selected_old > selected_new
    assert {
        requirement_id
        for values in first.plan.fact_requirement_map.values()
        for requirement_id in values
    } == {"req-backend", "req-data"}


def test_near_duplicate_facts_cannot_both_enter_plan() -> None:
    retrieval, sufficiency = _inputs()
    duplicate = retrieval.facts[0].model_copy(
        update={
            "fact_id": "fact-duplicate",
            "source_text": retrieval.facts[0].source_text,
        }
    )
    retrieval = retrieval.model_copy(update={"facts": (*retrieval.facts, duplicate)})
    duplicate_estimate = sufficiency.fact_estimates[0].model_copy(
        update={"fact_id": "fact-duplicate"}
    )
    sufficiency = sufficiency.model_copy(
        update={"fact_estimates": (*sufficiency.fact_estimates, duplicate_estimate)}
    )

    result = ResumePlanService().build(
        retrieval,
        sufficiency,
        minimum_usage_ratio=0.85,
        target_usage_ratio=0.90,
        maximum_usage_ratio=0.98,
        line_height_mm=4.0,
        candidate_pool_target_ratio=1.2,
    )

    assert result.plan is not None
    assert not {"fact-0", "fact-duplicate"}.issubset(result.plan.selected_fact_ids)
    rejected_id = "fact-duplicate" if "fact-0" in result.plan.selected_fact_ids else "fact-0"
    assert "near_duplicate_of_selected_fact" in result.plan.rejection_reasons[rejected_id]


def test_compatibility_fields_are_only_projected_from_resume_plan() -> None:
    retrieval, _sufficiency, result = _build()
    assert result.plan is not None

    projected = project_resume_plan(
        retrieval,
        result.plan,
        candidate_pool_target_ratio=1.2,
    )

    assert projected["experience_selection_result"]["selection_reason"] == (
        "projected_from_resume_plan"
    )
    budget_fact_ids = {
        fact["id"]
        for experience in projected["content_budget"]["experiences"]
        for fact in experience["facts"]
    }
    assert budget_fact_ids == set(result.plan.selected_fact_ids)
    projected_claim_ids = {
        claim["fact_id"]
        for experience in projected["selected_experiences"]
        for claim in experience["claims"]
    }
    assert projected_claim_ids == set(result.plan.selected_fact_ids)


def test_optimizer_frontier_expands_past_near_duplicates_to_find_feasible_facts() -> None:
    retrieval, sufficiency = _inputs()
    experience = retrieval.experiences[0]
    repeated_words = (
        "built",
        "api",
        "python",
        "postgresql",
        "cache",
        "reliability",
        "control",
        "platform",
    )
    near_duplicates = tuple(
        _fact(
            index,
            experience.experience_id,
            score=0.95,
            requirement_id="req-backend",
            text=" ".join(words),
        ).model_copy(update={"technologies": ("Python", "PostgreSQL")})
        for index, words in enumerate(islice(permutations(repeated_words), 40))
    )
    independent_facts = tuple(
        _fact(
            index,
            experience.experience_id,
            score=0.3,
            requirement_id="req-backend",
            text=(
                f"Delivered independent verified subsystem domain-{index} "
                f"with distinct outcome metric-{index}"
            ),
        )
        for index in range(40, 60)
    )
    facts = (*near_duplicates, *independent_facts)
    retrieval = retrieval.model_copy(
        update={
            "experiences": (experience,),
            "facts": facts,
            "selected_fact_ids": ("fact-0", "fact-1"),
        }
    )
    estimates = tuple(
        FactHeightEstimate(
            fact_id=fact.fact_id,
            experience_id=fact.experience_id,
            source_revision_id=fact.source_revision_id,
            qualified=True,
            estimated_lines=2,
            estimated_height_mm=10.0,
            matched_requirement_ids=fact.matched_requirement_ids,
            qualification_reasons=("matches_requirement",),
        )
        for fact in facts
    )
    sufficiency = sufficiency.model_copy(
        update={
            "fact_estimates": estimates,
            "narrative_experience_estimates": (
                NarrativeExperienceHeightEstimate(
                    experience_id=experience.experience_id,
                    category="work",
                    overhead_height_mm=5.0,
                    qualified_fact_height_mm=600.0,
                    total_supported_height_mm=605.0,
                ),
            ),
            "narrative_section_overheads_mm": {"work": 5.0},
            "global_supported_height_mm": 650.0,
            "qualified_fact_height_mm": 600.0,
            "total_experiences": 1,
            "total_facts": len(facts),
            "qualified_facts": len(facts),
        }
    )

    result = ResumePlanService(max_optimizer_facts=40).build(
        retrieval,
        sufficiency,
        minimum_usage_ratio=0.85,
        target_usage_ratio=0.90,
        maximum_usage_ratio=0.98,
        line_height_mm=4.0,
        candidate_pool_target_ratio=1.2,
    )

    assert result.status == "ready"
    assert result.plan is not None
    assert any(int(value.removeprefix("fact-")) >= 40 for value in result.plan.selected_fact_ids)
    assert result.diagnostics.optimizer_facts > 40
