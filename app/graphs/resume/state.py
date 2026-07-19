"""Resume Generation subgraph state."""

from __future__ import annotations

from typing import Any

from app.graphs.state import MainState


class ResumeGenerationState(MainState, total=False):
    # Request-level observability linkage only; full metrics stay out of checkpoints.
    observability_run_id: str | None
    parent_run_id: str | None

    # JD context
    jd_id: str | None
    jd_text: str | None
    jd_requirements: list[dict[str, Any]] | None

    # Retrieved context
    relevant_experiences: list[dict[str, Any]]
    guideline_instructions: list[str]
    evidence_pack: dict[str, Any] | None
    fact_retrieval_result: dict[str, Any] | None
    user_preferences: list[dict[str, Any]]
    user_profile: dict[str, Any] | None
    resume_context_ready: bool

    # Experience selection
    selected_experiences: list[dict[str, Any]]
    experience_selection_result: dict[str, Any] | None

    # Planning
    matching_plan: dict[str, Any] | None
    generation_strategy: str | None
    content_budget: dict[str, Any] | None

    # Versioned layout contract and deterministic measurement
    layout_constraint: dict[str, Any]
    layout_profile_version: str
    layout_profile_hash: str
    layout_template_id: str
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
    local_repair_call_count: int
    local_repair_status: str | None
    local_repair_diagnostics: list[dict[str, Any]]
    local_repair_rejection_codes: list[str]
    browser_staged_variant_id: str | None
    browser_verification_status: str | None
    browser_verification_iteration: int
    browser_layout_observation: dict[str, Any] | None
    browser_layout_violations: list[dict[str, Any]]

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
