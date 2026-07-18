from __future__ import annotations

import asyncpg

from app.domain.resume.observability_models import (
    BrowserLayoutObservationCreate,
    BrowserLayoutObservationResult,
    ResumeGenerationRunFinish,
    ResumeGenerationRunRecord,
    ResumeGenerationRunStart,
    VariantLayoutProfile,
)
from app.infra.db.helpers import parse_jsonb


class PostgresResumeObservabilityRepository:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def start_run(self, data: ResumeGenerationRunStart) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO resume_generation_runs (
                    id, user_id, thread_id, turn_id, request_id, parent_run_id,
                    trigger, status, provider, model, trace_version, started_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$10,$11)
                ON CONFLICT (id) DO NOTHING
                """,
                data.id,
                data.user_id,
                data.thread_id,
                data.turn_id,
                data.request_id,
                data.parent_run_id,
                data.trigger,
                data.provider,
                data.model,
                data.trace_version,
                data.started_at,
            )

    async def finish_run(self, data: ResumeGenerationRunFinish) -> bool:
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                """
                UPDATE resume_generation_runs
                SET status=$1, resume_id=$2, variant_id=$3,
                    provider=COALESCE($4, provider), model=COALESCE($5, model),
                    graph_duration_ms=$6, endpoint_duration_ms=$7,
                    llm_logical_calls=$8, llm_physical_requests=$9,
                    input_tokens=$10, output_tokens=$11,
                    payload_hash=$12, payload_snapshot=$13::jsonb,
                    layout_report=$14::jsonb, metrics=$15::jsonb,
                    error_code=$16, completed_at=$17
                WHERE id=$18 AND user_id=$19 AND status='running'
                """,
                data.status,
                data.resume_id,
                data.variant_id,
                data.provider,
                data.model,
                data.graph_duration_ms,
                data.endpoint_duration_ms,
                data.llm_logical_calls,
                data.llm_physical_requests,
                data.input_tokens,
                data.output_tokens,
                data.payload_hash,
                data.payload_snapshot,
                data.layout_report,
                data.metrics,
                data.error_code,
                data.completed_at,
                data.id,
                data.user_id,
            )
        return bool(result.endswith(" 1"))

    async def get_run_for_user(
        self, user_id: str, run_id: str
    ) -> ResumeGenerationRunRecord | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT id, user_id, thread_id, turn_id, trigger, status, variant_id, metrics
                FROM resume_generation_runs WHERE id=$1 AND user_id=$2
                """,
                run_id,
                user_id,
            )
        if row is None:
            return None
        return ResumeGenerationRunRecord(
            id=row["id"],
            user_id=row["user_id"],
            thread_id=row["thread_id"],
            turn_id=row["turn_id"],
            trigger=row["trigger"],
            status=row["status"],
            variant_id=row["variant_id"],
            metrics=parse_jsonb(row["metrics"]) or {},
        )

    async def get_variant_profile_for_user(
        self, user_id: str, resume_id: str, variant_id: str
    ) -> VariantLayoutProfile | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT rv.structured->>'layout_profile_version' AS profile_version,
                       rv.structured->>'layout_profile_hash' AS profile_hash
                FROM resume_variants rv
                JOIN resumes r ON r.id=rv.resume_id
                WHERE r.user_id=$1 AND r.id=$2 AND rv.id=$3
                """,
                user_id,
                resume_id,
                variant_id,
            )
        return VariantLayoutProfile(**dict(row)) if row is not None else None

    async def save_layout_observation(
        self, data: BrowserLayoutObservationCreate
    ) -> BrowserLayoutObservationResult | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO resume_layout_observations (
                    id, run_id, user_id, resume_id, variant_id, surface,
                    measurement_version, profile_version, profile_hash, profile_matches,
                    fonts_ready, loaded_font_families, page_count, overflow_px,
                    page_usage_ratio, viewport, page_metrics, bullet_metrics,
                    client_build, observed_at, idempotency_key
                )
                SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,
                       $16::jsonb,$17::jsonb,$18::jsonb,$19,$20,$21
                FROM resume_variants rv
                JOIN resumes r ON r.id=rv.resume_id
                WHERE r.user_id=$3 AND r.id=$4 AND rv.id=$5
                ON CONFLICT (variant_id, surface, idempotency_key) DO NOTHING
                RETURNING *, TRUE AS inserted_now
                """,
                data.id,
                data.run_id,
                data.user_id,
                data.resume_id,
                data.variant_id,
                data.surface,
                data.measurement_version,
                data.profile_version,
                data.profile_hash,
                data.profile_matches,
                data.fonts_ready,
                data.loaded_font_families,
                data.page_count,
                data.overflow_px,
                data.page_usage_ratio,
                data.viewport,
                data.page_metrics,
                data.bullet_metrics,
                data.client_build,
                data.observed_at,
                data.idempotency_key,
            )
            created = row is not None
            if row is None:
                row = await conn.fetchrow(
                    """
                    SELECT o.*, FALSE AS inserted_now
                    FROM resume_layout_observations o
                    JOIN resumes r ON r.id=o.resume_id
                    WHERE r.user_id=$1 AND o.resume_id=$2 AND o.variant_id=$3
                      AND o.surface=$4 AND o.idempotency_key=$5
                    """,
                    data.user_id,
                    data.resume_id,
                    data.variant_id,
                    data.surface,
                    data.idempotency_key,
                )
        if row is None:
            return None
        return _observation_result(row, created=created)


def _observation_result(
    row: asyncpg.Record, *, created: bool
) -> BrowserLayoutObservationResult:
    return BrowserLayoutObservationResult(
        id=row["id"],
        run_id=row["run_id"],
        user_id=row["user_id"],
        resume_id=row["resume_id"],
        variant_id=row["variant_id"],
        surface=row["surface"],
        measurement_version=row["measurement_version"],
        profile_version=row["profile_version"],
        profile_hash=row["profile_hash"],
        profile_matches=row["profile_matches"],
        fonts_ready=row["fonts_ready"],
        loaded_font_families=parse_jsonb(row["loaded_font_families"]) or [],
        page_count=row["page_count"],
        overflow_px=float(row["overflow_px"]),
        page_usage_ratio=float(row["page_usage_ratio"]),
        viewport=parse_jsonb(row["viewport"]) or {},
        page_metrics=parse_jsonb(row["page_metrics"]) or [],
        bullet_metrics=parse_jsonb(row["bullet_metrics"]) or [],
        client_build=row["client_build"],
        observed_at=row["observed_at"],
        idempotency_key=row["idempotency_key"],
        created_at=row["created_at"],
        created=created,
    )
