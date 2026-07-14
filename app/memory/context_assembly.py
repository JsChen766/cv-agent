"""Context assembly for generation subgraphs.

Domain services provide owned user data; RAG services provide guideline and
evidence retrieval. The resulting context is trimmed before it enters graph
state so every downstream prompt observes the configured budget.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

import asyncpg

from app.core.config import settings
from app.memory.thread_state import ThreadState

if TYPE_CHECKING:
    from app.domain.jd.models import JdRecord
    from app.rag.evidence.models import EvidencePack, ExperienceWithClaims
    from app.tools.base import ServiceContainer

logger = logging.getLogger(__name__)


class AssembledContext:
    def __init__(
        self,
        jd_text: str | None,
        experiences: list[dict[str, object]],
        guideline_instructions: list[str],
        preferences: list[dict[str, object]],
        user_profile: dict[str, object] | None,
        evidence_pack: EvidencePack | None,
    ) -> None:
        self.jd_text = jd_text
        self.experiences = experiences
        self.guideline_instructions = guideline_instructions
        self.preferences = preferences
        self.user_profile = user_profile
        self.evidence_pack = evidence_pack

    def to_prompt_block(self) -> str:
        parts: list[str] = []

        if self.jd_text:
            parts.append(f"## Job Description\n{self.jd_text}")

        if self.user_profile:
            profile = self.user_profile
            summary = (
                f"**{profile.get('full_name', 'User')}** — "
                f"{profile.get('current_title', '')} | {profile.get('career_stage', '')}"
            )
            parts.append(f"## User Profile\n{summary}")

        if self.experiences:
            exp_texts = [
                (
                    f"**{experience.get('title')}** at "
                    f"{experience.get('organization', 'N/A')}\n"
                    f"{experience.get('content', '')}"
                )
                for experience in self.experiences
            ]
            parts.append("## Relevant Experiences\n" + "\n\n---\n".join(exp_texts))

        if self.guideline_instructions:
            rules = "\n".join(f"- {rule}" for rule in self.guideline_instructions)
            parts.append(f"## Writing Guidelines\n{rules}")

        if self.preferences:
            pref_rules = "\n".join(
                f"- [{preference.get('category')}] {preference.get('rule')}"
                for preference in self.preferences
            )
            parts.append(f"## User Preferences\n{pref_rules}")

        return "\n\n".join(parts)


async def assemble_context(
    state: ThreadState,
    pool: asyncpg.Pool,
    *,
    services: ServiceContainer | None = None,
    token_budget: int | None = None,
) -> AssembledContext:
    """Fetch owned context in parallel and trim it to the requested budget."""
    budget = settings.context_token_budget if token_budget is None else max(0, token_budget)
    user_id = state.get("user_id", "")
    workspace = state.get("workspace", {})
    extracted = state.get("extracted_params", {})
    jd_id_value = workspace.get("jd_id") or extracted.get("jd_id")
    jd_id = jd_id_value if isinstance(jd_id_value, str) and jd_id_value else None

    if services is None:
        logger.warning("Context assembly skipped owned data because domain services are unavailable")
        guidelines = await _fetch_guidelines(state, pool)
        return _trim_context(
            AssembledContext(None, [], guidelines, [], None, None),
            budget,
        )

    jd_task = asyncio.create_task(_fetch_jd(services, user_id, jd_id))
    profile_task = asyncio.create_task(_fetch_profile(services, user_id))
    preferences_task = asyncio.create_task(_fetch_preferences(services, user_id))
    experience_task = asyncio.create_task(
        _fetch_experience_context(services, pool, user_id, jd_task)
    )

    guideline_task = asyncio.create_task(_fetch_guidelines(state, pool))
    jd, profile, preferences, experience_context, guidelines = await asyncio.gather(
        jd_task,
        profile_task,
        preferences_task,
        experience_task,
        guideline_task,
    )
    experiences, evidence_pack = experience_context
    context = AssembledContext(
        jd_text=jd.raw_text if jd is not None else None,
        experiences=experiences,
        guideline_instructions=guidelines,
        preferences=preferences,
        user_profile=profile,
        evidence_pack=evidence_pack,
    )
    return _trim_context(context, budget)


async def _fetch_jd(
    services: ServiceContainer, user_id: str, jd_id: str | None
) -> JdRecord | None:
    if jd_id is None:
        return None
    # JdService performs the ownership check. Never trust workspace IDs directly.
    return await services.jd.get_jd(user_id, jd_id)


async def _fetch_profile(
    services: ServiceContainer, user_id: str
) -> dict[str, object] | None:
    profile = await services.user.get_profile(user_id)
    return profile.model_dump(mode="json", exclude_none=True)


async def _fetch_preferences(
    services: ServiceContainer, user_id: str
) -> list[dict[str, object]]:
    preferences = await services.preference.get_active_preferences(user_id)
    return [
        {
            "rule": preference.rule,
            "category": preference.category,
            "priority": preference.priority,
        }
        for preference in preferences[:15]
    ]


async def _fetch_experience_context(
    services: ServiceContainer,
    pool: asyncpg.Pool,
    user_id: str,
    jd_task: asyncio.Task[JdRecord | None],
) -> tuple[list[dict[str, object]], EvidencePack | None]:
    from app.rag.evidence.service import EvidenceRagService

    jd = await jd_task
    rag = EvidenceRagService(pool)
    if jd is not None and jd.requirements:
        # Wide retrieval: pull 20 nearest work/project/other by JD similarity so we can
        # keep every experience that is even tangentially related. Cheap page-length
        # trimming happens in the resume generator, not here.
        jd_retrieved = await rag.retrieve_for_jd(jd.requirements, user_id, top_k=20)
        evidence_pack = await rag.build_evidence_pack(jd.requirements, jd_retrieved)
    else:
        jd_retrieved = await rag.retrieve_recent(user_id, top_k=15)
        evidence_pack = None

    # Education is not JD-filtered: every education entry must always be available to
    # the resume generator, regardless of similarity ranking.
    education = await rag.retrieve_by_category(user_id, "education")

    merged: dict[str, ExperienceWithClaims] = {}
    for experience in jd_retrieved:
        merged[experience.experience_id] = experience
    for experience in education:
        merged.setdefault(experience.experience_id, experience)

    experiences: list[dict[str, object]] = []
    for experience in merged.values():
        experiences.append(
            {
                "id": experience.experience_id,
                "title": experience.title,
                "organization": experience.organization,
                "role": experience.role,
                "category": experience.category,
                "start_date": experience.start_date,
                "end_date": experience.end_date,
                "tags": experience.tags,
                "content": experience.content,
                "claims": [claim.model_dump(mode="json") for claim in experience.claims],
                "relevance_score": experience.relevance_score,
            }
        )
    return experiences, evidence_pack


async def _fetch_guidelines(state: ThreadState, pool: asyncpg.Pool) -> list[str]:
    intent = state.get("intent_description", "")
    if not intent:
        return []
    hints = state.get("context_hints", [])
    query = " | ".join([intent, *hints]) if hints else intent
    try:
        from app.rag.guideline.service import GuidelineRagService

        return await GuidelineRagService(pool).retrieve(query, top_k=5)
    except Exception as exc:
        # Guidelines are optional; preserve generation while making degradation observable.
        logger.warning("Guideline retrieval failed: %s", exc)
        return []


def _trim_context(context: AssembledContext, token_budget: int) -> AssembledContext:
    """Apply a deterministic character approximation (~4 chars/token)."""
    char_budget = token_budget * 4
    if char_budget <= 0:
        context.jd_text = None
        context.experiences = []
        context.guideline_instructions = []
        context.preferences = []
        context.user_profile = None
        context.evidence_pack = None
        return context

    jd_quota = int(char_budget * 0.30)
    experience_quota = int(char_budget * 0.50)
    guideline_quota = int(char_budget * 0.10)
    preference_quota = char_budget - jd_quota - experience_quota - guideline_quota

    if context.jd_text:
        context.jd_text = context.jd_text[:jd_quota]

    context.experiences = _trim_dict_items(
        context.experiences,
        content_key="content",
        quota=experience_quota,
        limit=25,
    )
    context.guideline_instructions = _trim_strings(
        context.guideline_instructions, guideline_quota, limit=10
    )
    context.preferences = _trim_dict_items(
        context.preferences,
        content_key="rule",
        quota=preference_quota,
        limit=10,
    )
    return context


def _trim_strings(values: list[str], quota: int, *, limit: int) -> list[str]:
    result: list[str] = []
    remaining = quota
    for value in values[:limit]:
        if remaining <= 0:
            break
        clipped = value[:remaining]
        if clipped:
            result.append(clipped)
            remaining -= len(clipped)
    return result


def _trim_dict_items(
    values: list[dict[str, object]],
    *,
    content_key: str,
    quota: int,
    limit: int,
) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    remaining = quota
    for value in values[:limit]:
        if remaining <= 0:
            break
        item = dict(value)
        content = str(item.get(content_key, ""))
        clipped = content[:remaining]
        item[content_key] = clipped
        remaining -= len(clipped)
        result.append(item)
    return result
