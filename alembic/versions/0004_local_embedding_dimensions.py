"""local embedding dimensions

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-04
"""

from __future__ import annotations

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


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_experiences_embedding")
    op.execute("DROP INDEX IF EXISTS idx_preferences_embedding")
    op.execute("DROP INDEX IF EXISTS idx_guideline_embedding")

    for table, column in EMBEDDING_COLUMNS:
        op.execute(f"UPDATE {table} SET {column} = NULL WHERE {column} IS NOT NULL")
        op.execute(f"ALTER TABLE {table} ALTER COLUMN {column} TYPE vector(512)")

    op.execute(
        "CREATE INDEX idx_experiences_embedding "
        "ON experiences USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
    )
    op.execute(
        "CREATE INDEX idx_preferences_embedding "
        "ON preferences USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10)"
    )
    op.execute(
        "CREATE INDEX idx_guideline_embedding "
        "ON guideline_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_experiences_embedding")
    op.execute("DROP INDEX IF EXISTS idx_preferences_embedding")
    op.execute("DROP INDEX IF EXISTS idx_guideline_embedding")

    for table, column in EMBEDDING_COLUMNS:
        op.execute(f"UPDATE {table} SET {column} = NULL WHERE {column} IS NOT NULL")
        op.execute(f"ALTER TABLE {table} ALTER COLUMN {column} TYPE vector(1536)")

    op.execute(
        "CREATE INDEX idx_experiences_embedding "
        "ON experiences USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
    )
    op.execute(
        "CREATE INDEX idx_preferences_embedding "
        "ON preferences USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10)"
    )
    op.execute(
        "CREATE INDEX idx_guideline_embedding "
        "ON guideline_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10)"
    )
