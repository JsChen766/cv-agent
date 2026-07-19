from __future__ import annotations

import math

from app.domain.resume.planning.models import ResumePlan
from app.domain.resume.retrieval.models import HybridRetrievalResult, RankedFact


def project_resume_plan(
    retrieval: HybridRetrievalResult,
    plan: ResumePlan,
    *,
    candidate_pool_target_ratio: float,
) -> dict[str, object]:
    """Project the authoritative plan into temporary V1 generation contracts."""
    selected_experience_ids = set(plan.selected_experience_ids)
    selected_fact_ids = set(plan.selected_fact_ids)
    facts_by_experience: dict[str, list[RankedFact]] = {}
    for fact in retrieval.facts:
        if fact.fact_id in selected_fact_ids:
            facts_by_experience.setdefault(fact.experience_id, []).append(fact)

    selected_experiences: list[dict[str, object]] = []
    selection_rows: list[dict[str, object]] = []
    budget_rows: list[dict[str, object]] = []
    for experience in retrieval.experiences:
        if experience.experience_id not in selected_experience_ids:
            continue
        facts = sorted(
            facts_by_experience.get(experience.experience_id, []),
            key=lambda value: plan.selected_fact_ids.index(value.fact_id),
        )
        relevance = max((value.score.weighted_total for value in facts), default=0.0)
        matched_requirement_ids = sorted(
            {requirement_id for fact in facts for requirement_id in fact.matched_requirement_ids}
        )
        selected_experiences.append(
            {
                "id": experience.experience_id,
                "title": experience.title,
                "organization": experience.organization,
                "role": experience.role,
                "category": experience.category,
                "start_date": experience.start_date.isoformat() if experience.start_date else None,
                "end_date": experience.end_date.isoformat() if experience.end_date else None,
                "tags": list(experience.tags),
                "content": experience.content,
                "claims": [
                    {
                        "fact_id": fact.fact_id,
                        "experience_id": fact.experience_id,
                        "text": fact.source_text,
                        "category": "achievement",
                        "is_quantified": any(character.isdigit() for character in fact.source_text),
                    }
                    for fact in facts
                ],
                "factbank_status": experience.factbank_status,
                "relevance_score": round(relevance, 4),
            }
        )
        target_bullets = len(facts)
        selection_rows.append(
            {
                "experience_id": experience.experience_id,
                "category": experience.category,
                "jd_match_score": round(relevance, 4),
                "claim_coverage_ratio": (
                    len(matched_requirement_ids) / len(plan.requirements)
                    if plan.requirements
                    else 0.0
                ),
                "recency_bonus": 0.0,
                "composite_score": round(relevance, 4),
                "target_bullets": target_bullets,
                "matched_requirement_ids": matched_requirement_ids,
            }
        )
        budget_rows.append(
            {
                "experience_id": experience.experience_id,
                "category": experience.category,
                "jd_match_score": round(relevance, 4),
                "match_tier": 3
                if experience.category == "education"
                else (1 if relevance >= 0.7 else 2 if relevance >= 0.4 else 3),
                "target_candidate_bullets": (
                    0
                    if experience.category == "education"
                    else max(1, math.ceil(target_bullets * candidate_pool_target_ratio))
                ),
                "facts": [{"id": fact.fact_id, "text": fact.source_text} for fact in facts],
            }
        )

    selected_experiences.sort(
        key=lambda value: (
            value.get("category") == "education",
            plan.selected_experience_ids.index(str(value["id"])),
        )
    )
    selected_ids = set(plan.selected_experience_ids)
    dropped = [
        value.experience_id
        for value in retrieval.experiences
        if value.category != "education" and value.experience_id not in selected_ids
    ]
    coverage_plan = [
        {
            "requirement_id": requirement.requirement_id,
            "requirement_text": requirement.description,
            "planned_source_experience_ids": sorted(
                {
                    fact.experience_id
                    for fact in retrieval.facts
                    if fact.fact_id in selected_fact_ids
                    and requirement.requirement_id in fact.matched_requirement_ids
                }
            ),
        }
        for requirement in plan.requirements
    ]
    emphasized_skills: set[str] = set()
    for fact in retrieval.facts:
        if fact.fact_id in selected_fact_ids:
            emphasized_skills.update(fact.technologies)
    emphasized_skill_values: list[str] = [str(value) for value in emphasized_skills]
    emphasized_skill_values.sort(key=_casefold)
    return {
        "selected_experiences": selected_experiences,
        "experience_selection_result": {
            "selected": selection_rows,
            "dropped": dropped,
            "total_target_bullets": len(plan.selected_fact_ids),
            "selection_reason": "projected_from_resume_plan",
        },
        "matching_plan": {
            "strategy": "resume_plan_projection",
            "key_experiences_to_highlight": list(plan.selected_experience_ids),
            "skills_to_emphasize": emphasized_skill_values,
            "tone": "professional",
            "structure_suggestions": [],
            "coverage_plan": coverage_plan,
        },
        "content_budget": {
            "target_usage_ratio": plan.target_final_usage_ratio,
            "candidate_pool_target_ratio": candidate_pool_target_ratio,
            "experiences": budget_rows,
        },
        "generation_strategy": "resume_plan_projection",
    }


def _casefold(value: str) -> str:
    return value.casefold()
