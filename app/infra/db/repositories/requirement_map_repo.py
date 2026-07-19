from __future__ import annotations

import json

import asyncpg

from app.domain.jd.requirement_map.models import Requirement, RequirementMap
from app.infra.db.helpers import parse_jsonb


class PostgresRequirementMapRepository:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get_cached(
        self,
        user_id: str,
        jd_hash: str,
        *,
        normalization_version: str,
        schema_version: str,
        parser_version: str,
        parser_model: str,
    ) -> RequirementMap | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT *
                FROM requirement_maps
                WHERE user_id = $1
                  AND jd_hash = $2
                  AND normalization_version = $3
                  AND schema_version = $4
                  AND parser_version = $5
                  AND parser_model = $6
                LIMIT 1
                """,
                user_id,
                jd_hash,
                normalization_version,
                schema_version,
                parser_version,
                parser_model,
            )
        return self._to_map(row) if row is not None else None

    async def save(self, requirement_map: RequirementMap) -> RequirementMap:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO requirement_maps (
                    id, user_id, jd_hash, normalization_version, schema_version,
                    parser_version, parser_model, title, company, target_role,
                    requirements, source, created_at, updated_at
                )
                VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14
                )
                ON CONFLICT (
                    user_id, jd_hash, normalization_version, schema_version,
                    parser_version, parser_model
                )
                DO UPDATE SET updated_at = requirement_maps.updated_at
                RETURNING *
                """,
                requirement_map.requirement_map_id,
                requirement_map.user_id,
                requirement_map.jd_hash,
                requirement_map.normalization_version,
                requirement_map.schema_version,
                requirement_map.parser_version,
                requirement_map.parser_model,
                requirement_map.title,
                requirement_map.company,
                requirement_map.target_role,
                json.dumps([item.model_dump(mode="json") for item in requirement_map.requirements]),
                requirement_map.source,
                requirement_map.created_at,
                requirement_map.updated_at,
            )
        if row is None:
            raise RuntimeError("Failed to persist RequirementMap")
        return self._to_map(row)

    @staticmethod
    def _to_map(row: asyncpg.Record) -> RequirementMap:
        raw_requirements = parse_jsonb(row["requirements"]) or []
        return RequirementMap(
            requirement_map_id=row["id"],
            user_id=row["user_id"],
            jd_hash=row["jd_hash"],
            normalization_version=row["normalization_version"],
            schema_version=row["schema_version"],
            parser_version=row["parser_version"],
            parser_model=row["parser_model"],
            title=row["title"],
            company=row["company"],
            target_role=row["target_role"],
            requirements=tuple(Requirement.model_validate(item) for item in raw_requirements),
            source=row["source"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
