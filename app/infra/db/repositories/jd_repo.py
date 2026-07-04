from __future__ import annotations

import json

import asyncpg

from app.domain.jd.models import JdRecord, JdRequirement
from app.infra.db.helpers import parse_jsonb


class PostgresJdRepository:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def list(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
    ) -> tuple[list[JdRecord], str | None]:
        conditions = ["user_id = $1"]
        values: list = [user_id]
        idx = 2
        if cursor:
            conditions.append(f"id > ${idx}")
            values.append(cursor)
            idx += 1
        values.append(limit + 1)
        sql = f"""
            SELECT * FROM jd_records
            WHERE {' AND '.join(conditions)}
            ORDER BY created_at DESC, id
            LIMIT ${idx}
        """
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(sql, *values)
        has_more = len(rows) > limit
        items = [self._to_jd(r) for r in rows[:limit]]
        return items, items[-1].id if has_more else None

    async def get(self, user_id: str, jd_id: str) -> JdRecord | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM jd_records WHERE id=$1 AND user_id=$2", jd_id, user_id
            )
        return self._to_jd(row) if row else None

    async def create(
        self,
        jd_id: str,
        user_id: str,
        title: str,
        raw_text: str,
        *,
        company: str | None = None,
        target_role: str | None = None,
        requirements: list[dict] | None = None,
    ) -> JdRecord:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO jd_records (id, user_id, title, company, target_role, raw_text, requirements)
                VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
                RETURNING *
                """,
                jd_id, user_id, title, company, target_role, raw_text,
                json.dumps(requirements or []),
            )
        return self._to_jd(row)  # type: ignore[arg-type]

    async def update_requirements(
        self, jd_id: str, requirements: list[dict]
    ) -> JdRecord:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE jd_records
                SET requirements=$1::jsonb, updated_at=NOW()
                WHERE id=$2
                RETURNING *
                """,
                json.dumps(requirements), jd_id,
            )
        return self._to_jd(row)  # type: ignore[arg-type]

    async def delete(self, user_id: str, jd_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM jd_records WHERE id=$1 AND user_id=$2", jd_id, user_id
            )

    @staticmethod
    def _to_jd(row: asyncpg.Record) -> JdRecord:
        raw_reqs = parse_jsonb(row["requirements"]) or []
        requirements = [JdRequirement(**r) for r in raw_reqs]
        return JdRecord(
            id=row["id"],
            user_id=row["user_id"],
            title=row["title"],
            company=row["company"],
            target_role=row["target_role"],
            raw_text=row["raw_text"],
            requirements=requirements,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
