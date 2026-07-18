from __future__ import annotations

from typing import Protocol

from app.domain.resume.observability_models import (
    BrowserLayoutObservationCreate,
    BrowserLayoutObservationResult,
    ResumeGenerationRunFinish,
    ResumeGenerationRunRecord,
    ResumeGenerationRunStart,
    VariantLayoutProfile,
)


class ResumeObservabilityRepository(Protocol):
    async def start_run(self, data: ResumeGenerationRunStart) -> None: ...

    async def finish_run(self, data: ResumeGenerationRunFinish) -> bool: ...

    async def save_layout_observation(
        self, data: BrowserLayoutObservationCreate
    ) -> BrowserLayoutObservationResult | None: ...

    async def get_run_for_user(
        self, user_id: str, run_id: str
    ) -> ResumeGenerationRunRecord | None: ...

    async def get_variant_profile_for_user(
        self, user_id: str, resume_id: str, variant_id: str
    ) -> VariantLayoutProfile | None: ...
