from __future__ import annotations

import builtins
import contextlib
import json
from hashlib import sha1

import asyncpg

from app.domain.jd.models import (
    JdRecord,
    JdRequirement,
    JdRequirementImportance,
    JdRequirementsOrigin,
    JdRequirementV2Category,
)
from app.domain.jd.requirement_map.models import RequirementImportance
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
        q: str | None = None,
        company: str | None = None,
    ) -> tuple[builtins.list[JdRecord], str | None]:
        conditions = ["user_id = $1"]
        values: builtins.list[object] = [user_id]
        idx = 2
        if q:
            conditions.append(
                f"(title ILIKE ${idx} OR company ILIKE ${idx} "
                f"OR target_role ILIKE ${idx} OR raw_text ILIKE ${idx})"
            )
            values.append(f"%{q}%")
            idx += 1
        if company:
            conditions.append(f"company ILIKE ${idx}")
            values.append(f"%{company}%")
            idx += 1
        if cursor:
            conditions.append(
                f"(created_at, id) < (SELECT created_at, id FROM jd_records "
                f"WHERE id = ${idx} AND user_id = $1)"
            )
            values.append(cursor)
            idx += 1
        values.append(limit + 1)
        sql = f"""
            SELECT * FROM jd_records
            WHERE {" AND ".join(conditions)}
            ORDER BY created_at DESC, id DESC
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
        jd_hash: str | None = None,
        requirement_map_id: str | None = None,
        requirements_origin: str = "legacy",
    ) -> JdRecord:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO jd_records
                    (id, user_id, title, company, target_role, raw_text, requirements,
                     source_thread_id, jd_hash, requirement_map_id, requirements_origin)
                VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
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
                jd_hash,
                requirement_map_id,
                requirements_origin,
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
                SET requirements=$1::jsonb,
                    requirements_origin='manual',
                    requirement_map_id=NULL,
                    updated_at=NOW()
                WHERE id=$2
                RETURNING *
                """,
                json.dumps([r.model_dump(mode="json") for r in requirements]),
                jd_id,
            )
        if row is None:
            raise RuntimeError(f"Failed to update JD requirements: {jd_id}")
        return self._to_jd(row)

    async def update_analysis(
        self,
        jd_id: str,
        *,
        title: str,
        company: str | None,
        target_role: str | None,
        requirements: builtins.list[JdRequirement],
        jd_hash: str,
        requirement_map_id: str,
    ) -> JdRecord:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE jd_records
                SET title=$1,
                    company=$2,
                    target_role=$3,
                    requirements=$4::jsonb,
                    jd_hash=$5,
                    requirement_map_id=$6,
                    requirements_origin='parsed',
                    updated_at=NOW()
                WHERE id=$7
                RETURNING *
                """,
                title,
                company,
                target_role,
                json.dumps([item.model_dump(mode="json") for item in requirements]),
                jd_hash,
                requirement_map_id,
                jd_id,
            )
        if row is None:
            raise RuntimeError(f"Failed to update JD analysis: {jd_id}")
        return self._to_jd(row)

    async def delete(self, user_id: str, jd_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute("DELETE FROM jd_records WHERE id=$1 AND user_id=$2", jd_id, user_id)

    @staticmethod
    def _to_jd(row: asyncpg.Record) -> JdRecord:
        raw_reqs = parse_jsonb(row["requirements"]) or []
        requirements = [_to_requirement(r, idx) for idx, r in enumerate(raw_reqs)]
        source_thread_id: str | None = None
        jd_hash: str | None = None
        requirement_map_id: str | None = None
        requirements_origin: JdRequirementsOrigin = "legacy"
        with contextlib.suppress(KeyError, IndexError):
            source_thread_id = row["source_thread_id"]
        with contextlib.suppress(KeyError, IndexError):
            jd_hash = row["jd_hash"]
        with contextlib.suppress(KeyError, IndexError):
            requirement_map_id = row["requirement_map_id"]
        with contextlib.suppress(KeyError, IndexError):
            requirements_origin = _requirements_origin(row["requirements_origin"])
        return JdRecord(
            id=row["id"],
            user_id=row["user_id"],
            title=row["title"],
            company=row["company"],
            target_role=row["target_role"],
            raw_text=row["raw_text"],
            requirements=requirements,
            jd_hash=jd_hash,
            requirement_map_id=requirement_map_id,
            requirements_origin=requirements_origin,
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
        keywords=tuple(str(value) for value in raw.get("keywords") or []),
        weight=_optional_weight(raw.get("weight")),
        v2_importance=_v2_importance(raw.get("v2_importance")),
        v2_category=_v2_category(raw.get("v2_category")),
    )


def _importance(value: object) -> JdRequirementImportance:
    if value in {"high", "medium", "low"}:
        if value == "high":
            return "high"
        if value == "low":
            return "low"
    return "medium"


def _optional_weight(value: object) -> float | None:
    if isinstance(value, int | float) and 0.0 <= float(value) <= 1.0:
        return float(value)
    return None


def _v2_importance(value: object) -> RequirementImportance | None:
    if value in {"must_have", "preferred", "optional"}:
        if value == "must_have":
            return "must_have"
        if value == "optional":
            return "optional"
        return "preferred"
    return None


def _v2_category(value: object) -> JdRequirementV2Category | None:
    if value == "qualification":
        return "qualification"
    if value == "responsibility":
        return "responsibility"
    if value == "technology":
        return "technology"
    if value == "domain":
        return "domain"
    if value == "soft_skill":
        return "soft_skill"
    return None


def _requirements_origin(value: object) -> JdRequirementsOrigin:
    if value == "parsed":
        return "parsed"
    if value == "manual":
        return "manual"
    return "legacy"
