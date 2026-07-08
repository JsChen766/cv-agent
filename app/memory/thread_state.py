"""
ThreadState — the persisted state for a single conversation thread.

This TypedDict is the source of truth for everything the graph
needs to know about the current conversation context.
"""

from __future__ import annotations

from typing import Any, TypedDict


class MessageDict(TypedDict):
    role: str    # "user" | "assistant" | "tool"
    content: str
    turn_id: str | None


class ActiveWorkspace(TypedDict, total=False):
    active_panel: str | None       # "chat" | "canvas" | "artifact"
    jd_id: str | None
    resume_id: str | None
    experience_id: str | None
    experience_ids: list[str]
    artifact_id: str | None
    variant_id: str | None
    resume_item_id: str | None


class ThreadState(TypedDict, total=False):
    # Identity
    thread_id: str
    user_id: str

    # Conversation history
    messages: list[MessageDict]
    rolling_summary: str | None       # compressed history before the recent window
    turn_count: int

    # Active workspace (what the user is currently looking at)
    workspace: ActiveWorkspace

    # Router output (set each turn, consumed by subgraph)
    target_subgraph: str | None
    intent_description: str | None
    context_hints: list[str]
    extracted_params: dict[str, Any]
    router_confidence: float

    # Assembled context (set by context_assembly_node)
    assembled_jd_text: str | None
    assembled_experiences: list[dict[str, Any]]
    assembled_guideline_instructions: list[str]
    assembled_preferences: list[dict[str, Any]]
    assembled_user_profile: dict[str, Any] | None

    # SSE events queued during graph execution
    pending_sse_events: list[dict[str, Any]]

    # Interrupt payload (set when graph calls interrupt())
    interrupt_payload: dict[str, Any] | None

    # Turn tracking
    current_turn_id: str | None
    assistant_message: str | None
