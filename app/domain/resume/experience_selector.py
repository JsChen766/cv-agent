"""Deterministic experience selection for one-page resume generation.

Scores and selects experiences by JD relevance, claim coverage, and recency,
then allocates a bullet budget that fits within the target page usage.
"""

from __future__ import annotations

import math
from datetime import date
from typing import Any

from pydantic import BaseModel, Field


class SelectedExperience(BaseModel):
    experience_id: str
    category: str
    jd_match_score: float = Field(ge=0.0, le=1.0)
    claim_coverage_ratio: float = Field(ge=0.0, le=1.0)
    recency_bonus: float = Field(ge=0.0, le=1.0)
    composite_score: float = Field(ge=0.0, le=1.0)
    target_bullets: int = Field(ge=0)
    matched_requirement_ids: list[str] = Field(default_factory=list)


class ExperienceSelectionResult(BaseModel):
    selected: list[SelectedExperience] = Field(default_factory=list)
    dropped: list[str] = Field(default_factory=list)
    total_target_bullets: int = 0
    selection_reason: str = ""


def select_experiences(
    experiences: list[dict[str, Any]],
    evidence_pack: dict[str, Any] | None,
    *,
    max_narrative_experiences: int = 5,
    min_composite_score: float = 0.15,
    target_total_bullets: int = 22,
) -> ExperienceSelectionResult:
    """Score, rank, and select experiences for resume inclusion.

    Education entries are always included. Narrative entries (work/project/other)
    are scored and the top-k are selected to fit the bullet budget.
    """
    if not experiences:
        return ExperienceSelectionResult(selection_reason="no_experiences")

    claim_req_map = _build_claim_requirement_map(evidence_pack)

    education: list[SelectedExperience] = []
    narrative_scored: list[SelectedExperience] = []

    for exp in experiences:
        exp_id = str(exp.get("id") or "")
        if not exp_id:
            continue
        category = str(exp.get("category") or "other")

        if category == "education":
            education.append(SelectedExperience(
                experience_id=exp_id,
                category=category,
                jd_match_score=0.0,
                claim_coverage_ratio=0.0,
                recency_bonus=0.0,
                composite_score=0.0,
                target_bullets=0,
            ))
            continue

        relevance = _bounded(exp.get("relevance_score"))
        claims = exp.get("claims") or []
        claim_coverage, matched_req_ids = _claim_coverage(exp_id, claims, claim_req_map)
        recency = _recency_bonus(exp.get("end_date"), exp.get("start_date"))

        composite = (
            0.50 * max(relevance, claim_coverage)
            + 0.30 * claim_coverage
            + 0.20 * recency
        )
        composite = min(1.0, composite)

        narrative_scored.append(SelectedExperience(
            experience_id=exp_id,
            category=category,
            jd_match_score=round(relevance, 4),
            claim_coverage_ratio=round(claim_coverage, 4),
            recency_bonus=round(recency, 4),
            composite_score=round(composite, 4),
            target_bullets=0,
            matched_requirement_ids=matched_req_ids,
        ))

    narrative_scored.sort(key=lambda s: s.composite_score, reverse=True)

    selected_narrative: list[SelectedExperience] = []
    dropped: list[str] = []
    min_bullets_per_exp = 3
    for item in narrative_scored:
        at_max = len(selected_narrative) >= max_narrative_experiences
        too_weak = item.composite_score < min_composite_score and selected_narrative
        page_full = (
            len(selected_narrative) >= 3
            and len(selected_narrative) * min_bullets_per_exp >= target_total_bullets
        )
        if at_max or too_weak or page_full:
            dropped.append(item.experience_id)
        else:
            selected_narrative.append(item)

    _allocate_bullets(selected_narrative, target_total_bullets)

    selected = education + selected_narrative
    total_bullets = sum(s.target_bullets for s in selected)

    return ExperienceSelectionResult(
        selected=selected,
        dropped=dropped,
        total_target_bullets=total_bullets,
        selection_reason=f"selected {len(selected_narrative)} narrative + {len(education)} education from {len(experiences)} total",
    )


def _build_claim_requirement_map(
    evidence_pack: dict[str, Any] | None,
) -> dict[str, list[str]]:
    """Map normalized claim text -> list of requirement IDs it supports."""
    result: dict[str, list[str]] = {}
    for match in (evidence_pack or {}).get("matches", []):
        if not isinstance(match, dict):
            continue
        req_id = str(match.get("requirement_id") or "")
        for claim in match.get("matched_claims") or []:
            if isinstance(claim, dict) and claim.get("text"):
                key = _normalize(str(claim["text"]))
                result.setdefault(key, []).append(req_id)
    return result


def _claim_coverage(
    experience_id: str,
    claims: list[Any],
    claim_req_map: dict[str, list[str]],
) -> tuple[float, list[str]]:
    """Fraction of this experience's claims that match JD requirements."""
    if not claims:
        return 0.0, []
    matched = 0
    req_ids: set[str] = set()
    for claim in claims:
        if not isinstance(claim, dict):
            continue
        text = str(claim.get("text") or "")
        key = _normalize(text)
        if key in claim_req_map:
            matched += 1
            req_ids.update(claim_req_map[key])
    ratio = matched / len(claims) if claims else 0.0
    return min(1.0, ratio), sorted(req_ids)


def _recency_bonus(end_date: Any, start_date: Any) -> float:
    """Exponential decay based on how recent the experience is."""
    raw = end_date or start_date
    if not raw:
        return 0.3
    try:
        date_str = str(raw)[:10]
        parts = date_str.split("-")
        year = int(parts[0])
        month = int(parts[1]) if len(parts) > 1 else 6
        exp_date = date(year, month, 1)
    except (ValueError, IndexError):
        return 0.3
    today = date.today()
    months_ago = (today.year - exp_date.year) * 12 + (today.month - exp_date.month)
    if months_ago <= 0:
        return 1.0
    # half-life of ~36 months
    return max(0.05, math.exp(-0.693 * months_ago / 36))


def _allocate_bullets(
    selected: list[SelectedExperience],
    target_total: int,
) -> None:
    """Distribute bullet budget proportional to composite score."""
    if not selected:
        return
    total_score = sum(s.composite_score for s in selected) or 1.0
    remaining = target_total

    for i, item in enumerate(selected):
        if i == len(selected) - 1:
            item.target_bullets = max(2, remaining)
        else:
            share = round(target_total * item.composite_score / total_score)
            item.target_bullets = max(2, min(share, remaining - (len(selected) - i - 1) * 2))
            remaining -= item.target_bullets


def _normalize(text: str) -> str:
    return "".join(text.lower().split())


def _bounded(value: Any) -> float:
    if isinstance(value, (int, float)):
        return max(0.0, min(1.0, float(value)))
    return 0.0
