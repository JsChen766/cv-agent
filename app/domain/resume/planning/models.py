from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.domain.resume.retrieval.models import RetrievalRequirement


class ResumePlan(BaseModel):
    plan_version: str
    requirements: tuple[RetrievalRequirement, ...]
    selected_experience_ids: tuple[str, ...]
    selected_fact_ids: tuple[str, ...]
    fact_requirement_map: dict[str, tuple[str, ...]]
    section_height_budgets_mm: dict[str, float]
    experience_height_budgets_mm: dict[str, float]
    target_candidate_lines: int = Field(ge=0)
    target_final_usage_ratio: float = Field(ge=0.0, le=1.0)
    estimated_page_height_mm: float = Field(ge=0.0)
    estimated_usage_ratio: float = Field(ge=0.0)
    objective_score: float
    selection_reasons: dict[str, tuple[str, ...]]
    rejection_reasons: dict[str, tuple[str, ...]]


class PlannerDiagnostics(BaseModel):
    considered_facts: int = Field(ge=0)
    qualified_facts: int = Field(ge=0)
    optimizer_facts: int = Field(ge=0)
    expanded_states: int = Field(ge=0)
    pruned_states: int = Field(ge=0)
    final_beam_size: int = Field(ge=0)
    beam_width: int = Field(ge=1)
    work_required: bool
    project_required: bool
    minimum_height_mm: float = Field(ge=0.0)
    target_height_mm: float = Field(ge=0.0)
    maximum_height_mm: float = Field(ge=0.0)
    maximum_reached_height_mm: float = Field(ge=0.0)
    warnings: tuple[str, ...] = ()


class ResumePlanningResult(BaseModel):
    status: Literal["ready", "infeasible"]
    plan: ResumePlan | None = None
    diagnostics: PlannerDiagnostics
    failure_reasons: tuple[str, ...] = ()
