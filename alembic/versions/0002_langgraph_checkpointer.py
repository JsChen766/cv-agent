"""langgraph checkpointer tables

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-04

LangGraph PostgresSaver requires these tables.
See: https://langchain-ai.github.io/langgraph/reference/checkpoints/
"""

from __future__ import annotations

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # LangGraph checkpoint storage
    op.execute("""
    CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id           TEXT NOT NULL,
        checkpoint_ns       TEXT NOT NULL DEFAULT '',
        checkpoint_id       TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type                TEXT,
        checkpoint          JSONB NOT NULL,
        metadata            JSONB NOT NULL DEFAULT '{}',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
    )
    """)

    op.execute("""
    CREATE TABLE IF NOT EXISTS checkpoint_blobs (
        thread_id       TEXT NOT NULL,
        checkpoint_ns   TEXT NOT NULL DEFAULT '',
        channel         TEXT NOT NULL,
        version         TEXT NOT NULL,
        type            TEXT NOT NULL,
        blob            BYTEA,
        PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
    )
    """)

    op.execute("""
    CREATE TABLE IF NOT EXISTS checkpoint_writes (
        thread_id       TEXT NOT NULL,
        checkpoint_ns   TEXT NOT NULL DEFAULT '',
        checkpoint_id   TEXT NOT NULL,
        task_id         TEXT NOT NULL,
        idx             INTEGER NOT NULL,
        channel         TEXT NOT NULL,
        type            TEXT,
        blob            BYTEA NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
    )
    """)

    # App-level thread metadata (for listing conversations)
    op.execute("""
    CREATE TABLE IF NOT EXISTS threads (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        title       TEXT,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    op.execute("CREATE INDEX IF NOT EXISTS idx_threads_user_id ON threads(user_id);")


def downgrade() -> None:
    for table in ["threads", "checkpoint_writes", "checkpoint_blobs", "checkpoints"]:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
