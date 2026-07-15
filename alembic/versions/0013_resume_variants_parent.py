"""resume_variants: add parent_variant_id for version chain

Revision ID: 0013
Revises: 0012
Create Date: 2026-07-15
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
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
    if not _column_exists("resume_variants", "parent_variant_id"):
        op.add_column(
            "resume_variants",
            sa.Column(
                "parent_variant_id",
                sa.Text(),
                sa.ForeignKey("resume_variants.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )


def downgrade() -> None:
    if _column_exists("resume_variants", "parent_variant_id"):
        op.drop_column("resume_variants", "parent_variant_id")
