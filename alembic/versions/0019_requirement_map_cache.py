"""Add versioned, tenant-scoped RequirementMap cache.

Revision ID: 0019
Revises: 0018
Create Date: 2026-07-19
"""

from __future__ import annotations

from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS requirement_maps (
            id                    TEXT PRIMARY KEY,
            user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            jd_hash               TEXT NOT NULL,
            normalization_version TEXT NOT NULL,
            schema_version        TEXT NOT NULL,
            parser_version        TEXT NOT NULL,
            parser_model          TEXT NOT NULL,
            title                 TEXT,
            company               TEXT,
            target_role           TEXT,
            requirements          JSONB NOT NULL DEFAULT '[]',
            source                TEXT NOT NULL DEFAULT 'parsed',
            created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT ck_requirement_maps_source
                CHECK (source IN ('parsed','manual','legacy')),
            CONSTRAINT uq_requirement_maps_cache_identity UNIQUE (
                user_id, jd_hash, normalization_version, schema_version,
                parser_version, parser_model
            )
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_requirement_maps_user_hash "
        "ON requirement_maps (user_id, jd_hash)"
    )
    op.execute("ALTER TABLE jd_records ADD COLUMN IF NOT EXISTS jd_hash TEXT")
    op.execute(
        "ALTER TABLE jd_records ADD COLUMN IF NOT EXISTS requirement_map_id TEXT "
        "REFERENCES requirement_maps(id) ON DELETE SET NULL"
    )
    op.execute(
        "ALTER TABLE jd_records ADD COLUMN IF NOT EXISTS requirements_origin TEXT "
        "NOT NULL DEFAULT 'legacy'"
    )
    op.execute(
        "ALTER TABLE jd_records ADD CONSTRAINT ck_jd_records_requirements_origin "
        "CHECK (requirements_origin IN ('parsed','manual','legacy'))"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_jd_records_requirement_map_id "
        "ON jd_records (requirement_map_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_jd_records_user_hash ON jd_records (user_id, jd_hash)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_jd_records_user_hash")
    op.execute("DROP INDEX IF EXISTS idx_jd_records_requirement_map_id")
    op.execute("ALTER TABLE jd_records DROP CONSTRAINT IF EXISTS ck_jd_records_requirements_origin")
    op.execute("ALTER TABLE jd_records DROP COLUMN IF EXISTS requirements_origin")
    op.execute("ALTER TABLE jd_records DROP COLUMN IF EXISTS requirement_map_id")
    op.execute("ALTER TABLE jd_records DROP COLUMN IF EXISTS jd_hash")
    op.execute("DROP TABLE IF EXISTS requirement_maps")
