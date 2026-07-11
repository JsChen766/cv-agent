"""local embedding dimensions

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-04
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


EMBEDDING_COLUMNS = [
    ("experiences", "embedding"),
    ("experience_revisions", "embedding"),
    ("preferences", "embedding"),
    ("guideline_chunks", "embedding"),
]


def _has_vector_type() -> bool:
    conn = op.get_bind()
    return bool(conn.scalar(sa.text("SELECT to_regtype('vector') IS NOT NULL")))


def _embedding_is_vector(table: str, column: str) -> bool:
    conn = op.get_bind()
    regtype = conn.scalar(
        sa.text(
            """
            SELECT format_type(a.atttypid, a.atttypmod)
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema()
              AND c.relname = :table
              AND a.attname = :column
              AND NOT a.attisdropped
            """
        ),
        {"table": table, "column": column},
    )
    return isinstance(regtype, str) and regtype.startswith("vector")


def _create_vector_index(name: str, table: str, lists: int) -> None:
    if not _has_vector_type() or not _embedding_is_vector(table, "embedding"):
        return
    op.execute(
        f"CREATE INDEX IF NOT EXISTS {name} "
        f"ON {table} USING ivfflat (embedding vector_cosine_ops) WITH (lists = {lists})"
    )


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_experiences_embedding")
    op.execute("DROP INDEX IF EXISTS idx_preferences_embedding")
    op.execute("DROP INDEX IF EXISTS idx_guideline_embedding")

    for table, column in EMBEDDING_COLUMNS:
        op.execute(f"UPDATE {table} SET {column} = NULL WHERE {column} IS NOT NULL")
        if _has_vector_type() and _embedding_is_vector(table, column):
            op.execute(f"ALTER TABLE {table} ALTER COLUMN {column} TYPE vector(512)")

    _create_vector_index("idx_experiences_embedding", "experiences", 100)
    _create_vector_index("idx_preferences_embedding", "preferences", 10)
    _create_vector_index("idx_guideline_embedding", "guideline_chunks", 10)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_experiences_embedding")
    op.execute("DROP INDEX IF EXISTS idx_preferences_embedding")
    op.execute("DROP INDEX IF EXISTS idx_guideline_embedding")

    for table, column in EMBEDDING_COLUMNS:
        op.execute(f"UPDATE {table} SET {column} = NULL WHERE {column} IS NOT NULL")
        if _has_vector_type() and _embedding_is_vector(table, column):
            op.execute(f"ALTER TABLE {table} ALTER COLUMN {column} TYPE vector(1536)")

    _create_vector_index("idx_experiences_embedding", "experiences", 100)
    _create_vector_index("idx_preferences_embedding", "preferences", 10)
    _create_vector_index("idx_guideline_embedding", "guideline_chunks", 10)
