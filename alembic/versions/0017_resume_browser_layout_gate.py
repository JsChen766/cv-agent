"""Persist browser layout gate inputs required by FE-4.

Revision ID: 0017
Revises: 0016
Create Date: 2026-07-18
"""

from __future__ import annotations

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE resume_layout_observations "
        "ADD COLUMN IF NOT EXISTS template_id TEXT"
    )
    op.execute(
        "ALTER TABLE resume_layout_observations "
        "ADD COLUMN IF NOT EXISTS used_height_px DOUBLE PRECISION"
    )
    op.execute(
        "ALTER TABLE resume_layout_observations "
        "ADD COLUMN IF NOT EXISTS available_height_px DOUBLE PRECISION"
    )
    op.execute(
        "UPDATE resume_layout_observations SET template_id = 'resume-standard' "
        "WHERE template_id IS NULL"
    )
    op.execute(
        "UPDATE resume_layout_observations "
        "SET available_height_px = 1, used_height_px = page_usage_ratio "
        "WHERE available_height_px IS NULL OR used_height_px IS NULL"
    )
    op.execute(
        "ALTER TABLE resume_layout_observations "
        "ALTER COLUMN template_id SET NOT NULL"
    )
    op.execute(
        "ALTER TABLE resume_layout_observations "
        "ALTER COLUMN used_height_px SET NOT NULL"
    )
    op.execute(
        "ALTER TABLE resume_layout_observations "
        "ALTER COLUMN available_height_px SET NOT NULL"
    )
    op.execute(
        "ALTER TABLE resume_layout_observations "
        "ADD CONSTRAINT ck_resume_layout_observations_template "
        "CHECK (template_id IN ('resume-standard','resume-sparse'))"
    )
    op.execute(
        "ALTER TABLE resume_layout_observations "
        "ADD CONSTRAINT ck_resume_layout_observations_heights "
        "CHECK (used_height_px >= 0 AND available_height_px > 0)"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE resume_layout_observations "
        "DROP CONSTRAINT IF EXISTS ck_resume_layout_observations_heights"
    )
    op.execute(
        "ALTER TABLE resume_layout_observations "
        "DROP CONSTRAINT IF EXISTS ck_resume_layout_observations_template"
    )
    op.execute(
        "ALTER TABLE resume_layout_observations "
        "DROP COLUMN IF EXISTS available_height_px"
    )
    op.execute(
        "ALTER TABLE resume_layout_observations "
        "DROP COLUMN IF EXISTS used_height_px"
    )
    op.execute(
        "ALTER TABLE resume_layout_observations DROP COLUMN IF EXISTS template_id"
    )
