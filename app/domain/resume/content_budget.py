"""Deterministic content budgeting for one-page resume generation."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class SourceFact(BaseModel):
    id: str
    text: str


class ExperienceContentBudget(BaseModel):
    experience_id: str
    category: str
    jd_match_score: float = Field(ge=0.0, le=1.0)
    match_tier: int = Field(ge=1, le=3)
    target_candidate_bullets: int = Field(ge=0)
    facts: list[SourceFact] = Field(default_factory=list)


class ResumeContentBudget(BaseModel):
    target_usage_ratio: float
    candidate_pool_target_ratio: float
    experiences: list[ExperienceContentBudget] = Field(default_factory=list)


def build_resume_content_budget(
    experiences: list[dict[str, Any]],
    evidence_pack: dict[str, Any] | None,
    *,
    target_usage_ratio: float,
    candidate_pool_target_ratio: float,
) -> ResumeContentBudget:
    """Allocate more candidate bullets to evidence-rich, JD-matched experiences.

    EvidencePack currently stores matched claim text without the source experience id.
    We recover ownership by matching normalized claim text against each experience's
    claim inventory. Relevance score remains a fallback for legacy rows without claims.
    """

    matched_claim_scores: dict[str, float] = {}
    for match in (evidence_pack or {}).get("matches", []):
        if not isinstance(match, dict):
            continue
        score = _bounded_score(match.get("match_score"))
        for claim in match.get("matched_claims") or []:
            if isinstance(claim, dict) and claim.get("text"):
                key = _normalize_fact(str(claim["text"]))
                matched_claim_scores[key] = max(matched_claim_scores.get(key, 0.0), score)

    budgets: list[ExperienceContentBudget] = []
    narrative_count = sum(
        1 for value in experiences if str(value.get("category") or "other") != "education"
    )
    for value in experiences:
        experience_id = str(value.get("id") or "")
        if not experience_id:
            continue
        category = str(value.get("category") or "other")
        facts = _source_facts(experience_id, value)
        claim_scores = [matched_claim_scores.get(_normalize_fact(fact.text), 0.0) for fact in facts]
        evidence_score = max(claim_scores, default=0.0)
        relevance_score = _bounded_score(value.get("relevance_score"))
        fact_richness = min(1.0, len(facts) / 8.0)
        match_score = min(
            1.0,
            0.60 * max(evidence_score, relevance_score) + 0.40 * fact_richness,
        )

        if category == "education":
            tier, target = 3, 0
        elif match_score >= 0.70:
            tier, target = 1, 10 if narrative_count <= 2 else 8
        elif match_score >= 0.40:
            tier, target = 2, 7 if narrative_count <= 3 else 6
        else:
            tier, target = 3, 4
        budgets.append(
            ExperienceContentBudget(
                experience_id=experience_id,
                category=category,
                jd_match_score=round(match_score, 4),
                match_tier=tier,
                target_candidate_bullets=target,
                facts=facts,
            )
        )

    budgets.sort(key=lambda value: (value.category == "education", -value.jd_match_score))
    return ResumeContentBudget(
        target_usage_ratio=target_usage_ratio,
        candidate_pool_target_ratio=candidate_pool_target_ratio,
        experiences=budgets,
    )


def _source_facts(experience_id: str, value: dict[str, Any]) -> list[SourceFact]:
    facts: list[str] = []
    for claim in value.get("claims") or []:
        if isinstance(claim, dict) and claim.get("text"):
            facts.append(str(claim["text"]).strip())
    if not facts:
        content = str(value.get("content") or "")
        facts.extend(part.strip(" -•\t") for part in content.splitlines() if part.strip())
    unique: list[str] = []
    seen: set[str] = set()
    for fact in facts:
        normalized = _normalize_fact(fact)
        if normalized and normalized not in seen:
            unique.append(fact)
            seen.add(normalized)
    return [
        SourceFact(id=f"{experience_id}-fact-{index}", text=text)
        for index, text in enumerate(unique, start=1)
    ]


def _normalize_fact(value: str) -> str:
    return "".join(value.lower().split())


def _bounded_score(value: object) -> float:
    if isinstance(value, (int, float)):
        return max(0.0, min(1.0, float(value)))
    return 0.0
