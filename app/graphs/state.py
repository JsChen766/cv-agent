"""Main graph state — superset of ThreadState plus routing fields."""

from __future__ import annotations

from typing import Any, TypedDict

from app.memory.thread_state import ActiveWorkspace, MessageDict


class MainState(TypedDict, total=False):
    # Identity
    thread_id: str
    user_id: str

    # Conversation
    messages: list[MessageDict]
    rolling_summary: str | None
    turn_count: int

    # Workspace
    workspace: ActiveWorkspace

    # Router output
    target_subgraph: str | None
    intent_description: str | None
    context_hints: list[str]
    extracted_params: dict[str, Any]
    router_confidence: float

    # Assembled context (from context_assembly_node)
    assembled_jd_text: str | None
    assembled_experiences: list[dict[str, Any]]
    assembled_guideline_instructions: list[str]
    assembled_preferences: list[dict[str, Any]]
    assembled_user_profile: dict[str, Any] | None

    # Resume generation specific
    resume_variants: list[dict[str, Any]]
    current_diff: list[dict[str, Any]] | None
    review_iteration: int
    review_result: dict[str, Any] | None

    # Artifact generation specific
    artifact_type: str | None
    artifact_content: str | None
    artifact_structured: dict[str, Any] | None
    artifact_fact_mismatches: list[dict[str, Any]]
    artifact_review_iteration: int
    artifact_revision_instruction: str | None

    # Application package specific
    application_tasks: list[dict[str, Any]]
    application_deliverables: list[dict[str, Any]]
    unsupported_requirements: list[dict[str, Any]]

    # Experience import specific
    import_candidates: list[dict[str, Any]]

    # SSE / output
    pending_sse_events: list[dict[str, Any]]
    interrupt_payload: dict[str, Any] | None
    current_turn_id: str | None
    assistant_message: str | None

    # Resume conversational edit (Phase 3)
    edit_instruction: str | None
    editing_scope: str | None
    require_review_before_apply: bool | None
    edit_diff: dict[str, Any] | None
