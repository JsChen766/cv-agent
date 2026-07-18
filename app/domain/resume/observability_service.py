from __future__ import annotations

from app.core.errors import NotFoundError, ValidationError
from app.core.types import generate_id
from app.domain.resume.observability_models import (
    BrowserBulletMetric,
    BrowserLayoutObservationCreate,
    BrowserLayoutObservationInput,
    BrowserLayoutObservationResult,
    ResumeGenerationRunFinish,
    ResumeGenerationRunRecord,
    ResumeGenerationRunStart,
)
from app.domain.resume.observability_repository import ResumeObservabilityRepository


class ResumeObservabilityService:
    def __init__(self, repository: ResumeObservabilityRepository) -> None:
        self._repository = repository

    async def start_run(self, data: ResumeGenerationRunStart) -> None:
        await self._repository.start_run(data)

    async def finish_run(self, data: ResumeGenerationRunFinish) -> bool:
        return await self._repository.finish_run(data)

    async def get_run_for_user(
        self, user_id: str, run_id: str
    ) -> ResumeGenerationRunRecord | None:
        return await self._repository.get_run_for_user(user_id, run_id)

    async def save_layout_observation(
        self,
        *,
        user_id: str,
        resume_id: str,
        variant_id: str,
        observation: BrowserLayoutObservationInput,
    ) -> BrowserLayoutObservationResult:
        profile = await self._repository.get_variant_profile_for_user(
            user_id, resume_id, variant_id
        )
        if profile is None:
            raise NotFoundError("Resume variant not found")
        if observation.run_id is not None:
            run = await self._repository.get_run_for_user(user_id, observation.run_id)
            if run is None:
                raise NotFoundError("Resume generation run not found")
            if run.variant_id is not None and run.variant_id != variant_id:
                raise ValidationError("run does not belong to the supplied variant")

        page_usage_ratio = observation.used_height_px / observation.available_height_px
        bullet_metrics = [
            BrowserBulletMetric(
                bullet_id=bullet.bullet_id,
                line_count=bullet.line_count,
                last_line_width_px=bullet.last_line_width_px,
                available_line_width_px=bullet.available_line_width_px,
                last_line_ratio=(
                    bullet.last_line_width_px / bullet.available_line_width_px
                ),
            ).model_dump(mode="json")
            for bullet in observation.bullets
        ]
        profile_matches = (
            profile.profile_version == observation.profile_version
            and profile.profile_hash == observation.profile_hash
        )
        create = BrowserLayoutObservationCreate(
            id=generate_id("rlobs-"),
            run_id=observation.run_id,
            user_id=user_id,
            resume_id=resume_id,
            variant_id=variant_id,
            surface=observation.surface,
            measurement_version=observation.measurement_version,
            profile_version=observation.profile_version,
            profile_hash=observation.profile_hash,
            profile_matches=profile_matches,
            fonts_ready=observation.fonts_ready,
            loaded_font_families=observation.loaded_font_families,
            page_count=observation.page_count,
            overflow_px=observation.overflow_px,
            page_usage_ratio=page_usage_ratio,
            viewport=observation.viewport.model_dump(mode="json"),
            page_metrics=observation.page_metrics,
            bullet_metrics=bullet_metrics,
            client_build=observation.client_build,
            observed_at=observation.observed_at,
            idempotency_key=observation.idempotency_key,
        )
        saved = await self._repository.save_layout_observation(create)
        if saved is None:
            raise NotFoundError("Resume variant not found")
        return saved
