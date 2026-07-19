from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class FixedHeightBreakdown(BaseModel):
    contact_height_mm: float = Field(ge=0.0)
    education_height_mm: float = Field(ge=0.0)
    skills_height_mm: float = Field(ge=0.0)
    total_height_mm: float = Field(ge=0.0)


class FactHeightEstimate(BaseModel):
    fact_id: str
    experience_id: str
    source_revision_id: str
    qualified: bool
    estimated_lines: int = Field(ge=0)
    estimated_height_mm: float = Field(ge=0.0)
    matched_requirement_ids: tuple[str, ...] = ()
    qualification_reasons: tuple[str, ...] = ()
    exclusion_reasons: tuple[str, ...] = ()
    degradation_sources: tuple[str, ...] = ()


class NarrativeExperienceHeightEstimate(BaseModel):
    experience_id: str
    category: str
    overhead_height_mm: float = Field(ge=0.0)
    qualified_fact_height_mm: float = Field(ge=0.0)
    total_supported_height_mm: float = Field(ge=0.0)


class MaterialSufficiencyReport(BaseModel):
    status: Literal["sufficient", "insufficient"]
    sufficiency_version: str
    profile_version: str
    profile_hash: str
    page_available_height_mm: float = Field(gt=0.0)
    minimum_usage_ratio: float = Field(ge=0.0, le=1.0)
    minimum_required_height_mm: float = Field(ge=0.0)
    fixed_height: FixedHeightBreakdown
    narrative_section_overheads_mm: dict[str, float] = Field(default_factory=dict)
    narrative_experience_estimates: tuple[NarrativeExperienceHeightEstimate, ...] = ()
    narrative_overhead_height_mm: float = Field(ge=0.0)
    qualified_fact_height_mm: float = Field(ge=0.0)
    global_supported_height_mm: float = Field(ge=0.0)
    supported_usage_ratio: float = Field(ge=0.0)
    missing_height_mm: float = Field(ge=0.0)
    approximate_missing_lines: int = Field(ge=0)
    total_experiences: int = Field(ge=0)
    total_facts: int = Field(ge=0)
    qualified_facts: int = Field(ge=0)
    excluded_facts: int = Field(ge=0)
    covered_requirement_ids: tuple[str, ...] = ()
    uncovered_must_have_requirement_ids: tuple[str, ...] = ()
    fact_estimates: tuple[FactHeightEstimate, ...] = ()
    warnings: tuple[str, ...] = ()
