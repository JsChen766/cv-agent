"""Artifact Generation subgraph nodes."""

from __future__ import annotations

from langchain_core.runnables import RunnableConfig

from app.core.events import ArtifactCompletedEvent, ArtifactDeltaEvent, ArtifactStartedEvent
from app.graphs.artifact.registry import get_config
from app.graphs.runtime import pool_from_config, services_from_config
from app.graphs.state import MainState
from app.providers.factory import get_provider

_ARTIFACT_PROMPTS = {
    "cover_letter": (
        "Write a compelling cover letter. It should:\n"
        "- Open with a strong hook connecting experience to the role\n"
        "- Highlight 2-3 specific achievements relevant to the JD\n"
        "- Close with a clear call to action\n"
        "Keep it under 400 words."
    ),
    "self_intro": (
        "Write a concise professional self-introduction (elevator pitch). "
        "It should cover: who you are, what you do, your key achievement, "
        "and what you're looking for. Under 150 words."
    ),
    "match_report": (
        "Analyse how well this candidate's experience matches the job requirements. "
        "For each key requirement, indicate: match level (strong/partial/missing), "
        "supporting evidence from experience, and recommendation. "
        "Include an overall match score (0-100) and 3 actionable suggestions."
    ),
    "interview_prep": (
        "Generate interview preparation material including:\n"
        "1. 5 likely interview questions based on the JD\n"
        "2. STAR-format answer frameworks for each\n"
        "3. 3 questions the candidate should ask the interviewer"
    ),
    "linkedin_summary": (
        "Write a LinkedIn 'About' section summary. It should be:\n"
        "- Written in first person\n"
        "- Start with a compelling hook\n"
        "- Highlight key expertise and achievements\n"
        "- End with what you're open to / looking for\n"
        "Under 300 words."
    ),
}


async def artifact_context_assembly_node(
    state: MainState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Fetch context for artifact generation."""
    from app.memory.context_assembly import assemble_context

    try:
        pool = pool_from_config(config)
        if pool is None:
            return {}
        ctx = await assemble_context(state, pool)
        return {
            "assembled_jd_text": ctx.jd_text,
            "assembled_experiences": ctx.experiences,
            "assembled_preferences": ctx.preferences,
            "assembled_user_profile": ctx.user_profile,
        }
    except RuntimeError:
        return {}


async def artifact_draft_node(
    state: MainState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Generate artifact content and save to DB."""
    provider = get_provider()

    raw_artifact_type = state.get("artifact_type") or state.get("extracted_params", {}).get(
        "artifact_type", "other"
    )
    artifact_type = str(raw_artifact_type or "other")
    intent = str(state.get("intent_description") or "")
    artifact_config = get_config(artifact_type)

    jd_text = state.get("assembled_jd_text") or ""
    experiences = state.get("assembled_experiences") or []
    profile = state.get("assembled_user_profile") or {}
    prefs = state.get("assembled_preferences") or []

    # Build context
    context_parts = []
    if intent:
        context_parts.append(f"User request: {intent}")
    if jd_text:
        context_parts.append(f"Job Description:\n{jd_text[:2000]}")
    if profile:
        lang = profile.get("preferred_language", "zh-CN")
        context_parts.append(f"User: {profile.get('current_title', '')} | {profile.get('career_stage', '')}")
    else:
        lang = "zh-CN"
    if experiences:
        exp_texts = [f"- {e.get('title')} at {e.get('organization', 'N/A')}: {e.get('content', '')[:300]}" for e in experiences[:4]]
        context_parts.append("Experiences:\n" + "\n".join(exp_texts))
    if prefs:
        context_parts.append("Preferences:\n" + "\n".join(f"- {p.get('rule')}" for p in prefs[:5]))

    type_prompt = _ARTIFACT_PROMPTS.get(artifact_type, "Generate the requested document.")
    lang_instruction = "Write in Chinese (Simplified)." if "zh" in lang else "Write in English."

    # Emit started event
    title = _artifact_title(artifact_type, intent)
    started_event: ArtifactStartedEvent = {
        "event": "artifact.started",
        "artifact_type": artifact_type,
        "title": title,
    }

    content = await provider.chat(
        [
            {
                "role": "system",
                "content": f"{type_prompt}\n\n{lang_instruction}\nFormat output as Markdown.",
            },
            {"role": "user", "content": "\n\n".join(context_parts)},
        ],
        temperature=0.7,
        max_tokens=artifact_config.max_tokens,
    )
    content_str = str(content)
    word_count = len(content_str.split())

    # Emit delta + completed
    delta_event: ArtifactDeltaEvent = {"event": "artifact.delta", "content": content_str}

    # Save artifact to DB
    services = services_from_config(config)
    try:
        if services is None:
            raise RuntimeError("Tool services unavailable")
        user_id = state.get("user_id", "")
        artifact = await services.artifact.create_artifact(
            user_id,
            {
                "type": artifact_type,
                "title": title,
                "content": content_str,
                "source_jd_id": state.get("workspace", {}).get("jd_id"),
                "source_experience_ids": [e.get("id") for e in experiences],
            },
        )
        real_artifact_id = artifact.id
    except Exception:
        real_artifact_id = f"artifact-temp-{artifact_type}"

    completed_event: ArtifactCompletedEvent = {
        "event": "artifact.completed",
        "artifact_id": real_artifact_id,
        "title": title,
        "word_count": word_count,
    }

    existing_events = state.get("pending_sse_events", [])

    return {
        "artifact_type": artifact_type,
        "artifact_content": content_str,
        "assistant_message": f"I've created your {artifact_type.replace('_', ' ')}. You can view and edit it in the artifact panel.",
        "pending_sse_events": [*existing_events, started_event, delta_event, completed_event],
    }


def _artifact_title(artifact_type: str, intent: str) -> str:
    titles = {
        "cover_letter": "Cover Letter",
        "self_intro": "Self Introduction",
        "match_report": "JD Match Report",
        "interview_prep": "Interview Preparation",
        "linkedin_summary": "LinkedIn Summary",
    }
    return titles.get(artifact_type, intent[:50] or "Document")
