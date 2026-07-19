from __future__ import annotations

from datetime import datetime
from typing import Any

import asyncpg

from app.domain.resume.factbank.models import (
    FactBankRevisionTask,
    FactRecord,
    ReusableFactBank,
)
from app.domain.resume.factbank.service import compute_revision_hash
from app.infra.db.helpers import column_is_vector, parse_jsonb


class PostgresFactBankRepository:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def claim_next(
        self,
        *,
        worker_id: str,
        lease_until: datetime,
        schema_version: str,
        extractor_version: str,
        embedding_model: str,
    ) -> FactBankRevisionTask | None:
        async with self._pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                """
                WITH candidate AS (
                    SELECT er.id
                    FROM experience_revisions er
                    WHERE er.revision_hash IS NOT NULL
                      AND (
                        (er.factbank_status IN ('pending', 'retry')
                         AND er.factbank_next_attempt_at <= NOW())
                        OR
                        (er.factbank_status IN ('extracting', 'indexing')
                         AND er.factbank_lease_until < NOW())
                        OR
                        (er.factbank_status = 'ready' AND (
                            er.factbank_schema_version IS DISTINCT FROM $3
                            OR er.factbank_extractor_version IS DISTINCT FROM $4
                            OR er.factbank_embedding_model IS DISTINCT FROM $5
                        ))
                      )
                    ORDER BY
                        CASE WHEN er.factbank_status IN ('extracting', 'indexing') THEN 0 ELSE 1 END,
                        er.factbank_next_attempt_at,
                        er.created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                UPDATE experience_revisions er
                SET factbank_status = 'extracting',
                    factbank_worker_id = $1,
                    factbank_lease_until = $2,
                    factbank_attempt_count = CASE
                        WHEN factbank_status = 'ready' THEN 1
                        ELSE factbank_attempt_count + 1
                    END,
                    factbank_last_error = NULL
                FROM candidate c, experiences e
                WHERE er.id = c.id AND e.id = er.experience_id
                RETURNING er.id AS revision_id, er.experience_id, e.user_id,
                          er.content, er.revision_hash, er.factbank_status,
                          er.factbank_mode,
                          er.factbank_worker_id,
                          er.factbank_schema_version,
                          er.factbank_extractor_version,
                          er.factbank_embedding_model,
                          er.factbank_attempt_count
                """,
                worker_id,
                lease_until,
                schema_version,
                extractor_version,
                embedding_model,
            )
        return self._to_task(row) if row else None

    async def find_reusable(
        self,
        task: FactBankRevisionTask,
        *,
        schema_version: str,
        extractor_version: str,
        embedding_model: str,
    ) -> ReusableFactBank | None:
        async with self._pool.acquire() as conn:
            source = await conn.fetchrow(
                """
                SELECT er.id, er.embedding
                FROM experience_revisions er
                JOIN experiences e ON e.id = er.experience_id
                WHERE e.user_id = $1
                  AND er.id <> $2
                  AND er.revision_hash = $3
                  AND er.factbank_status = 'ready'
                  AND er.factbank_schema_version = $4
                  AND er.factbank_extractor_version = $5
                  AND er.factbank_embedding_model = $6
                  AND er.embedding IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM fact_records f WHERE f.source_revision_id = er.id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM fact_records f
                    WHERE f.source_revision_id = er.id AND f.embedding IS NULL
                  )
                ORDER BY er.factbank_ready_at DESC
                LIMIT 1
                """,
                task.user_id,
                task.revision_id,
                task.revision_hash,
                schema_version,
                extractor_version,
                embedding_model,
            )
            if source is None:
                return None
            rows = await conn.fetch(
                """
                SELECT * FROM fact_records
                WHERE source_revision_id = $1 AND embedding IS NOT NULL
                ORDER BY source_start, source_end, fact_id
                """,
                source["id"],
            )
        if not rows:
            return None
        facts = tuple(self._to_fact(row) for row in rows)
        embeddings = tuple(self._embedding(row["embedding"]) for row in rows)
        if any(not vector for vector in embeddings):
            return None
        return ReusableFactBank(
            facts=facts,
            fact_embeddings=embeddings,
            content_embedding=self._embedding(source["embedding"]),
        )

    async def load_facts(self, revision_id: str) -> list[FactRecord]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM fact_records
                WHERE source_revision_id = $1
                ORDER BY source_start, source_end, fact_id
                """,
                revision_id,
            )
        return [self._to_fact(row) for row in rows]

    async def replace_facts(
        self,
        task: FactBankRevisionTask,
        facts: list[FactRecord],
        *,
        mode: str,
        schema_version: str,
        extractor_version: str,
    ) -> None:
        async with self._pool.acquire() as conn, conn.transaction():
            await self._assert_ownership(conn, task)
            await conn.execute(
                "DELETE FROM fact_records WHERE source_revision_id = $1",
                task.revision_id,
            )
            if facts:
                await conn.executemany(
                    """
                    INSERT INTO fact_records (
                        fact_id, experience_id, source_revision_id, source_revision_hash,
                        action, object, method, technologies, scope, constraint_text,
                        result, metrics, time_range, source_text, source_start, source_end,
                        strength_score, lexical_tokens, schema_version, extractor_version
                    ) VALUES (
                        $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13,
                        $14,$15,$16,$17,$18,$19,$20
                    )
                    """,
                    [
                        (
                            fact.fact_id,
                            fact.experience_id,
                            fact.source_revision_id,
                            fact.source_revision_hash,
                            fact.action,
                            fact.object,
                            fact.method,
                            list(fact.technologies),
                            fact.scope,
                            fact.constraint,
                            fact.result,
                            list(fact.metrics),
                            fact.time_range,
                            fact.source_text,
                            fact.source_start,
                            fact.source_end,
                            fact.strength_score,
                            list(fact.lexical_tokens),
                            schema_version,
                            extractor_version,
                        )
                        for fact in facts
                    ],
                )
            await conn.execute(
                """
                UPDATE experience_revisions
                SET factbank_status = 'indexing',
                    factbank_mode = $4,
                    factbank_schema_version = $2,
                    factbank_extractor_version = $3
                WHERE id = $1
                """,
                task.revision_id,
                schema_version,
                extractor_version,
                mode,
            )

    async def complete(
        self,
        task: FactBankRevisionTask,
        facts: list[FactRecord],
        fact_embeddings: list[list[float]],
        content_embedding: list[float],
        *,
        mode: str,
        schema_version: str,
        extractor_version: str,
        embedding_model: str,
    ) -> None:
        if len(facts) != len(fact_embeddings):
            raise ValueError("Fact and embedding counts must match")
        claims = [
            {
                "text": fact.source_text,
                "category": (
                    "metric"
                    if fact.metrics
                    else "achievement"
                    if fact.result
                    else "skill"
                    if fact.technologies and not fact.action
                    else "responsibility"
                ),
                "is_quantified": bool(fact.metrics),
                "fact_id": fact.fact_id,
            }
            for fact in facts
        ]
        async with self._pool.acquire() as conn, conn.transaction():
            await self._assert_ownership(conn, task)
            use_vector = await column_is_vector(conn, "fact_records", "embedding")
            for fact, embedding in zip(facts, fact_embeddings, strict=True):
                value: str | list[float]
                value = self._vector_literal(embedding) if use_vector else embedding
                cast = "::vector" if use_vector else ""
                await conn.execute(
                    f"""
                    UPDATE fact_records
                    SET embedding = $1{cast}, embedding_model = $2, updated_at = NOW()
                    WHERE fact_id = $3 AND source_revision_id = $4
                    """,
                    value,
                    embedding_model,
                    fact.fact_id,
                    task.revision_id,
                )

            revision_vector = await column_is_vector(conn, "experience_revisions", "embedding")
            revision_value: str | list[float]
            revision_value = (
                self._vector_literal(content_embedding) if revision_vector else content_embedding
            )
            revision_cast = "::vector" if revision_vector else ""
            await conn.execute(
                f"""
                UPDATE experience_revisions
                SET embedding = $1{revision_cast}, claims = $2::jsonb,
                    factbank_status = 'ready', factbank_mode = $3,
                    factbank_schema_version = $4,
                    factbank_extractor_version = $5,
                    factbank_embedding_model = $6,
                    factbank_lease_until = NULL, factbank_worker_id = NULL,
                    factbank_last_error = NULL, factbank_ready_at = NOW()
                WHERE id = $7
                """,
                revision_value,
                claims,
                mode,
                schema_version,
                extractor_version,
                embedding_model,
                task.revision_id,
            )

            experience_vector = await column_is_vector(conn, "experiences", "embedding")
            experience_value = (
                self._vector_literal(content_embedding) if experience_vector else content_embedding
            )
            experience_cast = "::vector" if experience_vector else ""
            await conn.execute(
                f"""
                UPDATE experiences
                SET embedding = $1{experience_cast}, updated_at = NOW()
                WHERE id = $2 AND current_revision_id = $3
                """,
                experience_value,
                task.experience_id,
                task.revision_id,
            )

    async def schedule_retry(
        self,
        task: FactBankRevisionTask,
        *,
        error: str,
        next_attempt_at: datetime | None,
        terminal: bool,
    ) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE experience_revisions
                SET factbank_status = $2,
                    factbank_next_attempt_at = COALESCE($3, factbank_next_attempt_at),
                    factbank_last_error = $4,
                    factbank_lease_until = NULL,
                    factbank_worker_id = NULL
                WHERE id = $1 AND factbank_worker_id = $5
                """,
                task.revision_id,
                "failed" if terminal else "retry",
                next_attempt_at,
                error[:1000],
                task.worker_id,
            )

    async def enqueue_legacy_revisions(self, *, limit: int) -> int:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT er.id, er.content
                FROM experience_revisions er
                JOIN experiences e ON e.id = er.experience_id
                WHERE er.revision_hash IS NULL
                ORDER BY (e.current_revision_id = er.id) DESC, er.created_at DESC
                LIMIT $1
                """,
                limit,
            )
            if not rows:
                return 0
            await conn.executemany(
                """
                UPDATE experience_revisions
                SET revision_hash = $2, factbank_status = 'pending',
                    factbank_next_attempt_at = NOW()
                WHERE id = $1 AND revision_hash IS NULL
                """,
                [(row["id"], compute_revision_hash(row["content"])) for row in rows],
            )
        return len(rows)

    @staticmethod
    def _to_task(row: asyncpg.Record) -> FactBankRevisionTask:
        return FactBankRevisionTask(
            revision_id=row["revision_id"],
            experience_id=row["experience_id"],
            user_id=row["user_id"],
            content=row["content"],
            revision_hash=row["revision_hash"],
            status=row["factbank_status"],
            mode=row["factbank_mode"],
            worker_id=row["factbank_worker_id"],
            built_schema_version=row["factbank_schema_version"],
            built_extractor_version=row["factbank_extractor_version"],
            built_embedding_model=row["factbank_embedding_model"],
            attempt_count=row["factbank_attempt_count"],
        )

    @staticmethod
    def _to_fact(row: asyncpg.Record) -> FactRecord:
        return FactRecord(
            fact_id=row["fact_id"],
            experience_id=row["experience_id"],
            source_revision_id=row["source_revision_id"],
            source_revision_hash=row["source_revision_hash"],
            action=row["action"],
            object=row["object"],
            method=row["method"],
            technologies=tuple(parse_jsonb(row["technologies"]) or []),
            scope=row["scope"],
            constraint=row["constraint_text"],
            result=row["result"],
            metrics=tuple(parse_jsonb(row["metrics"]) or []),
            time_range=row["time_range"],
            source_text=row["source_text"],
            source_start=row["source_start"],
            source_end=row["source_end"],
            strength_score=float(row["strength_score"]),
            lexical_tokens=tuple(row["lexical_tokens"] or []),
            embedding_ref=row["fact_id"] if row["embedding"] is not None else None,
        )

    @staticmethod
    def _embedding(value: Any) -> tuple[float, ...]:
        if value is None:
            return ()
        if isinstance(value, str):
            stripped = value.strip("[]")
            return tuple(float(item) for item in stripped.split(",") if item)
        return tuple(float(item) for item in value)

    @staticmethod
    def _vector_literal(value: list[float]) -> str:
        return f"[{','.join(str(item) for item in value)}]"

    @staticmethod
    async def _assert_ownership(
        conn: asyncpg.Connection,
        task: FactBankRevisionTask,
    ) -> None:
        owned_revision_id = await conn.fetchval(
            """
            SELECT id FROM experience_revisions
            WHERE id = $1 AND factbank_worker_id = $2
            FOR UPDATE
            """,
            task.revision_id,
            task.worker_id,
        )
        if owned_revision_id is None:
            raise RuntimeError(f"FactBank lease ownership lost for {task.revision_id}")
