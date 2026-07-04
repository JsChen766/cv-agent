"""thread_messages table

Revision ID: 0003
Revises: 0002
Create Date: 2026-07-04
"""

from __future__ import annotations

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
    CREATE TABLE IF NOT EXISTS thread_messages (
        id          TEXT PRIMARY KEY,
        thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role        TEXT NOT NULL,          -- user | assistant | system
        content     TEXT NOT NULL,
        metadata    JSONB NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id ON thread_messages(thread_id, created_at);")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS thread_messages CASCADE")
