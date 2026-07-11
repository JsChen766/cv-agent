from __future__ import annotations

import builtins
import json
from datetime import date

import asyncpg

from app.core.types import ExperienceCategory
from app.domain.experience.models import (
    Experience,
    ExperiencePatch,
    ExperienceRevision,
    ImportCandidate,
    ImportCandidateCreate,
    ImportJob,
)
from app.infra.db.helpers import parse_jsonb


class PostgresExperienceRepository:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    # ── List ──────────────────────────────────────────────────────────────────

    async def list(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
        category: str | None = None,
        tags: builtins.list[str] | None = None,
        q: str | None = None,
    ) -> tuple[builtins.list[Experience], str | None]:
        conditions = ["user_id = $1", "status = 'active'"]
        values: builtins.list[object] = [user_id]
        idx = 2

        if cursor:
            conditions.append(
                f"(created_at, id) < (SELECT created_at, id FROM experiences "
                f"WHERE id = ${idx} AND user_id = $1)"
            )
            values.append(cursor)
            idx += 1
        if category:
            conditions.append(f"category = ${idx}")
            values.append(category)
            idx += 1
        if tags:
            conditions.append(f"tags @> ${idx}::jsonb")
            values.append(json.dumps(tags))
            idx += 1
        if q:
            conditions.append(
                f"(title ILIKE ${idx} OR organization ILIKE ${idx} OR role ILIKE ${idx} "
                f"OR EXISTS (SELECT 1 FROM experience_revisions er "
                f"WHERE er.id = experiences.current_revision_id AND er.content ILIKE ${idx}))"
            )
            values.append(f"%{q}%")
            idx += 1

        where = " AND ".join(conditions)
        values.append(limit + 1)
        sql = f"""
            SELECT * FROM experiences
            WHERE {where}
            ORDER BY created_at DESC, id DESC
            LIMIT ${idx}
        """
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(sql, *values)

        has_more = len(rows) > limit
        items = [self._to_exp(r) for r in rows[:limit]]
        next_cursor = items[-1].id if has_more else None
        return items, next_cursor

    # ── Get ───────────────────────────────────────────────────────────────────

    async def get(self, user_id: str, experience_id: str) -> Experience | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM experiences WHERE id = $1 AND user_id = $2",
                experience_id, user_id,
            )
            if not row:
                return None
            exp = self._to_exp(row)
            # Load current revision
            if exp.current_revision_id:
                rev_row = await conn.fetchrow(
                    "SELECT * FROM experience_revisions WHERE id = $1",
                    exp.current_revision_id,
                )
                if rev_row:
                    exp.current_revision = self._to_rev(rev_row)
        return exp

    # ── Create ────────────────────────────────────────────────────────────────

    async def create(
        self,
        experience_id: str,
        user_id: str,
        category: ExperienceCategory,
        title: str,
        *,
        organization: str | None = None,
        role: str | None = None,
        start_date: date | None = None,
        end_date: date | None = None,
        tags: builtins.list[str] | None = None,
    ) -> Experience:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO experiences
                    (id, user_id, category, title, organization, role,
                     start_date, end_date, tags)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
                RETURNING *
                """,
                experience_id, user_id, category, title,
                organization, role, start_date, end_date,
                json.dumps(tags or []),
            )
        if row is None:
            raise RuntimeError("Failed to create experience")
        return self._to_exp(row)

    # ── Update ────────────────────────────────────────────────────────────────

    async def update(
        self, user_id: str, experience_id: str, patch: ExperiencePatch
    ) -> Experience:
        allowed = {
            "title", "organization", "role", "category",
            "start_date", "end_date", "tags", "current_revision_id",
        }
        json_fields = {"tags"}
        set_parts: builtins.list[str] = []
        values: builtins.list[object] = []
        idx = 1
        for k, v in patch.model_dump(exclude_none=True).items():
            if k not in allowed:
                continue
            if k in json_fields:
                set_parts.append(f"{k} = ${idx}::jsonb")
                values.append(json.dumps(v))
            else:
                set_parts.append(f"{k} = ${idx}")
                values.append(v)
            idx += 1

        if not set_parts:
            exp = await self.get(user_id, experience_id)
            if exp is None:
                raise RuntimeError(f"Experience not found after ownership check: {experience_id}")
            return exp

        set_parts.append("updated_at = NOW()")
        values.extend([experience_id, user_id])
        sql = f"""
            UPDATE experiences SET {', '.join(set_parts)}
            WHERE id = ${idx} AND user_id = ${idx + 1}
            RETURNING *
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(sql, *values)
        if row is None:
            raise RuntimeError(f"Failed to update experience: {experience_id}")
        return self._to_exp(row)

    async def archive(self, user_id: str, experience_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE experiences SET status='archived', updated_at=NOW() WHERE id=$1 AND user_id=$2",
                experience_id, user_id,
            )

    # ── Revisions ─────────────────────────────────────────────────────────────

    async def get_revisions(self, experience_id: str) -> builtins.list[ExperienceRevision]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM experience_revisions WHERE experience_id = $1 ORDER BY created_at DESC",
                experience_id,
            )
        return [self._to_rev(r) for r in rows]

    async def add_revision(
        self,
        revision_id: str,
        experience_id: str,
        content: str,
        source: str,
    ) -> ExperienceRevision:
        async with self._pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                """
                    INSERT INTO experience_revisions (id, experience_id, content, source)
                    VALUES ($1, $2, $3, $4)
                    RETURNING *
                    """,
                revision_id, experience_id, content, source,
            )
            await conn.execute(
                "UPDATE experiences SET current_revision_id=$1, updated_at=NOW() WHERE id=$2",
                revision_id, experience_id,
            )
        if row is None:
            raise RuntimeError("Failed to create experience revision")
        return self._to_rev(row)

    # ── Import Jobs ───────────────────────────────────────────────────────────

    async def create_import_job(
        self, job_id: str, user_id: str, source: str, file_id: str | None = None
    ) -> ImportJob:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "INSERT INTO import_jobs (id, user_id, source, file_id) VALUES ($1,$2,$3,$4) RETURNING *",
                job_id, user_id, source, file_id,
            )
        if row is None:
            raise RuntimeError("Failed to create import job")
        return self._to_job(row)

    async def update_import_job_status(self, job_id: str, status: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE import_jobs SET status=$1, updated_at=NOW() WHERE id=$2",
                status, job_id,
            )

    async def create_candidates(
        self, candidates: builtins.list[ImportCandidateCreate]
    ) -> builtins.list[ImportCandidate]:
        if not candidates:
            return []
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                INSERT INTO import_candidates
                    (id, import_job_id, user_id, category, title, organization, role, content)
                SELECT
                    d->>'id', d->>'import_job_id', d->>'user_id',
                    d->>'category', d->>'title', d->>'organization',
                    d->>'role', d->>'content'
                FROM jsonb_array_elements($1::jsonb) AS d
                RETURNING *
                """,
                json.dumps([c.model_dump(mode="json") for c in candidates]),
            )
        return [self._to_candidate(r) for r in rows]

    async def get_candidate(
        self, user_id: str, candidate_id: str
    ) -> ImportCandidate | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM import_candidates WHERE id=$1 AND user_id=$2",
                candidate_id, user_id,
            )
        return self._to_candidate(row) if row else None

    async def update_candidate_status(
        self, candidate_id: str, status: str
    ) -> ImportCandidate:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "UPDATE import_candidates SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
                status, candidate_id,
            )
        if row is None:
            raise RuntimeError(f"Failed to update import candidate: {candidate_id}")
        return self._to_candidate(row)

    # ── Row mappers ───────────────────────────────────────────────────────────

    @staticmethod
    def _to_exp(row: asyncpg.Record) -> Experience:
        return Experience(
            id=row["id"],
            user_id=row["user_id"],
            category=row["category"],
            title=row["title"],
            organization=row["organization"],
            role=row["role"],
            start_date=row["start_date"],
            end_date=row["end_date"],
            tags=parse_jsonb(row["tags"]) or [],
            status=row["status"],
            current_revision_id=row["current_revision_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _to_rev(row: asyncpg.Record) -> ExperienceRevision:
        return ExperienceRevision(
            id=row["id"],
            experience_id=row["experience_id"],
            content=row["content"],
            source=row["source"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _to_job(row: asyncpg.Record) -> ImportJob:
        return ImportJob(
            id=row["id"],
            user_id=row["user_id"],
            source=row["source"],
            status=row["status"],
            file_id=row["file_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _to_candidate(row: asyncpg.Record) -> ImportCandidate:
        return ImportCandidate(
            id=row["id"],
            import_job_id=row["import_job_id"],
            user_id=row["user_id"],
            category=row["category"],
            title=row["title"],
            organization=row["organization"],
            role=row["role"],
            content=row["content"],
            status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
