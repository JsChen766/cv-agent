from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.domain.resume.candidates.models import CandidateBullet


class QualityIssue(BaseModel):
    code: str
    message: str
    scope: Literal["bullet", "item", "global"]
    repairable: bool = False
    bullet_id: str | None = None
    experience_id: str | None = None
    fact_ids: tuple[str, ...] = ()
    requirement_ids: tuple[str, ...] = ()


class GroundingReport(BaseModel):
    selected_bullets: int = Field(ge=0)
    grounded_bullets: int = Field(ge=0)
    ungrounded_bullets: int = Field(ge=0)
    selected_facts: int = Field(ge=0)
    duplicate_fact_ids: tuple[str, ...] = ()
    invalid_fact_ids: tuple[str, ...] = ()
    mismatched_experience_fact_ids: tuple[str, ...] = ()
    stale_revision_fact_ids: tuple[str, ...] = ()


class RequirementCoverageReport(BaseModel):
    must_have_total_weight: float = Field(ge=0.0)
    must_have_covered_weight: float = Field(ge=0.0)
    must_have_coverage_ratio: float = Field(ge=0.0, le=1.0)
    threshold: float = Field(ge=0.0, le=1.0)
    covered_requirement_ids: tuple[str, ...] = ()
    uncovered_must_have_requirement_ids: tuple[str, ...] = ()


class QualityValidationReport(BaseModel):
    validation_version: str
    status: Literal["passed", "repairable", "failed"]
    issues: tuple[QualityIssue, ...]
    grounding: GroundingReport
    coverage: RequirementCoverageReport
    page_usage_ratio: float = Field(ge=0.0)
    page_count: int = Field(ge=0)
    overflow_mm: float = Field(ge=0.0)
    selected_candidate_ids: tuple[str, ...]
    repairable_bullet_ids: tuple[str, ...] = ()


class LocalRepairCandidateDraft(BaseModel):
    text: str = Field(min_length=1)
    source_fact_ids: tuple[str, ...]
    covered_requirement_ids: tuple[str, ...]


class LocalRepairChoiceDraft(BaseModel):
    bullet_id: str = Field(min_length=1)
    candidates: tuple[LocalRepairCandidateDraft, ...] = Field(min_length=1, max_length=3)


class LocalRepairBatchDraft(BaseModel):
    repairs: tuple[LocalRepairChoiceDraft, ...] = Field(min_length=1)


class LocalRepairResult(BaseModel):
    status: Literal["applied", "rejected"]
    candidates: tuple[CandidateBullet, ...]
    added_candidate_ids: tuple[str, ...] = ()
    rejection_reasons: tuple[str, ...] = ()
