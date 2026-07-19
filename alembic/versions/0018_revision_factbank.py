"""Add revision-aware atomic FactBank storage and durable worker state.

Revision ID: 0018
Revises: 0017
Create Date: 2026-07-19
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def _has_vector_type() -> bool:
    conn = op.get_bind()
    return bool(conn.scalar(sa.text("SELECT to_regtype('vector') IS NOT NULL")))


def upgrade() -> None:
    embedding_column = "vector(512)" if _has_vector_type() else "DOUBLE PRECISION[]"
    op.execute("ALTER TABLE experience_revisions ADD COLUMN IF NOT EXISTS revision_hash TEXT")
    op.execute(
        "ALTER TABLE experience_revisions "
        "ADD COLUMN IF NOT EXISTS factbank_status TEXT NOT NULL DEFAULT 'pending'"
    )
    op.execute("ALTER TABLE experience_revisions ADD COLUMN IF NOT EXISTS factbank_mode TEXT")
    op.execute(
        "ALTER TABLE experience_revisions ADD COLUMN IF NOT EXISTS factbank_schema_version TEXT"
    )
    op.execute(
        "ALTER TABLE experience_revisions ADD COLUMN IF NOT EXISTS factbank_extractor_version TEXT"
    )
    op.execute(
        "ALTER TABLE experience_revisions ADD COLUMN IF NOT EXISTS factbank_embedding_model TEXT"
    )
    op.execute(
        "ALTER TABLE experience_revisions "
        "ADD COLUMN IF NOT EXISTS factbank_attempt_count INTEGER NOT NULL DEFAULT 0"
    )
    op.execute(
        "ALTER TABLE experience_revisions "
        "ADD COLUMN IF NOT EXISTS factbank_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
    )
    op.execute(
        "ALTER TABLE experience_revisions ADD COLUMN IF NOT EXISTS factbank_lease_until TIMESTAMPTZ"
    )
    op.execute("ALTER TABLE experience_revisions ADD COLUMN IF NOT EXISTS factbank_worker_id TEXT")
    op.execute("ALTER TABLE experience_revisions ADD COLUMN IF NOT EXISTS factbank_last_error TEXT")
    op.execute(
        "ALTER TABLE experience_revisions ADD COLUMN IF NOT EXISTS factbank_ready_at TIMESTAMPTZ"
    )
    op.execute(
        "ALTER TABLE experience_revisions "
        "ADD CONSTRAINT ck_experience_revisions_factbank_status "
        "CHECK (factbank_status IN "
        "('pending','extracting','indexing','retry','ready','failed'))"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_experience_revisions_factbank_queue "
        "ON experience_revisions (factbank_status, factbank_next_attempt_at, created_at)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_experience_revisions_revision_hash "
        "ON experience_revisions (revision_hash)"
    )

    op.execute(
        f"""
        CREATE TABLE IF NOT EXISTS fact_records (
            fact_id                 TEXT PRIMARY KEY,
            experience_id           TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
            source_revision_id      TEXT NOT NULL REFERENCES experience_revisions(id) ON DELETE CASCADE,
            source_revision_hash    TEXT NOT NULL,
            action                  TEXT,
            object                  TEXT,
            method                  TEXT,
            technologies            JSONB NOT NULL DEFAULT '[]',
            scope                   TEXT,
            constraint_text         TEXT,
            result                  TEXT,
            metrics                 JSONB NOT NULL DEFAULT '[]',
            time_range              TEXT,
            source_text             TEXT NOT NULL,
            source_start            INTEGER NOT NULL CHECK (source_start >= 0),
            source_end              INTEGER NOT NULL CHECK (source_end >= source_start),
            strength_score          DOUBLE PRECISION NOT NULL
                                    CHECK (strength_score >= 0 AND strength_score <= 1),
            lexical_tokens          TEXT[] NOT NULL DEFAULT '{{}}',
            embedding               {embedding_column},
            schema_version          TEXT NOT NULL,
            extractor_version       TEXT NOT NULL,
            embedding_model         TEXT,
            created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (source_revision_id, source_start, source_end, fact_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_fact_records_experience_id ON fact_records (experience_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_fact_records_source_revision_id "
        "ON fact_records (source_revision_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_fact_records_revision_hash "
        "ON fact_records (source_revision_hash)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_fact_records_lexical_tokens "
        "ON fact_records USING GIN (lexical_tokens)"
    )
    if _has_vector_type():
        op.execute(
            "CREATE INDEX IF NOT EXISTS idx_fact_records_embedding "
            "ON fact_records USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
        )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS fact_records")
    op.execute(
        "ALTER TABLE experience_revisions "
        "DROP CONSTRAINT IF EXISTS ck_experience_revisions_factbank_status"
    )
    for column in (
        "factbank_ready_at",
        "factbank_last_error",
        "factbank_worker_id",
        "factbank_lease_until",
        "factbank_next_attempt_at",
        "factbank_attempt_count",
        "factbank_embedding_model",
        "factbank_extractor_version",
        "factbank_schema_version",
        "factbank_mode",
        "factbank_status",
        "revision_hash",
    ):
        op.execute(f"ALTER TABLE experience_revisions DROP COLUMN IF EXISTS {column}")
