from __future__ import annotations

from app.core.errors import NotFoundError
from app.core.types import PREF_PREFIX, generate_id
from app.domain.preference.models import Preference, PreferenceSignal
from app.domain.preference.repository import PreferenceRepository


class PreferenceService:
    def __init__(self, repo: PreferenceRepository) -> None:
        self._repo = repo

    # ── Query ─────────────────────────────────────────────────────────────────

    async def get_active_preferences(
        self,
        user_id: str,
        *,
        category: str | None = None,
        scope: str | None = None,
    ) -> list[Preference]:
        """Return active preferences sorted by priority DESC."""
        prefs = await self._repo.list(
            user_id, category=category, scope=scope, active_only=True
        )
        return sorted(prefs, key=lambda p: p.priority, reverse=True)

    # ── Explicit preference management ────────────────────────────────────────

    async def add_explicit_preference(
        self,
        user_id: str,
        *,
        rule: str,
        category: str,
        scope: str = "global",
    ) -> Preference:
        pref_id = generate_id(PREF_PREFIX)
        return await self._repo.create(
            pref_id,
            user_id,
            {
                "rule": rule,
                "category": category,
                "source": "explicit",
                "priority": 100,
                "confidence": 1.0,
                "reinforcement_count": 1,
                "scope": scope,
                "active": True,
            },
        )

    async def delete_preference(self, user_id: str, preference_id: str) -> None:
        pref = await self._repo.get(user_id, preference_id)
        if not pref:
            raise NotFoundError(f"Preference not found: {preference_id}")
        await self._repo.deactivate(user_id, preference_id)

    # ── Signal recording ──────────────────────────────────────────────────────

    async def record_signal(
        self,
        user_id: str,
        *,
        signal_type: str,
        raw_content: str,
        context: dict | None = None,
    ) -> PreferenceSignal:
        signal_id = generate_id("sig-")
        return await self._repo.add_signal(
            signal_id,
            user_id,
            {
                "signal_type": signal_type,
                "raw_content": raw_content,
                "generation_context": context or {},
                "processed": False,
            },
        )

    # ── Signal processing (called by graph layer after LLM extraction) ────────

    async def upsert_from_extraction(
        self,
        user_id: str,
        *,
        rule: str,
        category: str,
        source: str,
        priority: int,
        confidence: float,
        scope: str = "global",
        embedding: list[float],
    ) -> Preference:
        """
        Check for duplicate via embedding similarity.
        If similar preference found: reinforce it.
        Otherwise: create new.
        """
        from app.core.config import settings

        similar = await self._repo.find_similar(
            user_id, embedding, settings.preference_dedup_threshold
        )
        if similar:
            existing = similar[0]
            return await self._repo.update(
                existing.id,
                {
                    "reinforcement_count": existing.reinforcement_count + 1,
                    "confidence": min(1.0, existing.confidence + 0.05),
                },
            )

        pref_id = generate_id(PREF_PREFIX)
        return await self._repo.create(
            pref_id,
            user_id,
            {
                "rule": rule,
                "category": category,
                "source": source,
                "priority": priority,
                "confidence": confidence,
                "reinforcement_count": 1,
                "scope": scope,
                "active": True,
            },
        )
