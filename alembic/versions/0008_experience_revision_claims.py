"""Persist extracted evidence claims on experience revisions.

Revision ID: 0008
Revises: 0007
"""

from __future__ import annotations

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE experience_revisions "
        "ADD COLUMN IF NOT EXISTS claims JSONB"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE experience_revisions DROP COLUMN IF EXISTS claims")
