"""Persist resume variant quality-gate state.

Revision ID: 0016
Revises: 0015
Create Date: 2026-07-18
"""

from __future__ import annotations

from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE resume_variants
            ADD COLUMN IF NOT EXISTS quality_status TEXT NOT NULL DEFAULT 'unverified',
            ADD COLUMN IF NOT EXISTS quality_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS quality_gate_version TEXT
        """
    )
    op.execute(
        """
        DO $$ BEGIN
            ALTER TABLE resume_variants
                ADD CONSTRAINT ck_resume_variants_quality_status
                CHECK (quality_status IN ('unverified','passed','needs_revision','failed'));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_resume_variants_quality_status "
        "ON resume_variants(quality_status)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_resume_variants_quality_status")
    op.execute(
        "ALTER TABLE resume_variants DROP CONSTRAINT IF EXISTS ck_resume_variants_quality_status"
    )
    op.execute(
        "ALTER TABLE resume_variants "
        "DROP COLUMN IF EXISTS quality_gate_version, "
        "DROP COLUMN IF EXISTS quality_issues, "
        "DROP COLUMN IF EXISTS quality_status"
    )
