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

    # Generation output
    variants: list[dict[str, Any]]

    # Self-review loop
    revision_instruction: str | None
    resume_user_action: str | None
    fact_mismatches: list[dict[str, Any]]
    resume_structure: dict[str, Any] | None
    coverage_report: dict[str, Any] | None
    uncovered_jd_requirement_ids: list[str]
