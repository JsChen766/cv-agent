from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.core.errors import NotFoundError, ValidationError
from app.domain.resume.observability_models import (
    BrowserBulletMeasurement,
    BrowserLayoutObservationInput,
    BrowserLayoutObservationResult,
    BrowserViewport,
    ResumeGenerationRunRecord,
    VariantLayoutProfile,
)
from app.domain.resume.observability_service import ResumeObservabilityService


class FakeRepository:
    def __init__(self) -> None:
        self.profile: VariantLayoutProfile | None = VariantLayoutProfile(
            profile_version="resume-template-v2",
            profile_hash="profile-hash",
        )
        self.run: ResumeGenerationRunRecord | None = ResumeGenerationRunRecord(
            id="rgrun-1",
            user_id="user-1",
            trigger="chat",
            status="interrupted",
            variant_id="variant-1",
        )
        self.saved = None

    async def start_run(self, data):
        return None

    async def finish_run(self, data):
        return True

    async def get_variant_profile_for_user(self, user_id, resume_id, variant_id):
        return self.profile

    async def get_run_for_user(self, user_id, run_id):
        return self.run

    async def save_layout_observation(self, data):
        self.saved = data
        return BrowserLayoutObservationResult(
            **data.model_dump(),
            created_at=datetime.now(UTC),
        )


def _observation(**updates: object) -> BrowserLayoutObservationInput:
    values = {
        "run_id": "rgrun-1",
        "surface": "preview",
        "measurement_version": "browser-layout-observation-v1",
        "profile_version": "resume-template-v2",
        "profile_hash": "profile-hash",
        "fonts_ready": True,
        "loaded_font_families": ["SimSun"],
        "page_count": 1,
        "overflow_px": 0,
        "used_height_px": 880,
        "available_height_px": 1000,
        "viewport": BrowserViewport(
            width_px=1440,
            height_px=1200,
            device_pixel_ratio=1,
        ),
        "bullets": [
            BrowserBulletMeasurement(
                bullet_id="bullet-1",
                line_count=2,
                last_line_width_px=200,
                available_line_width_px=300,
            )
        ],
        "client_build": "test",
        "observed_at": datetime.now(UTC),
        "idempotency_key": "sample-1",
    }
    values.update(updates)
    return BrowserLayoutObservationInput.model_validate(values)


async def test_service_computes_ratios_and_profile_match_server_side() -> None:
    repository = FakeRepository()
    service = ResumeObservabilityService(repository)

    result = await service.save_layout_observation(
        user_id="user-1",
        resume_id="resume-1",
        variant_id="variant-1",
        observation=_observation(),
    )

    assert result.page_usage_ratio == pytest.approx(0.88)
    assert result.bullet_metrics[0]["last_line_ratio"] == pytest.approx(2 / 3)
    assert result.profile_matches is True


async def test_profile_mismatch_is_recorded_not_rejected() -> None:
    repository = FakeRepository()
    service = ResumeObservabilityService(repository)

    result = await service.save_layout_observation(
        user_id="user-1",
        resume_id="resume-1",
        variant_id="variant-1",
        observation=_observation(profile_hash="different"),
    )

    assert result.profile_matches is False


async def test_cross_variant_run_link_is_rejected() -> None:
    repository = FakeRepository()
    assert repository.run is not None
    repository.run.variant_id = "variant-other"
    service = ResumeObservabilityService(repository)

    with pytest.raises(ValidationError):
        await service.save_layout_observation(
            user_id="user-1",
            resume_id="resume-1",
            variant_id="variant-1",
            observation=_observation(),
        )


async def test_unknown_variant_is_not_found() -> None:
    repository = FakeRepository()
    repository.profile = None
    service = ResumeObservabilityService(repository)

    with pytest.raises(NotFoundError):
        await service.save_layout_observation(
            user_id="user-1",
            resume_id="resume-1",
            variant_id="variant-1",
            observation=_observation(),
        )


def test_duplicate_bullet_ids_and_non_finite_values_are_rejected() -> None:
    duplicate = _observation().model_dump()
    duplicate["bullets"] = [duplicate["bullets"][0], duplicate["bullets"][0]]
    with pytest.raises(ValueError, match="unique"):
        BrowserLayoutObservationInput.model_validate(duplicate)

    invalid = _observation().model_dump()
    invalid["overflow_px"] = float("nan")
    with pytest.raises(ValueError):
        BrowserLayoutObservationInput.model_validate(invalid)
