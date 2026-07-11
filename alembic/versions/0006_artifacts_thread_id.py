"""artifacts: add thread_id for canvas persistence

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-11
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def _column_exists(table: str, column: str) -> bool:
    conn = op.get_bind()
    return bool(
        conn.scalar(
            sa.text(
                """
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = :table
                  AND column_name = :column
                """
            ),
            {"table": table, "column": column},
        )
    )


def upgrade() -> None:
    if not _column_exists("artifacts", "thread_id"):
        op.add_column(
            "artifacts",
            sa.Column(
                "thread_id",
                sa.Text(),
                sa.ForeignKey("threads.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_artifacts_thread_id ON artifacts(thread_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_artifacts_thread_id")
    op.drop_column("artifacts", "thread_id")
