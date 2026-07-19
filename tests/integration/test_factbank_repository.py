from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import asyncpg
import pytest

from app.domain.resume.factbank.models import FactDraft
from app.domain.resume.factbank.service import build_fact_records, compute_revision_hash
from app.infra.db.repositories.experience_repo import PostgresExperienceRepository
from app.infra.db.repositories.factbank_repo import PostgresFactBankRepository
from app.rag.evidence.factbank_processor import FactBankProcessor

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_DATABASE_URL"),
    reason="TEST_DATABASE_URL is required for PostgreSQL integration tests",
)


async def test_factbank_repository_claim_reuse_and_stale_revision_protection() -> None:
    dsn = os.environ["TEST_DATABASE_URL"].replace("+asyncpg", "")

    async def init_connection(conn: asyncpg.Connection) -> None:
        await conn.set_type_codec(
            "jsonb",
            encoder=json.dumps,
            decoder=json.loads,
            schema="pg_catalog",
        )

    pool = await asyncpg.create_pool(
        dsn=dsn,
        min_size=1,
        max_size=2,
        init=init_connection,
    )
    suffix = uuid.uuid4().hex
    user_id = f"user-{suffix}"
    experience_id = f"exp-{suffix}"
    revision_one = f"rev-{suffix}-1"
    revision_two = f"rev-{suffix}-2"
    content = "Built Python APIs and reduced latency by 30%."
    revision_hash = compute_revision_hash(content)
    vector = [1.0, *([0.0] * 511)]
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO users (id, email, hashed_password) VALUES ($1, $2, $3)",
                user_id,
                f"{suffix}@example.com",
                "test",
            )
        experience_repository = PostgresExperienceRepository(pool)
        factbank_repository = PostgresFactBankRepository(pool)
        await experience_repository.create(
            experience_id,
            user_id,
            "work",
            "Backend Engineer",
        )
        await experience_repository.add_revision(
            revision_one,
            experience_id,
            content,
            "manual",
            revision_hash,
        )
        task_one = await factbank_repository.claim_next(
            worker_id="worker-1",
            lease_until=datetime.now(UTC) + timedelta(seconds=60),
            schema_version="factbank-v1",
            extractor_version="atomic-facts-v1",
            embedding_model="test-embedding",
        )
        assert task_one is not None
        assert task_one.revision_id == revision_one

        # A newer revision becomes current before the old job finishes.
        await experience_repository.add_revision(
            revision_two,
            experience_id,
            content,
            "manual",
            revision_hash,
        )
        facts_one = build_fact_records(
            experience_id=experience_id,
            revision_id=revision_one,
            revision_hash=revision_hash,
            content=content,
            drafts=[
                FactDraft(
                    action="Built",
                    technologies=("Python",),
                    metrics=("30%",),
                    source_text=content,
                )
            ],
        )
        await factbank_repository.replace_facts(
            task_one,
            facts_one,
            mode="extracted",
            schema_version="factbank-v1",
            extractor_version="atomic-facts-v1",
        )
        await factbank_repository.complete(
            task_one,
            facts_one,
            [vector],
            vector,
            mode="extracted",
            schema_version="factbank-v1",
            extractor_version="atomic-facts-v1",
            embedding_model="test-embedding",
        )
        async with pool.acquire() as conn:
            experience_embedding = await conn.fetchval(
                "SELECT embedding FROM experiences WHERE id = $1",
                experience_id,
            )
        assert experience_embedding is None

        task_two = await factbank_repository.claim_next(
            worker_id="worker-2",
            lease_until=datetime.now(UTC) + timedelta(seconds=60),
            schema_version="factbank-v1",
            extractor_version="atomic-facts-v1",
            embedding_model="test-embedding",
        )
        assert task_two is not None
        reusable = await factbank_repository.find_reusable(
            task_two,
            schema_version="factbank-v1",
            extractor_version="atomic-facts-v1",
            embedding_model="test-embedding",
        )
        assert reusable is not None
        assert reusable.facts[0].source_text == content
        assert len(reusable.fact_embeddings[0]) == 512

        extractor = AsyncMock()
        embedder = AsyncMock()
        processor = FactBankProcessor(
            factbank_repository,
            extractor,
            embedder,
            schema_version="factbank-v1",
            extractor_version="atomic-facts-v1",
            embedding_model="test-embedding",
            extraction_deadline_seconds=1,
        )
        assert await processor.process(task_two) == "reused"
        extractor.extract.assert_not_awaited()
        embedder.embed.assert_not_awaited()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT er.factbank_status, er.factbank_mode, er.claims,
                       jsonb_typeof(er.claims) AS claims_type,
                       e.embedding AS experience_embedding,
                       (SELECT jsonb_typeof(fr.technologies)
                        FROM fact_records fr
                        WHERE fr.source_revision_id = er.id
                        LIMIT 1) AS technologies_type
                FROM experience_revisions er
                JOIN experiences e ON e.id = er.experience_id
                WHERE er.id = $1
                """,
                revision_two,
            )
        assert row is not None
        assert row["factbank_status"] == "ready"
        assert row["factbank_mode"] == "reused"
        assert row["experience_embedding"] is not None
        assert row["claims_type"] == "array"
        assert row["technologies_type"] == "array"
        assert "fact_id" in str(row["claims"])
    finally:
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM users WHERE id = $1", user_id)
        await pool.close()
