from __future__ import annotations

import asyncpg

from app.infra.db.helpers import parse_jsonb


class PostgresThreadRepository:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get_workspace_snapshot(self, thread_id: str) -> dict[str, object]:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT workspace_snapshot FROM threads WHERE id=$1",
                thread_id,
            )
        if row is None:
            return {}
        raw = parse_jsonb(row["workspace_snapshot"])
        return raw if isinstance(raw, dict) else {}

    async def update_workspace_snapshot(
        self, thread_id: str, delta: dict[str, object]
    ) -> None:
        """Merge delta into existing snapshot using SQL-level JSONB concatenation.

        Pass delta as a plain dict — the connection pool's jsonb codec
        (encoder=json.dumps) handles serialization. Passing json.dumps(delta)
        would cause double-encoding (str → JSON string, not object).
        """
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE threads
                SET workspace_snapshot = COALESCE(workspace_snapshot, '{}'::jsonb) || $1::jsonb
                WHERE id = $2
                """,
                delta,
                thread_id,
            )
