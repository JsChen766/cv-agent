from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.domain.resume.candidates.models import LengthVariant
from app.domain.resume.layout_models import LayoutReport, LayoutTuning


class CandidateMeasurement(BaseModel):
    bullet_id: str
    candidate_group_id: str
    experience_id: str
    length_variant: LengthVariant
    line_count: int = Field(ge=1)
    height_mm: float = Field(gt=0.0)
    last_line_ratio: float = Field(ge=0.0)
    fit_status: Literal["pass", "too_short", "awkward_wrap"]
    cache_key: str
    template_id: str
    profile_hash: str
    font_checksum: str


class CompilationAction(BaseModel):
    action: Literal[
        "add_candidate",
        "select_longer_variant",
        "select_shorter_variant",
        "remove_candidate",
        "tune_spacing",
    ]
    candidate_group_id: str | None = None
    bullet_id: str | None = None
    reason: str


class LayoutCompilationDiagnostics(BaseModel):
    considered_groups: int = Field(ge=0)
    considered_candidates: int = Field(ge=0)
    measured_candidates: int = Field(ge=0)
    measurement_cache_hits: int = Field(ge=0)
    measurement_cache_misses: int = Field(ge=0)
    expanded_states: int = Field(ge=0)
    pruned_states: int = Field(ge=0)
    exact_layout_calls: int = Field(ge=0)
    beam_width: int = Field(ge=1)
    fixed_height_mm: float = Field(ge=0.0)
    maximum_candidate_usage_ratio: float = Field(ge=0.0)
    final_usage_ratio: float = Field(ge=0.0)
    predicted_browser_usage_ratio: float = Field(ge=0.0)
    browser_scale: float = Field(gt=0.0)
    selected_groups: int = Field(ge=0)
    selected_candidates: int = Field(ge=0)
    unused_candidate_groups: int = Field(ge=0)
    warnings: tuple[str, ...] = ()


class CompiledResume(BaseModel):
    plan_version: str
    selected_candidate_ids: tuple[str, ...]
    selected_candidate_group_ids: tuple[str, ...]
    selected_fact_ids: tuple[str, ...]
    structured_resume: dict[str, Any]
    layout_report: LayoutReport
    layout_tuning: LayoutTuning
    actions: tuple[CompilationAction, ...]


class LayoutCompilationResult(BaseModel):
    status: Literal["compiled", "underfilled", "infeasible"]
    compiled_resume: CompiledResume | None = None
    measurements: tuple[CandidateMeasurement, ...]
    diagnostics: LayoutCompilationDiagnostics
    failure_reasons: tuple[str, ...] = ()
