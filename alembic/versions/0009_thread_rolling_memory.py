"""Persist incremental rolling conversation memory.

Revision ID: 0009
Revises: 0008
"""

from __future__ import annotations

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE threads ADD COLUMN IF NOT EXISTS rolling_summary TEXT")
    op.execute(
        "ALTER TABLE threads ADD COLUMN IF NOT EXISTS summarized_message_count "
        "INTEGER NOT NULL DEFAULT 0"
    )
    op.execute(
        "ALTER TABLE threads ADD COLUMN IF NOT EXISTS turn_count INTEGER NOT NULL DEFAULT 0"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE threads DROP COLUMN IF EXISTS turn_count")
    op.execute("ALTER TABLE threads DROP COLUMN IF EXISTS summarized_message_count")
    op.execute("ALTER TABLE threads DROP COLUMN IF EXISTS rolling_summary")
