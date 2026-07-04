"""
Router Node.

A lightweight one-shot structured LLM call that analyses the user's
latest message + thread context and decides which subgraph to invoke.
"""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel

from app.core.events import AgentRouteCompletedEvent
from app.graphs.state import MainState
from app.providers.factory import get_provider


class RouterOutput(BaseModel):
    target_subgraph: Literal[
        "experience_import", "jd", "resume_generation", "artifact", "open_ended"
    ]
    intent_description: str
    artifact_type: str | None = None
    context_hints: list[str] = []
    extracted_params: dict[str, Any] = {}
    confidence: float = 0.8


_ROUTER_SYSTEM = """You are a routing agent for a resume assistant application.

Analyse the user's message and determine which subgraph should handle it:

- "experience_import": User wants to add/import work experiences, paste resume content, or upload a file with experiences.
- "jd": User wants to save, manage, or discuss a job description.
- "resume_generation": User wants to generate, improve, or modify their resume.
- "artifact": User wants to create a cover letter, self-introduction, LinkedIn summary, match report, interview prep, or any other document artifact.
- "open_ended": General questions, career advice, follow-up questions, or anything that doesn't fit the above.

Also extract:
- intent_description: a clear 1-sentence description of what the user wants (used as generation prompt)
- artifact_type: if target is "artifact", one of: cover_letter, self_intro, match_report, interview_prep, linkedin_summary, other
- context_hints: list of context elements needed (e.g. ["active_jd", "experiences", "profile"])
- extracted_params: any structured params extracted (e.g. {"jd_id": "...", "target_role": "..."})
- confidence: your confidence in this routing decision (0.0-1.0)

If confidence < 0.6, use "open_ended".
"""


async def router_node(state: MainState) -> dict:
    """Determine target subgraph from latest user message."""
    messages = state.get("messages", [])
    if not messages:
        return {"target_subgraph": "open_ended", "intent_description": "", "router_confidence": 0.5}

    # Build context summary for router
    workspace = state.get("workspace", {})
    context_parts = []
    if workspace.get("jd_id"):
        context_parts.append(f"Active JD: {workspace['jd_id']}")
    if workspace.get("resume_id"):
        context_parts.append(f"Active Resume: {workspace['resume_id']}")
    rolling_summary = state.get("rolling_summary")
    if rolling_summary:
        context_parts.append(f"Conversation summary: {rolling_summary}")

    # Last few messages for context
    recent = messages[-4:] if len(messages) > 4 else messages
    history = "\n".join(f"{m['role'].upper()}: {m['content'][:200]}" for m in recent)

    context_str = "\n".join(context_parts) if context_parts else "No active context."
    user_msg = messages[-1]["content"] if messages[-1]["role"] == "user" else ""

    provider = get_provider()
    routing: RouterOutput = await provider.chat_structured(
        [
            {"role": "system", "content": _ROUTER_SYSTEM},
            {
                "role": "user",
                "content": (
                    f"Current context:\n{context_str}\n\n"
                    f"Recent conversation:\n{history}\n\n"
                    f"Latest user message: {user_msg}"
                ),
            },
        ],
        RouterOutput,
        temperature=0.1,
    )

    # Emit routing event
    route_event: AgentRouteCompletedEvent = {
        "event": "agent.route.completed",
        "target": routing.target_subgraph,
        "intent_description": routing.intent_description,
        "confidence": routing.confidence,
    }
    existing_events = state.get("pending_sse_events", [])

    return {
        "target_subgraph": routing.target_subgraph,
        "intent_description": routing.intent_description,
        "artifact_type": routing.artifact_type,
        "context_hints": routing.context_hints,
        "extracted_params": routing.extracted_params,
        "router_confidence": routing.confidence,
        "pending_sse_events": [*existing_events, route_event],
    }


def route_decision(state: MainState) -> str:
    """Conditional edge: returns the target subgraph name."""
    return state.get("target_subgraph") or "open_ended"
