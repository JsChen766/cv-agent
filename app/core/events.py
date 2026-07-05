from __future__ import annotations

"""
SSE event type definitions.

Every event emitted over text/event-stream matches one of these TypedDicts.
The `format_sse` helper serialises an event to the wire format.

Reference: api-contract.md §3.3
"""

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


# ── Content diff events (resume canvas) ──────────────────────────────────────

class ContentDiffStartedEvent(TypedDict):
    event: Literal["content.diff.started"]
    resume_id: str
    section: str


class ContentDiffDeltaEvent(TypedDict):
    event: Literal["content.diff.delta"]
    operations: list[DiffOperation]


class ContentDiffCompletedEvent(TypedDict):
    event: Literal["content.diff.completed"]
    resume_id: str
    total_insertions: int
    total_deletions: int


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


class AgentInterruptEvent(TypedDict):
    event: Literal["agent.interrupt"]
    interrupt_id: str
    type: Literal["resume_review", "experience_import", "confirm_action"]
    message: str
    variants: list[InterruptVariantInfo]   # for resume_review
    candidates: list[dict[str, Any]]       # for experience_import
    action_options: list[InterruptActionOption]


class AgentCompletedEvent(TypedDict):
    event: Literal["agent.completed"]
    turn_id: str
    thread_id: str
    # Full CopilotChatResponse serialised here for non-streaming fallback
    response: dict[str, Any]


class AgentFailedEvent(TypedDict):
    event: Literal["agent.failed"]
    error_code: str
    message: str
    retryable: bool


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
