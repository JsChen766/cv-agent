from __future__ import annotations

from typing import Protocol

from app.domain.preference.models import Preference, PreferenceSignal


class PreferenceRepository(Protocol):
    async def list(
        self,
        user_id: str,
        *,
        category: str | None = None,
        scope: str | None = None,
        active_only: bool = True,
    ) -> list[Preference]: ...

    async def get(self, user_id: str, preference_id: str) -> Preference | None: ...

    async def create(self, preference_id: str, user_id: str, data: dict) -> Preference: ...

    async def update(self, preference_id: str, patch: dict) -> Preference: ...

    async def deactivate(self, user_id: str, preference_id: str) -> None: ...

    async def find_similar(
        self, user_id: str, embedding: list[float], threshold: float
    ) -> list[Preference]: ...

    # ── Signals ───────────────────────────────────────────────────────────────
    async def add_signal(
        self, signal_id: str, user_id: str, data: dict
    ) -> PreferenceSignal: ...

    async def get_unprocessed_signals(self, user_id: str) -> list[PreferenceSignal]: ...

    async def mark_signal_processed(self, signal_id: str) -> None: ...
