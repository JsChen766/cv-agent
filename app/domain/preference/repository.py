from __future__ import annotations

import builtins
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
    ) -> builtins.list[Preference]: ...

    async def get(self, user_id: str, preference_id: str) -> Preference | None: ...

    async def create(
        self, preference_id: str, user_id: str, data: dict[str, object]
    ) -> Preference: ...

    async def update(self, preference_id: str, patch: dict[str, object]) -> Preference: ...

    async def deactivate(self, user_id: str, preference_id: str) -> None: ...

    async def find_similar(
        self, user_id: str, embedding: builtins.list[float], threshold: float
    ) -> builtins.list[Preference]: ...

    # ── Signals ───────────────────────────────────────────────────────────────
    async def add_signal(
        self, signal_id: str, user_id: str, data: dict[str, object]
    ) -> PreferenceSignal: ...

    async def get_unprocessed_signals(self, user_id: str) -> builtins.list[PreferenceSignal]: ...

    async def mark_signal_processed(self, signal_id: str) -> None: ...
