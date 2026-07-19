"""Add persistent embeddings for versioned retrieval requirements.

Revision ID: 0020
Revises: 0019
Create Date: 2026-07-19
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def _has_vector_type() -> bool:
    conn = op.get_bind()
    return bool(conn.scalar(sa.text("SELECT to_regtype('vector') IS NOT NULL")))


def upgrade() -> None:
    embedding_column = "vector(512)" if _has_vector_type() else "DOUBLE PRECISION[]"
    op.execute(
        f"""
        CREATE TABLE requirement_embeddings (
            user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            requirements_fingerprint TEXT NOT NULL,
            requirement_id           TEXT NOT NULL,
            embedding_model          TEXT NOT NULL,
            text_hash                TEXT NOT NULL,
            embedding                {embedding_column} NOT NULL,
            created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (
                user_id, requirements_fingerprint, requirement_id, embedding_model
            )
        )
        """
    )
    op.execute(
        "CREATE INDEX idx_requirement_embeddings_lookup "
        "ON requirement_embeddings (user_id, requirements_fingerprint, embedding_model)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS requirement_embeddings")
