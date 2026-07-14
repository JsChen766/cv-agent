from __future__ import annotations

from typing import Protocol


class ThreadRepository(Protocol):
    async def get_workspace_snapshot(self, thread_id: str) -> dict[str, object]: ...

    async def update_workspace_snapshot(
        self, thread_id: str, delta: dict[str, object]
    ) -> None:
        """Merge delta into existing snapshot (never drops existing keys)."""
        ...
