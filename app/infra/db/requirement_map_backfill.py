"""Operational CLI for hashing legacy JDs and linking already-cached RequirementMaps."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass

import asyncpg

from app.core.config import settings
from app.domain.jd.requirement_map.service import compute_jd_hash, normalize_jd_text
from app.infra.db.connection import close_pool, create_pool


@dataclass(frozen=True)
class BackfillOptions:
    limit: int
    user_id: str | None
    dry_run: bool


@dataclass(frozen=True)
class BackfillResult:
    inspected: int
    linked: int


async def backfill_requirement_maps(
    pool: asyncpg.Pool,
    options: BackfillOptions,
) -> BackfillResult:
    values: list[object] = []
    user_filter = ""
    if options.user_id:
        values.append(options.user_id)
        user_filter = f" AND user_id = ${len(values)}"
    values.append(options.limit)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id, user_id, raw_text
            FROM jd_records
            WHERE (jd_hash IS NULL OR requirement_map_id IS NULL)
              AND requirements_origin <> 'manual'
              {user_filter}
            ORDER BY updated_at DESC
            LIMIT ${len(values)}
            """,
            *values,
        )
        if options.dry_run or not rows:
            return BackfillResult(inspected=len(rows), linked=0)

        await conn.executemany(
            "UPDATE jd_records SET jd_hash=$2 WHERE id=$1",
            [(row["id"], compute_jd_hash(normalize_jd_text(row["raw_text"]))) for row in rows],
        )
        linked = await conn.fetchval(
            """
            WITH updated AS (
                UPDATE jd_records jd
                SET requirement_map_id = rm.id,
                    requirements = rm.requirements,
                    requirements_origin = 'parsed',
                    title = COALESCE(rm.title, jd.title),
                    company = COALESCE(rm.company, jd.company),
                    target_role = COALESCE(rm.target_role, jd.target_role),
                    updated_at = NOW()
                FROM requirement_maps rm
                WHERE jd.id = ANY($1::text[])
                  AND rm.user_id = jd.user_id
                  AND rm.jd_hash = jd.jd_hash
                  AND rm.normalization_version = $2
                  AND rm.schema_version = $3
                  AND rm.parser_version = $4
                  AND rm.parser_model = $5
                RETURNING jd.id
            )
            SELECT COUNT(*) FROM updated
            """,
            [row["id"] for row in rows],
            settings.jd_requirement_normalization_version,
            settings.jd_requirement_schema_version,
            settings.jd_requirement_parser_version,
            settings.llm_model,
        )
    return BackfillResult(inspected=len(rows), linked=int(linked or 0))


def _parse_args() -> BackfillOptions:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--user-id")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be at least 1")
    return BackfillOptions(limit=args.limit, user_id=args.user_id, dry_run=args.dry_run)


async def _main() -> None:
    options = _parse_args()
    pool = await create_pool()
    try:
        result = await backfill_requirement_maps(pool, options)
        verb = "would inspect" if options.dry_run else "inspected"
        print(
            f"RequirementMap backfill {verb} {result.inspected} JD(s); "
            f"linked {result.linked} cached map(s)"
        )
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(_main())
