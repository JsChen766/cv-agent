from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from app.domain.jd.models import JdRequirement
from app.domain.resume.factbank.models import FactDraft
from app.domain.resume.factbank.service import build_fact_records, compute_revision_hash
from app.infra.db.repositories.experience_repo import PostgresExperienceRepository
from app.infra.db.repositories.fact_retrieval_repo import PostgresFactRetrievalRepository
from app.infra.db.repositories.factbank_repo import PostgresFactBankRepository
from app.rag.evidence.hybrid_retrieval import build_hybrid_fact_retrieval_service

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_DATABASE_URL"),
    reason="TEST_DATABASE_URL is required for PostgreSQL integration tests",
)


class _EmbeddingProvider:
    def __init__(self) -> None:
        self.calls = 0

    async def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls += 1
        return [[1.0, *([0.0] * 511)] for _ in texts]


async def test_full_current_fact_read_and_requirement_embedding_cache() -> None:
    dsn = os.environ["TEST_DATABASE_URL"].replace("+asyncpg", "")

    async def init_connection(conn: asyncpg.Connection) -> None:
        await conn.set_type_codec(
            "jsonb",
            encoder=json.dumps,
            decoder=json.loads,
            schema="pg_catalog",
        )

    pool = await asyncpg.create_pool(dsn=dsn, min_size=1, max_size=2, init=init_connection)
    suffix = uuid.uuid4().hex
    user_id = f"user-{suffix}"
    experience_id = f"exp-{suffix}"
    revision_id = f"rev-{suffix}"
    content = "Built Python APIs and reduced latency by 30%."
    revision_hash = compute_revision_hash(content)
    vector = [1.0, *([0.0] * 511)]
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO users (id, email, hashed_password) VALUES ($1,$2,$3)",
                user_id,
                f"{suffix}@example.com",
                "test",
            )
        experiences = PostgresExperienceRepository(pool)
        factbanks = PostgresFactBankRepository(pool)
        retrieval = PostgresFactRetrievalRepository(pool)
        await experiences.create(experience_id, user_id, "work", "Backend Engineer")
        await experiences.add_revision(
            revision_id,
            experience_id,
            content,
            "manual",
            revision_hash,
        )
        task = await factbanks.claim_next(
            worker_id="test-retrieval-worker",
            lease_until=datetime.now(UTC) + timedelta(seconds=60),
            schema_version="factbank-v1",
            extractor_version="atomic-facts-v1",
            embedding_model="test-embedding",
        )
        assert task is not None
        facts = build_fact_records(
            experience_id=experience_id,
            revision_id=revision_id,
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
        await factbanks.replace_facts(
            task,
            facts,
            mode="extracted",
            schema_version="factbank-v1",
            extractor_version="atomic-facts-v1",
        )
        await factbanks.complete(
            task,
            facts,
            [vector],
            vector,
            mode="extracted",
            schema_version="factbank-v1",
            extractor_version="atomic-facts-v1",
            embedding_model="test-embedding",
        )

        bundles = await retrieval.load_current_experience_facts(
            user_id,
            embedding_model="test-embedding",
        )
        assert len(bundles) == 1
        assert bundles[0].facts[0].fact_id == facts[0].fact_id
        assert len(bundles[0].facts[0].embedding) == 512

        text_hashes = {"req-python": "text-hash"}
        await retrieval.save_requirement_embeddings(
            user_id,
            "requirements-fingerprint",
            "test-embedding",
            text_hashes,
            {"req-python": tuple(vector)},
        )
        cached = await retrieval.get_requirement_embeddings(
            user_id,
            "requirements-fingerprint",
            "test-embedding",
            text_hashes,
        )
        stale = await retrieval.get_requirement_embeddings(
            user_id,
            "requirements-fingerprint",
            "test-embedding",
            {"req-python": "changed-text-hash"},
        )
        assert len(cached["req-python"]) == 512
        assert stale == {}

        embedder = _EmbeddingProvider()
        service = build_hybrid_fact_retrieval_service(
            pool,
            embedder,
            embedding_model="test-embedding",
            max_candidates=10,
            semantic_match_threshold=0.45,
        )
        requirement = JdRequirement(
            id="req-python-live",
            text="Python backend APIs",
            category="skill",
            importance="high",
            keywords=("Python",),
            weight=1.0,
            v2_importance="must_have",
            v2_category="technology",
        )
        first = await service.retrieve(user_id, [requirement])
        second = await service.retrieve(user_id, [requirement])
        assert embedder.calls == 1
        assert first.retrieval_result.selected_fact_ids == (facts[0].fact_id,)
        assert first.evidence_pack.coverage_ratio == 1.0
        assert second.retrieval_result.diagnostics.requirement_embedding_cache_hits == 1
    finally:
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM users WHERE id = $1", user_id)
        await pool.close()
