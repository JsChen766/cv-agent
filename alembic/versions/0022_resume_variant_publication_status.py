"""Track staged, published, and discarded resume variants.

Revision ID: 0022
Revises: 0021
Create Date: 2026-07-20
"""

from __future__ import annotations

from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE resume_variants
            ADD COLUMN IF NOT EXISTS publication_status TEXT NOT NULL DEFAULT 'published'
        """
    )
    op.execute(
        """
        UPDATE resume_variants
        SET publication_status = 'discarded'
        WHERE quality_status = 'failed'
        """
    )
    op.execute(
        """
        UPDATE resume_variants
        SET publication_status = 'staged'
        WHERE quality_status = 'unverified'
          AND quality_issues @> '[{"code":"browser_verification_pending"}]'::jsonb
        """
    )
    op.execute(
        """
        DO $$ BEGIN
            ALTER TABLE resume_variants
                ADD CONSTRAINT ck_resume_variants_publication_status
                CHECK (publication_status IN ('staged','published','discarded'));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_resume_variants_publication_status "
        "ON resume_variants(publication_status)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_resume_variants_publication_status")
    op.execute(
        "ALTER TABLE resume_variants "
        "DROP CONSTRAINT IF EXISTS ck_resume_variants_publication_status"
    )
    op.execute("ALTER TABLE resume_variants DROP COLUMN IF EXISTS publication_status")
