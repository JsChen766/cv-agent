from __future__ import annotations

import builtins
import json

import asyncpg

from app.domain.resume.models import (
    EvidenceItem,
    Resume,
    ResumeItem,
    ResumeItemCreate,
    ResumeItemPatch,
    ResumePatch,
    ResumeVariant,
    ResumeVariantCreate,
    ResumeVariantPatch,
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
    ) -> tuple[builtins.list[Resume], str | None]:
        conditions = ["user_id = $1"]
        values: builtins.list[object] = [user_id]
        idx = 2
        if cursor:
            conditions.append(
                f"(updated_at, id) < (SELECT updated_at, id FROM resumes "
                f"WHERE id = ${idx} AND user_id = $1)"
            )
            values.append(cursor)
            idx += 1
        values.append(limit + 1)
        sql = f"""
            SELECT * FROM resumes WHERE {' AND '.join(conditions)}
            ORDER BY updated_at DESC, id DESC LIMIT ${idx}
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
        if row is None:
            raise RuntimeError("Failed to create resume")
        return self._to_resume(row)

    async def update(self, user_id: str, resume_id: str, patch: ResumePatch) -> Resume:
        allowed = {"title", "target_role", "jd_id", "status"}
        set_parts: builtins.list[str] = []
        values: builtins.list[object] = []
        idx = 1
        for k, v in patch.model_dump(exclude_none=True).items():
            if k in allowed:
                set_parts.append(f"{k} = ${idx}")
                values.append(v)
                idx += 1
        if not set_parts:
            resume = await self.get(user_id, resume_id)
            if resume is None:
                raise RuntimeError(f"Resume not found after ownership check: {resume_id}")
            return resume
        set_parts.append("updated_at = NOW()")
        values.extend([resume_id, user_id])
        sql = f"UPDATE resumes SET {', '.join(set_parts)} WHERE id=${idx} AND user_id=${idx+1} RETURNING *"
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(sql, *values)
        if row is None:
            raise RuntimeError(f"Failed to update resume: {resume_id}")
        return self._to_resume(row)

    async def delete(self, user_id: str, resume_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM resumes WHERE id=$1 AND user_id=$2", resume_id, user_id
            )

    # ── Items ─────────────────────────────────────────────────────────────────

    async def add_item(self, item_id: str, resume_id: str, data: ResumeItemCreate) -> ResumeItem:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO resume_items
                    (id, resume_id, section_type, title, content_snapshot,
                     order_index, source_experience_id, source_variant_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                RETURNING *
                """,
                item_id, resume_id,
                data.section_type,
                data.title,
                data.content_snapshot,
                data.order_index,
                data.source_experience_id,
                data.source_variant_id,
            )
        if row is None:
            raise RuntimeError("Failed to create resume item")
        return self._to_item(row)

    async def get_item_for_user(self, user_id: str, item_id: str) -> ResumeItem | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT ri.*
                FROM resume_items ri
                JOIN resumes r ON r.id = ri.resume_id
                WHERE ri.id = $1 AND r.user_id = $2
                """,
                item_id,
                user_id,
            )
        return self._to_item(row) if row else None

    async def update_item(
        self, user_id: str, item_id: str, patch: ResumeItemPatch
    ) -> ResumeItem:
        allowed = {"title", "content_snapshot", "order_index", "hidden", "pinned"}
        set_parts: builtins.list[str] = []
        values: builtins.list[object] = []
        idx = 1
        for k, v in patch.model_dump(exclude_none=True).items():
            if k in allowed:
                set_parts.append(f"{k} = ${idx}")
                values.append(v)
                idx += 1
        if not set_parts:
            item = await self.get_item_for_user(user_id, item_id)
            if item is None:
                raise ValueError(f"Resume item not found: {item_id}")
            return item
        set_parts.append("updated_at = NOW()")
        values.extend([item_id, user_id])
        sql = f"""
            UPDATE resume_items AS ri
            SET {', '.join(set_parts)}
            FROM resumes AS r
            WHERE ri.id = ${idx}
              AND ri.resume_id = r.id
              AND r.user_id = ${idx + 1}
            RETURNING ri.*
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(sql, *values)
        if row is None:
            raise ValueError(f"Resume item not found: {item_id}")
        return self._to_item(row)

    async def delete_item(self, user_id: str, item_id: str) -> bool:
        async with self._pool.acquire() as conn:
            result = str(await conn.execute(
                """
                DELETE FROM resume_items AS ri
                USING resumes AS r
                WHERE ri.id = $1
                  AND ri.resume_id = r.id
                  AND r.user_id = $2
                """,
                item_id,
                user_id,
            ))
        return result == "DELETE 1"

    async def reorder_items(
        self, resume_id: str, ordered_ids: builtins.list[str]
    ) -> builtins.list[ResumeItem]:
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

    async def add_variant(
        self, variant_id: str, resume_id: str, data: ResumeVariantCreate
    ) -> ResumeVariant:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO resume_variants
                    (id, resume_id, jd_id, title, content, structured, score,
                     evidence_summary, risk_summary, missing_info, parent_variant_id)
                VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11)
                RETURNING *
                """,
                variant_id, resume_id,
                data.jd_id,
                data.title,
                data.content,
                json.dumps(data.structured) if data.structured is not None else None,
                json.dumps(data.score.model_dump(mode="json")),
                json.dumps([e.model_dump(mode="json") for e in data.evidence_summary]),
                json.dumps([r.model_dump(mode="json") for r in data.risk_summary]),
                json.dumps(data.missing_info),
                data.parent_variant_id,
            )
        if row is None:
            raise RuntimeError("Failed to create resume variant")
        return self._to_variant(row)

    async def get_variant(self, variant_id: str) -> ResumeVariant | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM resume_variants WHERE id=$1", variant_id
            )
        return self._to_variant(row) if row else None

    async def update_variant(
        self, user_id: str, variant_id: str, patch: ResumeVariantPatch
    ) -> ResumeVariant:
        values: builtins.list[object] = []
        set_parts: builtins.list[str] = []
        idx = 1
        for key, value in patch.model_dump(exclude_none=True).items():
            if key in {"title", "content"}:
                set_parts.append(f"{key} = ${idx}")
                values.append(value)
                idx += 1
        if not set_parts:
            variant = await self.get_variant(variant_id)
            if variant is None:
                raise ValueError(f"Resume variant not found: {variant_id}")
            return variant

        values.extend([variant_id, user_id])
        sql = f"""
            UPDATE resume_variants AS rv
            SET {', '.join(set_parts)}
            FROM resumes AS r
            WHERE rv.id = ${idx}
              AND rv.resume_id = r.id
              AND r.user_id = ${idx + 1}
            RETURNING rv.*
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(sql, *values)
        if row is None:
            raise ValueError(f"Resume variant not found: {variant_id}")
        return self._to_variant(row)

    async def list_variants(self, resume_id: str) -> builtins.list[ResumeVariant]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM resume_variants WHERE resume_id=$1 ORDER BY created_at DESC",
                resume_id,
            )
        return [self._to_variant(r) for r in rows]

    async def patch_variant_structured(
        self,
        variant_id: str,
        structured: dict,
        content: str,
        parent_variant_id: str,
    ) -> ResumeVariant:
        """Insert a new variant row derived from an existing one."""
        import uuid as _uuid
        from app.core.types import VARIANT_PREFIX
        new_id = f"{VARIANT_PREFIX}{_uuid.uuid4()}"
        async with self._pool.acquire() as conn:
            # Derive resume_id and title from source variant
            source_row = await conn.fetchrow(
                "SELECT resume_id, title, jd_id FROM resume_variants WHERE id=$1",
                parent_variant_id,
            )
            if source_row is None:
                raise ValueError(f"Source variant not found: {parent_variant_id}")
            # Count existing versions in this chain to assign a version number
            version_count = await conn.fetchval(
                """
                WITH RECURSIVE chain AS (
                    SELECT id FROM resume_variants WHERE id = $1
                    UNION ALL
                    SELECT rv.id FROM resume_variants rv
                    JOIN chain c ON rv.parent_variant_id = c.id
                )
                SELECT COUNT(*) FROM chain
                """,
                parent_variant_id,
            )
            new_version = int(version_count or 1) + 1
            row = await conn.fetchrow(
                """
                INSERT INTO resume_variants
                    (id, resume_id, jd_id, title, content, structured, score,
                     evidence_summary, risk_summary, missing_info, parent_variant_id)
                SELECT $1, resume_id, jd_id, title, $2, $3::jsonb, score,
                       evidence_summary, risk_summary, missing_info, $4
                FROM resume_variants WHERE id = $4
                RETURNING *
                """,
                new_id,
                content,
                json.dumps(structured),
                parent_variant_id,
            )
        if row is None:
            raise RuntimeError("Failed to create patched variant")
        variant = self._to_variant(row)
        variant.version = new_version
        return variant

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
        structured_raw = parse_jsonb(row["structured"]) if "structured" in row.keys() else None
        keys = row.keys()
        parent_variant_id = row["parent_variant_id"] if "parent_variant_id" in keys else None
        return ResumeVariant(
            id=row["id"],
            resume_id=row["resume_id"],
            jd_id=row["jd_id"],
            title=row["title"],
            content=row["content"],
            structured=structured_raw if isinstance(structured_raw, dict) else None,
            parent_variant_id=parent_variant_id,
            score=ScoreBreakdown(**raw_score) if raw_score else ScoreBreakdown(),
            evidence_summary=[EvidenceItem(**e) for e in (parse_jsonb(row["evidence_summary"]) or [])],
            risk_summary=[RiskItem(**r) for r in (parse_jsonb(row["risk_summary"]) or [])],
            missing_info=parse_jsonb(row["missing_info"]) or [],
            created_at=row["created_at"],
        )
