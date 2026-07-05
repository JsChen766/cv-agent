"""
Experience Import subgraph nodes.

Flow: parse_node → review_node → interrupt (user confirms/edits) → save_node
"""

from __future__ import annotations

from typing import Any

from langchain_core.runnables import RunnableConfig

from app.core.events import AgentInterruptEvent
from app.graphs.runtime import services_from_config
from app.graphs.state import MainState
from app.providers.factory import get_provider

# ── Parse node ─────────────────────────────────────────────────────────────────


async def parse_import_node(state: MainState) -> dict[str, Any]:
    """
    Parse raw experience text/content supplied by the user into structured
    candidate experiences.  The LLM extracts a list of structured experience
    objects that the user will review before saving.
    """
    from pydantic import BaseModel

    provider = get_provider()

    user_content = ""
    messages = state.get("messages", [])
    for msg in reversed(messages):
        if msg.get("role") == "user":
            user_content = msg.get("content", "")
            break

    extracted_params = state.get("extracted_params", {})
    raw_text = extracted_params.get("raw_text") or user_content

    class ExperienceCandidate(BaseModel):
        title: str
        organization: str
        start_date: str | None = None
        end_date: str | None = None
        content: str
        category: str = "work"

    class CandidateList(BaseModel):
        candidates: list[ExperienceCandidate]

    result: CandidateList = await provider.chat_structured(
        [
            {
                "role": "system",
                "content": (
                    "Extract work/project/education experiences from the provided text. "
                    "For each experience return: title, organization, start_date (YYYY-MM or null), "
                    "end_date (YYYY-MM or 'present' or null), content (detailed description), "
                    "category (work|project|education|volunteer|other). "
                    "Return a JSON object with a 'candidates' array."
                ),
            },
            {"role": "user", "content": raw_text},
        ],
        CandidateList,
        temperature=0.1,
    )

    candidates = [c.model_dump() for c in result.candidates]

    existing = state.get("pending_sse_events", [])
    thinking_event = {
        "event": "agent.thinking",
        "text": f"Found {len(candidates)} experience(s) to import. Please review before saving.",
    }
    return {
        "import_candidates": candidates,
        "pending_sse_events": [*existing, thinking_event],
    }


# ── Review node (interrupt) ───────────────────────────────────────────────────


async def review_import_node(state: MainState) -> dict[str, Any]:
    """
    Present candidates to the user via interrupt() so they can confirm,
    edit, or discard each candidate before it is saved.
    """
    from langgraph.types import interrupt

    candidates = state.get("import_candidates", [])

    interrupt_payload: AgentInterruptEvent = {
        "event": "agent.interrupt",
        "interrupt_type": "experience_import_review",
        "data": {
            "candidates": candidates,
            "message": (
                f"I've extracted {len(candidates)} experience(s) from your input. "
                "Please review and confirm which to save (you can edit any field)."
            ),
        },
    }

    existing = state.get("pending_sse_events", [])
    new_state = {
        "interrupt_payload": interrupt_payload,
        "pending_sse_events": [*existing, dict(interrupt_payload)],
    }

    # This suspends graph execution; resumption passes a dict with
    # {"confirmed_candidates": [...]} back into the state.
    resume_value = interrupt(interrupt_payload)
    confirmed = resume_value.get("confirmed_candidates", candidates) if isinstance(resume_value, dict) else candidates

    return {**new_state, "import_candidates": confirmed, "interrupt_payload": None}


# ── Save node ─────────────────────────────────────────────────────────────────


async def save_import_node(state: MainState, config: RunnableConfig = None) -> dict[str, Any]:
    """
    Persist confirmed candidates to the database via ExperienceService.
    Embeds content for RAG after saving.
    """
    candidates = state.get("import_candidates", [])
    user_id = state.get("user_id", "")

    saved_ids: list[str] = []

    try:
        services = services_from_config(config)
        if services is None:
            raise RuntimeError("Tool services unavailable")

        for candidate in candidates:
            exp = await services.experience.create_experience(
                user_id,
                category=candidate.get("category", "work"),
                title=candidate.get("title", "Untitled experience"),
                content=candidate.get("content", ""),
                organization=candidate.get("organization"),
                role=candidate.get("role"),
                start_date=candidate.get("start_date"),
                end_date=candidate.get("end_date"),
                tags=candidate.get("tags"),
                source="import",
            )
            saved_ids.append(exp.id)

    except Exception as exc:
        existing = state.get("pending_sse_events", [])
        return {
            "assistant_message": f"Failed to save experiences: {exc}",
            "pending_sse_events": existing,
        }

    existing = state.get("pending_sse_events", [])
    completed_event = {
        "event": "agent.completed",
        "message": f"Successfully saved {len(saved_ids)} experience(s).",
        "data": {"saved_ids": saved_ids},
    }
    return {
        "assistant_message": f"Saved {len(saved_ids)} experience(s) to your profile.",
        "pending_sse_events": [*existing, completed_event],
    }
