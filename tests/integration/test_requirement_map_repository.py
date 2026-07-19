from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime

import asyncpg
import pytest

from app.domain.jd.models import JdRequirement
from app.domain.jd.requirement_map.models import Requirement, RequirementMap
from app.infra.db.repositories.jd_repo import PostgresJdRepository
from app.infra.db.repositories.requirement_map_repo import PostgresRequirementMapRepository

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_DATABASE_URL"),
    reason="TEST_DATABASE_URL is required for PostgreSQL integration tests",
)


async def test_requirement_map_cache_and_jd_link_are_tenant_and_version_scoped() -> None:
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
    other_user_id = f"user-{suffix}-other"
    now = datetime.now(UTC)
    requirement_map = RequirementMap(
        requirement_map_id=f"rmap-{suffix}",
        user_id=user_id,
        jd_hash=f"hash-{suffix}",
        normalization_version="normalization-v1",
        schema_version="schema-v1",
        parser_version="parser-v1",
        parser_model="test-model",
        title="Backend Engineer",
        company="Acme",
        target_role="Backend Engineer",
        requirements=(
            Requirement(
                requirement_id=f"req-{suffix}",
                description="Build reliable Python APIs",
                category="responsibility",
                keywords=("Python", "API"),
                importance="must_have",
                weight=0.85,
            ),
        ),
        created_at=now,
        updated_at=now,
    )
    try:
        async with pool.acquire() as conn:
            await conn.executemany(
                "INSERT INTO users (id, email, hashed_password) VALUES ($1, $2, $3)",
                [
                    (user_id, f"{suffix}@example.com", "test"),
                    (other_user_id, f"{suffix}-other@example.com", "test"),
                ],
            )
        maps = PostgresRequirementMapRepository(pool)
        persisted = await maps.save(requirement_map)
        duplicate = requirement_map.model_copy(update={"requirement_map_id": f"rmap-{suffix}-2"})
        assert (await maps.save(duplicate)).requirement_map_id == persisted.requirement_map_id

        hit = await maps.get_cached(
            user_id,
            requirement_map.jd_hash,
            normalization_version="normalization-v1",
            schema_version="schema-v1",
            parser_version="parser-v1",
            parser_model="test-model",
        )
        miss_other_tenant = await maps.get_cached(
            other_user_id,
            requirement_map.jd_hash,
            normalization_version="normalization-v1",
            schema_version="schema-v1",
            parser_version="parser-v1",
            parser_model="test-model",
        )
        miss_other_version = await maps.get_cached(
            user_id,
            requirement_map.jd_hash,
            normalization_version="normalization-v1",
            schema_version="schema-v1",
            parser_version="parser-v2",
            parser_model="test-model",
        )
        assert hit is not None
        assert hit.requirements[0].keywords == ("Python", "API")
        assert miss_other_tenant is None
        assert miss_other_version is None

        jds = PostgresJdRepository(pool)
        jd = await jds.create(
            f"jd-{suffix}",
            user_id,
            "Backend Engineer",
            "Build reliable Python APIs",
            requirements=[
                JdRequirement(
                    id=hit.requirements[0].requirement_id,
                    text=hit.requirements[0].description,
                    category="experience",
                    importance="high",
                    keywords=hit.requirements[0].keywords,
                    weight=hit.requirements[0].weight,
                    v2_importance=hit.requirements[0].importance,
                )
            ],
            jd_hash=hit.jd_hash,
            requirement_map_id=hit.requirement_map_id,
            requirements_origin="parsed",
        )
        assert jd.jd_hash == hit.jd_hash
        assert jd.requirement_map_id == hit.requirement_map_id
        assert jd.requirements_origin == "parsed"
        assert jd.requirements[0].weight == 0.85
    finally:
        async with pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM users WHERE id = ANY($1::text[])", [user_id, other_user_id]
            )
        await pool.close()
