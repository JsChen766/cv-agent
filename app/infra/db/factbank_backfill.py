"""Operational CLI for queuing legacy or failed revisions for FactBank rebuild."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass

import asyncpg

from app.domain.resume.factbank.service import compute_revision_hash
from app.infra.db.connection import close_pool, create_pool


@dataclass(frozen=True)
class BackfillOptions:
    limit: int
    user_id: str | None
    retry_failed: bool
    dry_run: bool


async def enqueue_backfill(pool: asyncpg.Pool, options: BackfillOptions) -> int:
    conditions = ["(er.revision_hash IS NULL"]
    if options.retry_failed:
        conditions.append(" OR er.factbank_status = 'failed'")
    conditions.append(")")
    values: list[object] = []
    user_filter = ""
    if options.user_id:
        values.append(options.user_id)
        user_filter = f" AND e.user_id = ${len(values)}"
    values.append(options.limit)
    limit_parameter = len(values)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT er.id, er.content, er.revision_hash
            FROM experience_revisions er
            JOIN experiences e ON e.id = er.experience_id
            WHERE {"".join(conditions)}{user_filter}
            ORDER BY (e.current_revision_id = er.id) DESC, er.created_at DESC
            LIMIT ${limit_parameter}
            """,
            *values,
        )
        if options.dry_run or not rows:
            return len(rows)
        await conn.executemany(
            """
            UPDATE experience_revisions
            SET revision_hash = $2,
                factbank_status = 'pending',
                factbank_attempt_count = 0,
                factbank_next_attempt_at = NOW(),
                factbank_lease_until = NULL,
                factbank_worker_id = NULL,
                factbank_last_error = NULL
            WHERE id = $1
            """,
            [
                (
                    row["id"],
                    row["revision_hash"] or compute_revision_hash(row["content"]),
                )
                for row in rows
            ],
        )
    return len(rows)


def _parse_args() -> BackfillOptions:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--user-id")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be at least 1")
    return BackfillOptions(
        limit=args.limit,
        user_id=args.user_id,
        retry_failed=args.retry_failed,
        dry_run=args.dry_run,
    )


async def _main() -> None:
    options = _parse_args()
    pool = await create_pool()
    try:
        count = await enqueue_backfill(pool, options)
        verb = "would enqueue" if options.dry_run else "enqueued"
        print(f"FactBank backfill {verb} {count} revision(s)")
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(_main())
