"""Add append-only resume generation observability tables.

Revision ID: 0015
Revises: 0014
Create Date: 2026-07-18
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def _table_exists(table: str) -> bool:
    conn = op.get_bind()
    return bool(
        conn.execute(
            sa.text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema=current_schema() AND table_name=:table"
            ),
            {"table": table},
        ).fetchone()
    )


def upgrade() -> None:
    if not _table_exists("resume_generation_runs"):
        op.execute(
            """
            CREATE TABLE resume_generation_runs (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                thread_id TEXT,
                turn_id TEXT,
                request_id TEXT,
                parent_run_id TEXT REFERENCES resume_generation_runs(id) ON DELETE SET NULL,
                trigger TEXT NOT NULL CHECK (trigger IN (
                    'chat','chat_stream','product_action','application_package',
                    'tier3_edit','interrupt_resume','tool_bypass'
                )),
                status TEXT NOT NULL CHECK (status IN (
                    'running','completed','interrupted','failed','cancelled'
                )),
                resume_id TEXT REFERENCES resumes(id) ON DELETE SET NULL,
                variant_id TEXT REFERENCES resume_variants(id) ON DELETE SET NULL,
                provider TEXT,
                model TEXT,
                trace_version TEXT NOT NULL,
                graph_duration_ms BIGINT,
                endpoint_duration_ms BIGINT,
                llm_logical_calls INTEGER NOT NULL DEFAULT 0,
                llm_physical_requests INTEGER NOT NULL DEFAULT 0,
                input_tokens BIGINT NOT NULL DEFAULT 0,
                output_tokens BIGINT NOT NULL DEFAULT 0,
                payload_hash TEXT,
                payload_snapshot JSONB,
                layout_report JSONB,
                metrics JSONB NOT NULL DEFAULT '{}',
                error_code TEXT,
                started_at TIMESTAMPTZ NOT NULL,
                completed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_resume_runs_created "
        "ON resume_generation_runs(created_at)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_resume_runs_provider_model_created "
        "ON resume_generation_runs(provider, model, created_at)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_resume_runs_thread_turn "
        "ON resume_generation_runs(thread_id, turn_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_resume_runs_variant "
        "ON resume_generation_runs(variant_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_resume_runs_status_created "
        "ON resume_generation_runs(status, created_at)"
    )

    if not _table_exists("resume_layout_observations"):
        op.execute(
            """
            CREATE TABLE resume_layout_observations (
                id TEXT PRIMARY KEY,
                run_id TEXT REFERENCES resume_generation_runs(id) ON DELETE SET NULL,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                resume_id TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
                variant_id TEXT NOT NULL REFERENCES resume_variants(id) ON DELETE CASCADE,
                surface TEXT NOT NULL CHECK (surface IN (
                    'preview','review','print','application_package'
                )),
                measurement_version TEXT NOT NULL,
                profile_version TEXT NOT NULL,
                profile_hash TEXT NOT NULL,
                profile_matches BOOLEAN NOT NULL,
                fonts_ready BOOLEAN NOT NULL,
                loaded_font_families JSONB NOT NULL,
                page_count INTEGER NOT NULL CHECK (page_count >= 0),
                overflow_px DOUBLE PRECISION NOT NULL CHECK (overflow_px >= 0),
                page_usage_ratio DOUBLE PRECISION NOT NULL CHECK (page_usage_ratio >= 0),
                viewport JSONB NOT NULL,
                page_metrics JSONB NOT NULL DEFAULT '[]',
                bullet_metrics JSONB NOT NULL DEFAULT '[]',
                client_build TEXT NOT NULL,
                observed_at TIMESTAMPTZ NOT NULL,
                idempotency_key TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (variant_id, surface, idempotency_key)
            )
            """
        )


def downgrade() -> None:
    if _table_exists("resume_layout_observations"):
        op.drop_table("resume_layout_observations")
    if _table_exists("resume_generation_runs"):
        op.drop_table("resume_generation_runs")
