"""artifacts: add structured JSONB column

Revision ID: 0011
Revises: 0010
Create Date: 2026-07-14
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
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
    if not _column_exists("artifacts", "structured"):
        op.add_column(
            "artifacts",
            sa.Column("structured", sa.dialects.postgresql.JSONB(), nullable=True),
        )


def downgrade() -> None:
    if _column_exists("artifacts", "structured"):
        op.drop_column("artifacts", "structured")
