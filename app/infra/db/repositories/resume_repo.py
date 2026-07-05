from __future__ import annotations

import json

import asyncpg

from app.domain.resume.models import (
    EvidenceItem,
    Resume,
    ResumeItem,
    ResumeVariant,
    RiskItem,
    ScoreBreakdown,
)
from app.infra.db.helpers import parse_jsonb


class PostgresResumeRepository:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    # ── Resume CRUD ───────────────────────────────────────────────────────────

    async def list(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
    ) -> tuple[list[Resume], str | None]:
        conditions = ["user_id = $1"]
        values: list = [user_id]
        idx = 2
        if cursor:
            conditions.append(f"id > ${idx}")
            values.append(cursor)
            idx += 1
        values.append(limit + 1)
        sql = f"""
            SELECT * FROM resumes WHERE {' AND '.join(conditions)}
            ORDER BY updated_at DESC, id LIMIT ${idx}
        """
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(sql, *values)
        has_more = len(rows) > limit
        items = [self._to_resume(r) for r in rows[:limit]]
        return items, items[-1].id if has_more else None

    async def get(self, user_id: str, resume_id: str) -> Resume | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM resumes WHERE id=$1 AND user_id=$2", resume_id, user_id
            )
            if not row:
                return None
            resume = self._to_resume(row)
            item_rows = await conn.fetch(
                "SELECT * FROM resume_items WHERE resume_id=$1 ORDER BY order_index",
                resume_id,
            )
            resume.items = [self._to_item(r) for r in item_rows]
        return resume

    async def create(
        self,
        resume_id: str,
        user_id: str,
        title: str,
        *,
        target_role: str | None = None,
        jd_id: str | None = None,
    ) -> Resume:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO resumes (id, user_id, title, target_role, jd_id)
                VALUES ($1,$2,$3,$4,$5) RETURNING *
                """,
                resume_id, user_id, title, target_role, jd_id,
            )
        return self._to_resume(row)  # type: ignore[arg-type]

    async def update(self, user_id: str, resume_id: str, patch: dict) -> Resume:
        allowed = {"title", "target_role", "jd_id", "status"}
        set_parts, values = [], []
        idx = 1
        for k, v in patch.items():
            if k in allowed:
                set_parts.append(f"{k} = ${idx}")
                values.append(v)
                idx += 1
        if not set_parts:
            return await self.get(user_id, resume_id)  # type: ignore[return-value]
        set_parts.append("updated_at = NOW()")
        values.extend([resume_id, user_id])
        sql = f"UPDATE resumes SET {', '.join(set_parts)} WHERE id=${idx} AND user_id=${idx+1} RETURNING *"
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(sql, *values)
        return self._to_resume(row)  # type: ignore[arg-type]

    async def delete(self, user_id: str, resume_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM resumes WHERE id=$1 AND user_id=$2", resume_id, user_id
            )

    # ── Items ─────────────────────────────────────────────────────────────────

    async def add_item(self, item_id: str, resume_id: str, data: dict) -> ResumeItem:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO resume_items
                    (id, resume_id, section_type, title, content_snapshot,
                     order_index, source_experience_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
                RETURNING *
                """,
                item_id, resume_id,
                data.get("section_type", "experience"),
                data.get("title"),
                data.get("content_snapshot", ""),
                data.get("order_index", 0),
                data.get("source_experience_id"),
            )
        return self._to_item(row)  # type: ignore[arg-type]

    async def update_item(self, item_id: str, patch: dict) -> ResumeItem:
        allowed = {"title", "content_snapshot", "order_index", "hidden", "pinned"}
        set_parts, values = [], []
        idx = 1
        for k, v in patch.items():
            if k in allowed:
                set_parts.append(f"{k} = ${idx}")
                values.append(v)
                idx += 1
        if not set_parts:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow("SELECT * FROM resume_items WHERE id=$1", item_id)
            return self._to_item(row)  # type: ignore[arg-type]
        set_parts.append("updated_at = NOW()")
        values.append(item_id)
        sql = f"UPDATE resume_items SET {', '.join(set_parts)} WHERE id=${idx} RETURNING *"
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(sql, *values)
        return self._to_item(row)  # type: ignore[arg-type]

    async def delete_item(self, item_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute("DELETE FROM resume_items WHERE id=$1", item_id)

    async def reorder_items(
        self, resume_id: str, ordered_ids: list[str]
    ) -> list[ResumeItem]:
        async with self._pool.acquire() as conn, conn.transaction():
            for idx, item_id in enumerate(ordered_ids):
                await conn.execute(
                    "UPDATE resume_items SET order_index=$1 WHERE id=$2 AND resume_id=$3",
                    idx, item_id, resume_id,
                )
            rows = await conn.fetch(
                "SELECT * FROM resume_items WHERE resume_id=$1 ORDER BY order_index",
                resume_id,
            )
        return [self._to_item(r) for r in rows]

    # ── Variants ──────────────────────────────────────────────────────────────

    async def add_variant(self, variant_id: str, resume_id: str, data: dict) -> ResumeVariant:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO resume_variants
                    (id, resume_id, jd_id, title, content, score,
                     evidence_summary, risk_summary, missing_info)
                VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb)
                RETURNING *
                """,
                variant_id, resume_id,
                data.get("jd_id"),
                data.get("title", "Variant"),
                data.get("content", ""),
                json.dumps(data.get("score", {})),
                json.dumps(data.get("evidence_summary", [])),
                json.dumps(data.get("risk_summary", [])),
                json.dumps(data.get("missing_info", [])),
            )
        return self._to_variant(row)  # type: ignore[arg-type]

    async def get_variant(self, variant_id: str) -> ResumeVariant | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM resume_variants WHERE id=$1", variant_id
            )
        return self._to_variant(row) if row else None

    async def list_variants(self, resume_id: str) -> list[ResumeVariant]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM resume_variants WHERE resume_id=$1 ORDER BY created_at DESC",
                resume_id,
            )
        return [self._to_variant(r) for r in rows]

    # ── Mappers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _to_resume(row: asyncpg.Record) -> Resume:
        return Resume(
            id=row["id"],
            user_id=row["user_id"],
            title=row["title"],
            target_role=row["target_role"],
            jd_id=row["jd_id"],
            status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _to_item(row: asyncpg.Record) -> ResumeItem:
        return ResumeItem(
            id=row["id"],
            resume_id=row["resume_id"],
            section_type=row["section_type"],
            title=row["title"],
            content_snapshot=row["content_snapshot"],
            order_index=row["order_index"],
            hidden=row["hidden"],
            pinned=row["pinned"],
            source_experience_id=row["source_experience_id"],
            source_variant_id=row["source_variant_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _to_variant(row: asyncpg.Record) -> ResumeVariant:
        raw_score = parse_jsonb(row["score"]) or {}
        return ResumeVariant(
            id=row["id"],
            resume_id=row["resume_id"],
            jd_id=row["jd_id"],
            title=row["title"],
            content=row["content"],
            score=ScoreBreakdown(**raw_score) if raw_score else ScoreBreakdown(),
            evidence_summary=[EvidenceItem(**e) for e in (parse_jsonb(row["evidence_summary"]) or [])],
            risk_summary=[RiskItem(**r) for r in (parse_jsonb(row["risk_summary"]) or [])],
            missing_info=parse_jsonb(row["missing_info"]) or [],
            created_at=row["created_at"],
        )
