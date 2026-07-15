"""Add location to experiences and import candidates.

Revision ID: 0014
Revises: 0013
Create Date: 2026-07-15
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def _column_exists(table: str, column: str) -> bool:
    conn = op.get_bind()
    return conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = :table AND column_name = :column"
        ),
        {"table": table, "column": column},
    ).fetchone() is not None


def upgrade() -> None:
    if not _column_exists("experiences", "location"):
        op.add_column("experiences", sa.Column("location", sa.Text(), nullable=True))
    if not _column_exists("import_candidates", "location"):
        op.add_column("import_candidates", sa.Column("location", sa.Text(), nullable=True))


def downgrade() -> None:
    if _column_exists("import_candidates", "location"):
        op.drop_column("import_candidates", "location")
    if _column_exists("experiences", "location"):
        op.drop_column("experiences", "location")
