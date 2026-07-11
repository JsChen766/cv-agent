"""Persist resume/discard results for safe retries.

Revision ID: 0007
Revises: 0006
"""

from __future__ import annotations

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
    CREATE TABLE IF NOT EXISTS thread_interrupt_operations (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        interrupt_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('resume', 'discard')),
        status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
        response JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (thread_id, turn_id, interrupt_id, action)
    )
    """)
    op.execute("""
    CREATE UNIQUE INDEX IF NOT EXISTS uq_interrupt_operation_in_progress_thread
    ON thread_interrupt_operations(thread_id) WHERE status = 'in_progress'
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_interrupt_operation_in_progress_thread")
    op.execute("DROP TABLE IF EXISTS thread_interrupt_operations")
