from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

LengthVariant = Literal["short", "medium", "long"]


class CandidateTextVariantDraft(BaseModel):
    length_variant: LengthVariant
    text: str


class CandidateGroupDraft(BaseModel):
    experience_id: str
    source_fact_ids: tuple[str, ...]
    covered_requirement_ids: tuple[str, ...] = ()
    variants: tuple[CandidateTextVariantDraft, ...]


class CandidateBatchDraft(BaseModel):
    groups: tuple[CandidateGroupDraft, ...]


class CandidateBullet(BaseModel):
    bullet_id: str
    candidate_group_id: str
    experience_id: str
    text: str
    source_fact_ids: tuple[str, ...]
    covered_requirement_ids: tuple[str, ...]
    quality_score: float = Field(ge=0.0)
    estimated_lines: int = Field(ge=1)
    estimated_height_mm: float = Field(gt=0.0)
    length_variant: LengthVariant


class CandidateReusePlan(BaseModel):
    mode: Literal["full", "incremental"]
    reusable_candidates: tuple[CandidateBullet, ...] = ()
    generation_experience_ids: tuple[str, ...] = ()
    generation_fact_ids: tuple[str, ...] = ()
    invalidated_experience_ids: tuple[str, ...] = ()
    invalidation_reasons: dict[str, tuple[str, ...]] = Field(default_factory=dict)


class CandidateGenerationDiagnostics(BaseModel):
    requested_facts: int = Field(ge=0)
    model_groups: int = Field(ge=0)
    accepted_model_groups: int = Field(ge=0)
    rejected_model_groups: int = Field(ge=0)
    rejected_model_variants: int = Field(ge=0)
    fallback_groups: int = Field(ge=0)
    candidate_count: int = Field(ge=0)
    logical_candidate_lines: int = Field(ge=0)
    target_candidate_lines: int = Field(ge=0)
    logical_pool_ratio: float = Field(ge=0.0)
    physical_attempts: int = Field(ge=0)
    reused_candidate_count: int = Field(default=0, ge=0)
    regenerated_experience_count: int = Field(default=0, ge=0)
    provider_protocol: str | None = None
    provider_error_category: str | None = None
    generation_source: Literal["model", "mixed", "deterministic_fallback"]
    warnings: tuple[str, ...] = ()


class CandidatePool(BaseModel):
    plan_version: str
    candidates: tuple[CandidateBullet, ...]
    diagnostics: CandidateGenerationDiagnostics
