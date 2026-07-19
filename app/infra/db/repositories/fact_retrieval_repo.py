from __future__ import annotations

from collections import OrderedDict
from typing import Any

import asyncpg

from app.domain.resume.retrieval.models import ExperienceFactBundle, RetrievalFact
from app.infra.db.helpers import column_is_vector, parse_jsonb


class PostgresFactRetrievalRepository:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def load_current_experience_facts(
        self,
        user_id: str,
        *,
        embedding_model: str,
    ) -> list[ExperienceFactBundle]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT e.id AS experience_id, e.title, e.organization, e.role,
                       e.category, e.start_date, e.end_date, e.tags,
                       er.id AS revision_id, er.revision_hash, er.content,
                       er.factbank_status,
                       fr.fact_id, fr.source_revision_hash, fr.source_text,
                       fr.technologies, fr.lexical_tokens, fr.strength_score,
                       CASE WHEN fr.embedding_model = $2 THEN fr.embedding ELSE NULL END
                           AS fact_embedding
                FROM experiences e
                JOIN experience_revisions er ON er.id = e.current_revision_id
                LEFT JOIN fact_records fr ON fr.source_revision_id = er.id
                WHERE e.user_id = $1 AND e.status = 'active'
                ORDER BY e.created_at, e.id, fr.source_start, fr.source_end, fr.fact_id
                """,
                user_id,
                embedding_model,
            )
        bundles: OrderedDict[str, dict[str, Any]] = OrderedDict()
        for row in rows:
            experience_id = str(row["experience_id"])
            if experience_id not in bundles:
                tags = parse_jsonb(row["tags"]) or []
                bundles[experience_id] = {
                    "experience_id": experience_id,
                    "revision_id": str(row["revision_id"]),
                    "revision_hash": str(row["revision_hash"] or ""),
                    "content": str(row["content"]),
                    "title": str(row["title"]),
                    "organization": row["organization"],
                    "role": row["role"],
                    "category": str(row["category"]),
                    "start_date": row["start_date"],
                    "end_date": row["end_date"],
                    "tags": tuple(str(value) for value in tags),
                    "factbank_status": str(row["factbank_status"]),
                    "facts": [],
                }
            if row["fact_id"] is None:
                continue
            raw_technologies = parse_jsonb(row["technologies"]) or []
            bundles[experience_id]["facts"].append(
                RetrievalFact(
                    fact_id=str(row["fact_id"]),
                    experience_id=experience_id,
                    source_revision_id=str(row["revision_id"]),
                    source_revision_hash=str(row["source_revision_hash"]),
                    source_text=str(row["source_text"]),
                    technologies=tuple(str(value) for value in raw_technologies),
                    lexical_tokens=tuple(str(value) for value in row["lexical_tokens"] or []),
                    strength_score=float(row["strength_score"]),
                    experience_category=str(row["category"]),
                    experience_title=str(row["title"]),
                    organization=row["organization"],
                    role=row["role"],
                    start_date=row["start_date"],
                    end_date=row["end_date"],
                    factbank_status=str(row["factbank_status"]),
                    embedding=self._embedding(row["fact_embedding"]),
                )
            )
        return [
            ExperienceFactBundle.model_validate({**value, "facts": tuple(value["facts"])})
            for value in bundles.values()
        ]

    async def get_requirement_embeddings(
        self,
        user_id: str,
        requirements_fingerprint: str,
        embedding_model: str,
        text_hashes: dict[str, str],
    ) -> dict[str, tuple[float, ...]]:
        if not text_hashes:
            return {}
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT requirement_id, text_hash, embedding
                FROM requirement_embeddings
                WHERE user_id = $1
                  AND requirements_fingerprint = $2
                  AND embedding_model = $3
                  AND requirement_id = ANY($4::text[])
                """,
                user_id,
                requirements_fingerprint,
                embedding_model,
                list(text_hashes),
            )
        return {
            str(row["requirement_id"]): self._embedding(row["embedding"])
            for row in rows
            if row["text_hash"] == text_hashes.get(str(row["requirement_id"]))
        }

    async def save_requirement_embeddings(
        self,
        user_id: str,
        requirements_fingerprint: str,
        embedding_model: str,
        text_hashes: dict[str, str],
        embeddings: dict[str, tuple[float, ...]],
    ) -> None:
        if not embeddings:
            return
        async with self._pool.acquire() as conn, conn.transaction():
            use_vector = await column_is_vector(conn, "requirement_embeddings", "embedding")
            for requirement_id, embedding in embeddings.items():
                value: str | list[float]
                value = self._vector_literal(embedding) if use_vector else list(embedding)
                cast = "::vector" if use_vector else ""
                await conn.execute(
                    f"""
                    INSERT INTO requirement_embeddings (
                        user_id, requirements_fingerprint, requirement_id,
                        embedding_model, text_hash, embedding
                    ) VALUES ($1,$2,$3,$4,$5,$6{cast})
                    ON CONFLICT (
                        user_id, requirements_fingerprint, requirement_id, embedding_model
                    ) DO UPDATE SET
                        text_hash = EXCLUDED.text_hash,
                        embedding = EXCLUDED.embedding,
                        updated_at = NOW()
                    """,
                    user_id,
                    requirements_fingerprint,
                    requirement_id,
                    embedding_model,
                    text_hashes[requirement_id],
                    value,
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
    def _vector_literal(value: tuple[float, ...]) -> str:
        return f"[{','.join(str(item) for item in value)}]"
