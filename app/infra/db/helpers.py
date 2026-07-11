"""Shared helpers for asyncpg-based repositories."""

from __future__ import annotations

import json
from typing import Any

import asyncpg


def row_to_dict(record: asyncpg.Record) -> dict[str, Any]:
    """Convert an asyncpg Record to a plain dict."""
    return dict(record)


def jsonb(value: Any) -> str:
    """Serialise a Python value to a JSON string for JSONB columns."""
    return json.dumps(value, ensure_ascii=False, default=str)


def parse_jsonb(value: str | None) -> Any:
    """Deserialise a JSONB column value."""
    if value is None:
        return None
    if isinstance(value, str):
        return json.loads(value)
    return value  # asyncpg may already have decoded it


async def has_pgvector(conn: asyncpg.Connection) -> bool:
    return bool(await conn.fetchval("SELECT to_regtype('vector') IS NOT NULL"))


async def column_is_vector(
    conn: asyncpg.Connection,
    table: str,
    column: str,
) -> bool:
    regtype = await conn.fetchval(
        """
        SELECT format_type(a.atttypid, a.atttypmod)
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = $1
          AND a.attname = $2
          AND NOT a.attisdropped
        """,
        table,
        column,
    )
    return isinstance(regtype, str) and regtype.startswith("vector")


def cursor_encode(row_id: str) -> str:
    return row_id


def cursor_decode(cursor: str) -> str:
    return cursor
