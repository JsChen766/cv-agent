"""
SSE event type definitions.

Every event emitted over text/event-stream matches one of these TypedDicts.
The `format_sse` helper serialises an event to the wire format.

Reference: api-contract.md §3.3
"""

from __future__ import annotations

import json
from typing import Any, Literal, TypedDict

# ── Payload sub-types ─────────────────────────────────────────────────────────


class DiffOperation(TypedDict):
    op: Literal["insert", "delete", "equal"]
    text: str


class ScoreBreakdown(TypedDict):
    overall: float
    relevance: float
    clarity: float
    evidence_strength: float
    quantified_impact: float


# ── Agent lifecycle events ────────────────────────────────────────────────────


class AgentTurnStartedEvent(TypedDict):
    event: Literal["agent.turn.started"]
    turn_id: str
    thread_id: str
    timestamp: str


class AgentThinkingEvent(TypedDict):
    event: Literal["agent.thinking"]
    text: str


class AgentRouteCompletedEvent(TypedDict):
    event: Literal["agent.route.completed"]
    target: str  # RouterTarget
    intent_description: str
    confidence: float


class AgentNodeStartedEvent(TypedDict):
    event: Literal["agent.node.started"]
    node: str
    description: str


class AgentNodeCompletedEvent(TypedDict):
    event: Literal["agent.node.completed"]
    node: str
    duration_ms: int


# ── Tool events ───────────────────────────────────────────────────────────────


class AgentToolStartedEvent(TypedDict):
    event: Literal["agent.tool.started"]
    tool: str
    input: dict[str, Any]


class AgentToolCompletedEvent(TypedDict):
    event: Literal["agent.tool.completed"]
    tool: str
    result_summary: str


class AgentToolFailedEvent(TypedDict):
    event: Literal["agent.tool.failed"]
    tool: str
    error: str


class AgentActivityToolInfo(TypedDict):
    name: str
    label: str
    status: Literal["running", "waiting_user", "completed", "failed"]


class AgentActivityUpdatedEvent(TypedDict, total=False):
    event: Literal["agent.activity.updated"]
    thread_id: str | None
    turn_id: str | None
    sequence: int
    timestamp: str
    agent_role: Literal[
        "frontdesk",
        "experience_orchestrator",
        "jd_analyst",
        "resume_writer",
        "resume_reviewer",
    ]
    agent_label: str
    status: Literal["running", "waiting_user", "completed", "failed"]
    action: str
    tool: AgentActivityToolInfo


# ── Content diff events (resume canvas) ──────────────────────────────────────


class ContentDiffStartedEvent(TypedDict, total=False):
    event: Literal["content.diff.started"]
    resume_id: str
    section: str  # legacy; optional
    variant_id: str  # Phase 3: new variant id


class ContentDiffDeltaEvent(TypedDict, total=False):
    event: Literal["content.diff.delta"]
    operations: list[DiffOperation]
    structured: dict[str, Any]  # Phase 3: full new structured
    diff: dict[str, Any]  # Phase 3: changed/added/removed id sets


class ContentDiffCompletedEvent(TypedDict, total=False):
    event: Literal["content.diff.completed"]
    resume_id: str
    total_insertions: int
    total_deletions: int  # legacy; optional
    variant_id: str  # Phase 3: new variant id
    diff: dict[str, Any]  # Phase 3: changed/added/removed id sets


# ── Artifact events ───────────────────────────────────────────────────────────


class ArtifactStartedEvent(TypedDict):
    event: Literal["artifact.started"]
    artifact_type: str
    title: str


class ArtifactDeltaEvent(TypedDict):
    event: Literal["artifact.delta"]
    content: str  # markdown chunk


class ArtifactCompletedEvent(TypedDict):
    event: Literal["artifact.completed"]
    artifact_id: str
    title: str
    word_count: int


# ── Message streaming ─────────────────────────────────────────────────────────


class AgentMessageDeltaEvent(TypedDict):
    event: Literal["agent.message.delta"]
    content: str  # text chunk


class AgentMessageCompletedEvent(TypedDict):
    event: Literal["agent.message.completed"]
    content: str  # full assistant message


# ── Interrupt / completion / failure ─────────────────────────────────────────


class InterruptActionOption(TypedDict):
    id: str
    label: str
    description: str


class InterruptVariantInfo(TypedDict):
    id: str
    title: str
    score: ScoreBreakdown


class _AgentInterruptBase(TypedDict):
    event: Literal["agent.interrupt"]
    interrupt_id: str
    type: Literal[
        "resume_review",
        "application_package_review",
        "experience_import",
        "confirm_action",
        "jd_save",
        "resume_edit_review",
        "resume_content_gap",
        "resume_layout_verification",
    ]
    message: str
    action_options: list[InterruptActionOption]


class AgentInterruptEvent(_AgentInterruptBase, total=False):
    variants: list[InterruptVariantInfo]  # deprecated for resume_review; always []
    resume: dict[str, Any] | None  # for resume_review / application_package_review — single draft
    candidates: list[dict[str, Any]]  # for experience_import
    candidate: dict[str, Any]  # for jd_save
    diff: dict[str, Any] | None  # for resume_edit_review — changed id sets
    current_usage_ratio: float  # for resume_content_gap
    target_usage_ratio: float  # for resume_content_gap
    missing_height_mm: float  # for resume_content_gap
    approximate_missing_lines: int  # for resume_content_gap
    suggestions: list[dict[str, Any]]  # for resume_content_gap
    verification_iteration: int  # for resume_layout_verification


class AgentCompletedEvent(TypedDict):
    event: Literal["agent.completed"]
    turn_id: str
    thread_id: str
    # Full CopilotChatResponse serialised here for non-streaming fallback
    response: dict[str, Any]


class AgentFailedError(TypedDict):
    code: str
    message: str
    node: str | None


class AgentFailedEvent(TypedDict):
    event: Literal["agent.failed"]
    error: AgentFailedError


# ── Union type ────────────────────────────────────────────────────────────────

SSEEvent = (
    AgentTurnStartedEvent
    | AgentThinkingEvent
    | AgentRouteCompletedEvent
    | AgentNodeStartedEvent
    | AgentNodeCompletedEvent
    | AgentToolStartedEvent
    | AgentToolCompletedEvent
    | AgentToolFailedEvent
    | AgentActivityUpdatedEvent
    | ContentDiffStartedEvent
    | ContentDiffDeltaEvent
    | ContentDiffCompletedEvent
    | ArtifactStartedEvent
    | ArtifactDeltaEvent
    | ArtifactCompletedEvent
    | AgentMessageDeltaEvent
    | AgentMessageCompletedEvent
    | AgentInterruptEvent
    | AgentCompletedEvent
    | AgentFailedEvent
)


# ── Serialisation ─────────────────────────────────────────────────────────────


def format_sse(event: dict[str, Any]) -> str:
    """Serialise an event dict to the SSE wire format.

    Result format::

        event: agent.thinking
        data: {"event": "agent.thinking", "text": "..."}

    """
    event_type = event.get("event", "message")
    data = json.dumps(event, ensure_ascii=False)
    return f"event: {event_type}\ndata: {data}\n\n"
