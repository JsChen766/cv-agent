"""Resume Generation subgraph state."""

from __future__ import annotations

from typing import Any

from app.graphs.state import MainState


class ResumeGenerationState(MainState, total=False):
    # JD context
    jd_id: str | None
    jd_text: str | None
    jd_requirements: list[dict[str, Any]] | None

    # Retrieved context
    relevant_experiences: list[dict[str, Any]]
    guideline_instructions: list[str]
    evidence_pack: dict[str, Any] | None
    user_preferences: list[dict[str, Any]]
    user_profile: dict[str, Any] | None

    # Planning
    matching_plan: dict[str, Any] | None
    generation_strategy: str | None
    content_budget: dict[str, Any] | None

    # Versioned layout contract and deterministic measurement
    layout_constraint: dict[str, Any]
    layout_profile_version: str
    layout_profile_hash: str
    layout_report: dict[str, Any] | None
    layout_revision_iteration: int
    layout_status: str | None
    quality_status: str | None
    quality_issues: list[dict[str, Any]]
    coverage_before_layout: list[str]
    generation_call_count: int
    final_candidate_emitted: bool
    maximum_candidate_usage_ratio: float
    layout_fit_status: str | None

    # Generation output
    variants: list[dict[str, Any]]

    # Self-review loop
    revision_instruction: str | None
    resume_user_action: str | None
    fact_mismatches: list[dict[str, Any]]
    resume_structure: dict[str, Any] | None
    resume_candidate_pool: dict[str, Any] | None
    coverage_report: dict[str, Any] | None
    uncovered_jd_requirement_ids: list[str]

    # Phase 3: Tier 3 edit — previous structured for id reuse in _assign_structure_ids
    previous_structured: dict[str, Any] | None
