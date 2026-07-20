"""Normalize double-encoded resume variant structures.

Revision ID: 0021
Revises: 0020
Create Date: 2026-07-20
"""

from __future__ import annotations

from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE resume_variants
        SET structured = (structured #>> '{}')::jsonb
        WHERE structured IS NOT NULL
          AND jsonb_typeof(structured) = 'string'
        """
    )


def downgrade() -> None:
    # This is a canonical data repair. Reintroducing double encoding would make
    # layout profile fields inaccessible to PostgreSQL JSON operators.
    pass
