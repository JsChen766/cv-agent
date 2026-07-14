"""threads: add workspace_snapshot JSONB column

Revision ID: 0012
Revises: 0011
Create Date: 2026-07-15
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def _column_exists(table: str, column: str) -> bool:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = :t AND column_name = :c"
        ),
        {"t": table, "c": column},
    ).fetchone()
    return rows is not None


def upgrade() -> None:
    if not _column_exists("threads", "workspace_snapshot"):
        op.add_column(
            "threads",
            sa.Column(
                "workspace_snapshot",
                postgresql.JSONB(),
                nullable=False,
                server_default=sa.text("'{}'::jsonb"),
            ),
        )


def downgrade() -> None:
    if _column_exists("threads", "workspace_snapshot"):
        op.drop_column("threads", "workspace_snapshot")
