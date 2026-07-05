from __future__ import annotations

import json

import asyncpg

from app.domain.preference.models import Preference, PreferenceSignal
from app.infra.db.helpers import parse_jsonb


class PostgresPreferenceRepository:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def list(
        self,
        user_id: str,
        *,
        category: str | None = None,
        scope: str | None = None,
        active_only: bool = True,
    ) -> list[Preference]:
        conditions = ["user_id = $1"]
        values: list = [user_id]
        idx = 2
        if active_only:
            conditions.append("active = TRUE")
        if category:
            conditions.append(f"category = ${idx}")
            values.append(category)
            idx += 1
        if scope:
            conditions.append(f"(scope = ${idx} OR scope = 'global')")
            values.append(scope)
            idx += 1
        sql = f"""
            SELECT * FROM preferences WHERE {' AND '.join(conditions)}
            ORDER BY priority DESC, last_reinforced_at DESC
        """
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(sql, *values)
        return [self._to_pref(r) for r in rows]

    async def get(self, user_id: str, preference_id: str) -> Preference | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM preferences WHERE id=$1 AND user_id=$2",
                preference_id, user_id,
            )
        return self._to_pref(row) if row else None

    async def create(self, preference_id: str, user_id: str, data: dict) -> Preference:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO preferences
                    (id, user_id, rule, category, source, priority,
                     confidence, reinforcement_count, scope, active)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                RETURNING *
                """,
                preference_id, user_id,
                data["rule"], data["category"], data["source"],
                data.get("priority", 50), data.get("confidence", 1.0),
                data.get("reinforcement_count", 1), data.get("scope", "global"),
                data.get("active", True),
            )
        return self._to_pref(row)  # type: ignore[arg-type]

    async def update(self, preference_id: str, patch: dict) -> Preference:
        allowed = {"rule", "confidence", "reinforcement_count", "active", "priority"}
        set_parts, values = [], []
        idx = 1
        for k, v in patch.items():
            if k in allowed:
                set_parts.append(f"{k} = ${idx}")
                values.append(v)
                idx += 1
        if not set_parts:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow("SELECT * FROM preferences WHERE id=$1", preference_id)
            return self._to_pref(row)  # type: ignore[arg-type]
        set_parts.append("last_reinforced_at = NOW()")
        values.append(preference_id)
        sql = f"UPDATE preferences SET {', '.join(set_parts)} WHERE id=${idx} RETURNING *"
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(sql, *values)
        return self._to_pref(row)  # type: ignore[arg-type]

    async def deactivate(self, user_id: str, preference_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE preferences SET active=FALSE WHERE id=$1 AND user_id=$2",
                preference_id, user_id,
            )

    async def find_similar(
        self, user_id: str, embedding: list[float], threshold: float
    ) -> list[Preference]:
        """Find preferences with cosine similarity above threshold."""
        vec = f"[{','.join(str(v) for v in embedding)}]"
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT *, 1 - (embedding <=> $1::vector) AS similarity
                FROM preferences
                WHERE user_id=$2 AND active=TRUE AND embedding IS NOT NULL
                  AND 1 - (embedding <=> $1::vector) > $3
                ORDER BY similarity DESC
                LIMIT 5
                """,
                vec, user_id, threshold,
            )
        return [self._to_pref(r) for r in rows]

    # ── Signals ───────────────────────────────────────────────────────────────

    async def add_signal(
        self, signal_id: str, user_id: str, data: dict
    ) -> PreferenceSignal:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO preference_signals
                    (id, user_id, signal_type, raw_content, generation_context, processed)
                VALUES ($1,$2,$3,$4,$5::jsonb,$6)
                RETURNING *
                """,
                signal_id, user_id,
                data["signal_type"], data["raw_content"],
                json.dumps(data.get("generation_context", {})),
                data.get("processed", False),
            )
        return self._to_signal(row)  # type: ignore[arg-type]

    async def get_unprocessed_signals(self, user_id: str) -> list[PreferenceSignal]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM preference_signals WHERE user_id=$1 AND processed=FALSE ORDER BY created_at",
                user_id,
            )
        return [self._to_signal(r) for r in rows]

    async def mark_signal_processed(self, signal_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE preference_signals SET processed=TRUE WHERE id=$1", signal_id
            )

    # ── Mappers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _to_pref(row: asyncpg.Record) -> Preference:
        return Preference(
            id=row["id"],
            user_id=row["user_id"],
            rule=row["rule"],
            category=row["category"],
            source=row["source"],
            priority=row["priority"],
            confidence=row["confidence"],
            reinforcement_count=row["reinforcement_count"],
            scope=row["scope"],
            active=row["active"],
            created_at=row["created_at"],
            last_reinforced_at=row["last_reinforced_at"],
        )

    @staticmethod
    def _to_signal(row: asyncpg.Record) -> PreferenceSignal:
        return PreferenceSignal(
            id=row["id"],
            user_id=row["user_id"],
            signal_type=row["signal_type"],
            raw_content=row["raw_content"],
            generation_context=parse_jsonb(row["generation_context"]) or {},
            processed=row["processed"],
            created_at=row["created_at"],
        )
