from __future__ import annotations

import json

import asyncpg

from app.domain.artifact.models import Artifact
from app.infra.db.helpers import parse_jsonb


class PostgresArtifactRepository:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def list(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
        type: str | None = None,
    ) -> tuple[list[Artifact], str | None]:
        conditions = ["user_id = $1"]
        values: list = [user_id]
        idx = 2
        if cursor:
            conditions.append(f"id > ${idx}")
            values.append(cursor)
            idx += 1
        if type:
            conditions.append(f"type = ${idx}")
            values.append(type)
            idx += 1
        values.append(limit + 1)
        sql = f"""
            SELECT * FROM artifacts WHERE {' AND '.join(conditions)}
            ORDER BY updated_at DESC, id LIMIT ${idx}
        """
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(sql, *values)
        has_more = len(rows) > limit
        items = [self._to_artifact(r) for r in rows[:limit]]
        return items, items[-1].id if has_more else None

    async def get(self, user_id: str, artifact_id: str) -> Artifact | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM artifacts WHERE id=$1 AND user_id=$2", artifact_id, user_id
            )
        return self._to_artifact(row) if row else None

    async def create(self, artifact_id: str, user_id: str, data: dict) -> Artifact:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO artifacts
                    (id, user_id, type, title, content, source_jd_id,
                     source_experience_ids, word_count)
                VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
                RETURNING *
                """,
                artifact_id, user_id,
                data.get("type", "other"),
                data.get("title", ""),
                data.get("content", ""),
                data.get("source_jd_id"),
                json.dumps(data.get("source_experience_ids", [])),
                data.get("word_count", 0),
            )
        return self._to_artifact(row)  # type: ignore[arg-type]

    async def update(self, user_id: str, artifact_id: str, patch: dict) -> Artifact:
        allowed = {"title", "content", "word_count"}
        set_parts, values = [], []
        idx = 1
        for k, v in patch.items():
            if k not in allowed:
                continue
            set_parts.append(f"{k} = ${idx}")
            values.append(v)
            idx += 1
        if not set_parts:
            return await self.get(user_id, artifact_id)  # type: ignore[return-value]
        set_parts.append("updated_at = NOW()")
        values.extend([artifact_id, user_id])
        sql = f"UPDATE artifacts SET {', '.join(set_parts)} WHERE id=${idx} AND user_id=${idx+1} RETURNING *"
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(sql, *values)
        return self._to_artifact(row)  # type: ignore[arg-type]

    async def delete(self, user_id: str, artifact_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM artifacts WHERE id=$1 AND user_id=$2", artifact_id, user_id
            )

    @staticmethod
    def _to_artifact(row: asyncpg.Record) -> Artifact:
        return Artifact(
            id=row["id"],
            user_id=row["user_id"],
            type=row["type"],
            title=row["title"],
            content=row["content"],
            source_jd_id=row["source_jd_id"],
            source_experience_ids=parse_jsonb(row["source_experience_ids"]) or [],
            word_count=row["word_count"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
