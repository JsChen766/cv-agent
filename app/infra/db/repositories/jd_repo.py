from __future__ import annotations

import builtins
import contextlib
import json
from hashlib import sha1
from typing import cast

import asyncpg

from app.domain.jd.models import JdRecord, JdRequirement, JdRequirementImportance
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
    ) -> tuple[builtins.list[JdRecord], str | None]:
        conditions = ["user_id = $1"]
        values: builtins.list[object] = [user_id]
        idx = 2
        if cursor:
            conditions.append(f"id > ${idx}")
            values.append(cursor)
            idx += 1
        values.append(limit + 1)
        sql = f"""
            SELECT * FROM jd_records
            WHERE {" AND ".join(conditions)}
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
        requirements: builtins.list[JdRequirement] | None = None,
        source_thread_id: str | None = None,
    ) -> JdRecord:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO jd_records
                    (id, user_id, title, company, target_role, raw_text, requirements, source_thread_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
                RETURNING *
                """,
                jd_id,
                user_id,
                title,
                company,
                target_role,
                raw_text,
                json.dumps([r.model_dump(mode="json") for r in (requirements or [])]),
                source_thread_id,
            )
        if row is None:
            raise RuntimeError("Failed to create JD")
        return self._to_jd(row)

    async def update_requirements(
        self, jd_id: str, requirements: builtins.list[JdRequirement]
    ) -> JdRecord:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE jd_records
                SET requirements=$1::jsonb, updated_at=NOW()
                WHERE id=$2
                RETURNING *
                """,
                json.dumps([r.model_dump(mode="json") for r in requirements]),
                jd_id,
            )
        if row is None:
            raise RuntimeError(f"Failed to update JD requirements: {jd_id}")
        return self._to_jd(row)

    async def delete(self, user_id: str, jd_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute("DELETE FROM jd_records WHERE id=$1 AND user_id=$2", jd_id, user_id)

    @staticmethod
    def _to_jd(row: asyncpg.Record) -> JdRecord:
        raw_reqs = parse_jsonb(row["requirements"]) or []
        requirements = [_to_requirement(r, idx) for idx, r in enumerate(raw_reqs)]
        source_thread_id: str | None = None
        with contextlib.suppress(KeyError, IndexError):
            source_thread_id = row["source_thread_id"]
        return JdRecord(
            id=row["id"],
            user_id=row["user_id"],
            title=row["title"],
            company=row["company"],
            target_role=row["target_role"],
            raw_text=row["raw_text"],
            requirements=requirements,
            source_thread_id=source_thread_id,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


def _to_requirement(raw: object, index: int) -> JdRequirement:
    if not isinstance(raw, dict):
        raw = {"text": str(raw), "category": "other", "importance": "medium"}
    text = str(raw.get("text") or "").strip()
    generated_id = f"req-legacy-{sha1(f'{index}:{text}'.encode()).hexdigest()[:12]}"
    return JdRequirement(
        id=str(raw.get("id") or generated_id),
        text=text,
        category=str(raw.get("category") or "skill"),
        importance=_importance(raw.get("importance")),
    )


def _importance(value: object) -> JdRequirementImportance:
    if value in {"high", "medium", "low"}:
        return cast("JdRequirementImportance", value)
    return "medium"
