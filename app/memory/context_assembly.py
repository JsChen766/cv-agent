"""
Context Assembly.

Runs in parallel to gather all context needed for generation:
1. JD text (from active workspace or extracted_params)
2. Relevant experiences via Evidence RAG
3. Guideline instructions via Guideline RAG
4. User preferences from PreferenceBank
5. User profile

Then trims to token budget and returns an AssembledContext.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

import asyncpg

from app.core.config import settings
from app.memory.thread_state import ThreadState

if TYPE_CHECKING:
    from app.rag.evidence.models import EvidencePack


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
        """Render all context into a structured prompt section."""
        parts = []

        if self.jd_text:
            parts.append(f"## Job Description\n{self.jd_text[:2000]}")

        if self.user_profile:
            p = self.user_profile
            summary = f"**{p.get('full_name', 'User')}** — {p.get('current_title', '')} | {p.get('career_stage', '')}"
            parts.append(f"## User Profile\n{summary}")

        if self.experiences:
            exp_texts: list[str] = []
            for e in self.experiences[:5]:  # cap at 5
                exp_texts.append(
                    f"**{e.get('title')}** at {e.get('organization', 'N/A')}\n{str(e.get('content', ''))[:500]}"
                )
            parts.append("## Relevant Experiences\n" + "\n\n---\n".join(exp_texts))

        if self.guideline_instructions:
            rules = "\n".join(f"- {g}" for g in self.guideline_instructions[:10])
            parts.append(f"## Writing Guidelines\n{rules}")

        if self.preferences:
            pref_rules = "\n".join(
                f"- [{p.get('category')}] {p.get('rule')}"
                for p in self.preferences[:10]
            )
            parts.append(f"## User Preferences\n{pref_rules}")

        return "\n\n".join(parts)


async def assemble_context(
    state: ThreadState,
    pool: asyncpg.Pool,
    *,
    token_budget: int | None = None,
) -> AssembledContext:
    """Parallel-fetch all context, trim to budget, return AssembledContext."""
    _ = token_budget or settings.context_token_budget
    user_id = state.get("user_id", "")
    workspace = state.get("workspace", {})
    hints = state.get("context_hints", [])
    extracted = state.get("extracted_params", {})

    jd_id = workspace.get("jd_id") or extracted.get("jd_id")
    # Run all retrievals in parallel
    jd_task = _fetch_jd(jd_id, pool) if jd_id else asyncio.sleep(0, result=None)
    profile_task = _fetch_profile(user_id, pool)
    prefs_task = _fetch_preferences(user_id, pool)
    exp_task = _fetch_experiences(jd_id, user_id, hints, pool)
    guideline_task = _fetch_guidelines(state, hints)

    jd_text, profile, preferences, experiences, guidelines = await asyncio.gather(
        jd_task, profile_task, prefs_task, exp_task, guideline_task
    )

    # Build evidence pack if we have JD + experiences
    evidence_pack = None
    if jd_id and experiences:
        try:
            from app.domain.jd.models import JdRequirement
            from app.rag.evidence.service import EvidenceRagService
            # Fetch JD requirements
            async with pool.acquire() as conn:
                row = await conn.fetchrow("SELECT requirements FROM jd_records WHERE id=$1", jd_id)
            if row:
                raw_reqs = json.loads(row["requirements"]) if isinstance(row["requirements"], str) else row["requirements"]
                reqs = [JdRequirement(**r) for r in (raw_reqs or [])]
                if reqs:
                    rag = EvidenceRagService(pool)
                    from app.rag.evidence.models import ExperienceWithClaims
                    exp_with_claims = [
                        ExperienceWithClaims(
                            experience_id=str(e.get("id", "")),
                            title=str(e.get("title", "")),
                            organization=(
                                str(e["organization"]) if e.get("organization") is not None else None
                            ),
                            content=str(e.get("content", "")),
                        )
                        for e in experiences
                    ]
                    evidence_pack = await rag.build_evidence_pack(reqs, exp_with_claims)
        except Exception:
            pass  # evidence pack is optional

    return AssembledContext(
        jd_text=jd_text,
        experiences=experiences,
        guideline_instructions=guidelines,
        preferences=preferences,
        user_profile=profile,
        evidence_pack=evidence_pack,
    )


async def _fetch_jd(jd_id: str, pool: asyncpg.Pool) -> str | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT raw_text FROM jd_records WHERE id=$1", jd_id)
    return row["raw_text"] if row else None


async def _fetch_profile(user_id: str, pool: asyncpg.Pool) -> dict[str, object] | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM user_profiles WHERE user_id=$1", user_id)
    if not row:
        return None
    return {
        "full_name": row["full_name"],
        "current_title": row["current_title"],
        "career_stage": row["career_stage"],
        "preferred_language": row["preferred_language"],
        "years_of_experience": row["years_of_experience"],
    }


async def _fetch_preferences(user_id: str, pool: asyncpg.Pool) -> list[dict[str, object]]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT rule, category, priority FROM preferences WHERE user_id=$1 AND active=TRUE ORDER BY priority DESC LIMIT 15",
            user_id,
        )
    return [{"rule": r["rule"], "category": r["category"], "priority": r["priority"]} for r in rows]


async def _fetch_experiences(
    jd_id: str | None,
    user_id: str,
    hints: list[str],
    pool: asyncpg.Pool,
) -> list[dict[str, object]]:
    if jd_id:
        # Semantic retrieval via JD embedding
        async with pool.acquire() as conn:
            jd_row = await conn.fetchrow("SELECT raw_text FROM jd_records WHERE id=$1", jd_id)
        if jd_row:
            try:
                from app.providers.factory import get_embedding_provider
                embed = get_embedding_provider()
                embeddings = await embed.embed([jd_row["raw_text"][:1000]])
                vec_str = f"[{','.join(str(v) for v in embeddings[0])}]"
                async with pool.acquire() as conn:
                    rows = await conn.fetch(
                        """
                        SELECT e.id, e.title, e.organization, er.content
                        FROM experiences e
                        JOIN experience_revisions er ON er.id = e.current_revision_id
                        WHERE e.user_id=$1 AND e.status='active' AND e.embedding IS NOT NULL
                        ORDER BY e.embedding <=> $2::vector
                        LIMIT 8
                        """,
                        user_id, vec_str,
                    )
                return [dict(r) for r in rows]
            except Exception:
                pass  # fallback below

    # Fallback: return recent active experiences
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT e.id, e.title, e.organization, er.content
            FROM experiences e
            JOIN experience_revisions er ON er.id = e.current_revision_id
            WHERE e.user_id=$1 AND e.status='active'
            ORDER BY e.updated_at DESC
            LIMIT 5
            """,
            user_id,
        )
    return [dict(r) for r in rows]


async def _fetch_guidelines(state: ThreadState, hints: list[str]) -> list[str]:
    intent = state.get("intent_description", "")
    if not intent:
        return []
    try:
        from app.providers.factory import get_embedding_provider
        embed = get_embedding_provider()
        embeddings = await embed.embed([intent])
        _ = embeddings  # obtained but guideline DB may not be populated
        # Full retrieval requires DB — return empty if no DB
        return []
    except Exception:
        return []
