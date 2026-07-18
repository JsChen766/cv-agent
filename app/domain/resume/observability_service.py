from __future__ import annotations

from app.core.errors import NotFoundError, ValidationError
from app.core.types import generate_id
from app.domain.resume.layout_templates import get_resume_template
from app.domain.resume.observability_models import (
    BrowserBulletMetric,
    BrowserLayoutObservationCreate,
    BrowserLayoutObservationInput,
    BrowserLayoutObservationResult,
    BrowserLayoutVerificationResult,
    BrowserLayoutVerificationStatus,
    BrowserLayoutViolation,
    ResumeGenerationRunFinish,
    ResumeGenerationRunRecord,
    ResumeGenerationRunStart,
)
from app.domain.resume.observability_repository import ResumeObservabilityRepository

_BROWSER_LAYOUT_TOLERANCE_PX = 1.0


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
            template_id=observation.template_id,
            profile_version=observation.profile_version,
            profile_hash=observation.profile_hash,
            profile_matches=profile_matches,
            fonts_ready=observation.fonts_ready,
            loaded_font_families=observation.loaded_font_families,
            page_count=observation.page_count,
            overflow_px=observation.overflow_px,
            used_height_px=observation.used_height_px,
            available_height_px=observation.available_height_px,
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

    async def verify_layout_observation(
        self,
        *,
        user_id: str,
        resume_id: str,
        variant_id: str,
        structured: dict[str, object],
        observation: BrowserLayoutObservationInput,
    ) -> BrowserLayoutVerificationResult:
        """Persist and evaluate one browser measurement against its exact candidate.

        Clients submit raw pixel dimensions. Ratios and all pass/fail decisions are
        computed here so a browser cannot mark its own candidate as acceptable.
        """
        saved = await self.save_layout_observation(
            user_id=user_id,
            resume_id=resume_id,
            variant_id=variant_id,
            observation=observation,
        )
        violations: list[BrowserLayoutViolation] = []

        expected_template_id = str(structured.get("layout_template_id") or "")
        if observation.template_id != expected_template_id:
            violations.append(
                BrowserLayoutViolation(
                    code="template_mismatch",
                    message="Browser template does not match the generated candidate.",
                    retryable=True,
                )
            )
        if not saved.profile_matches:
            violations.append(
                BrowserLayoutViolation(
                    code="profile_mismatch",
                    message="Browser profile version/hash does not match the candidate.",
                    retryable=True,
                )
            )
        if not observation.fonts_ready:
            violations.append(
                BrowserLayoutViolation(
                    code="font_unavailable",
                    message="Required resume fonts were not ready during measurement.",
                    retryable=True,
                )
            )

        required_fonts = _required_font_families(structured, expected_template_id)
        loaded_fonts = {family.strip().casefold() for family in observation.loaded_font_families}
        for required in sorted(required_fonts):
            if required.casefold() not in loaded_fonts:
                violations.append(
                    BrowserLayoutViolation(
                        code="font_mismatch",
                        message=f"Required font '{required}' was not reported as loaded.",
                        retryable=True,
                    )
                )

        expected_bullets = _structured_bullet_ids(structured)
        observed_bullets = {bullet.bullet_id for bullet in observation.bullets}
        if expected_bullets != observed_bullets:
            violations.append(
                BrowserLayoutViolation(
                    code="candidate_mismatch",
                    message="Observed bullet IDs do not match the current candidate.",
                    retryable=True,
                )
            )

        template = get_resume_template(expected_template_id)
        usage = observation.used_height_px / observation.available_height_px
        if observation.page_count != 1:
            violations.append(
                BrowserLayoutViolation(
                    code="multi_page",
                    message="Browser rendering must fit on exactly one page.",
                )
            )
        if observation.overflow_px > _BROWSER_LAYOUT_TOLERANCE_PX:
            violations.append(
                BrowserLayoutViolation(
                    code="overflow",
                    message="Browser rendering overflows the A4 content box.",
                )
            )
        if usage < template.minimum_page_usage_ratio:
            violations.append(
                BrowserLayoutViolation(
                    code="underfilled",
                    message="Browser page usage is below the template minimum.",
                )
            )
        if usage > template.maximum_page_usage_ratio:
            violations.append(
                BrowserLayoutViolation(
                    code="overfilled",
                    message="Browser page usage exceeds the template maximum.",
                )
            )

        repairable_bullet_ids: list[str] = []
        for bullet in observation.bullets:
            ratio = bullet.last_line_width_px / bullet.available_line_width_px
            if ratio + 1e-12 < template.profile.bullet.gate_ratio:
                repairable_bullet_ids.append(bullet.bullet_id)
                violations.append(
                    BrowserLayoutViolation(
                        code="bullet_tail",
                        message="Browser bullet tail is below the required width ratio.",
                        bullet_id=bullet.bullet_id,
                    )
                )

        status: BrowserLayoutVerificationStatus
        if not violations:
            status = "passed"
        elif repairable_bullet_ids and all(
            violation.code == "bullet_tail" for violation in violations
        ):
            status = "needs_revision"
        else:
            status = "failed"
        return BrowserLayoutVerificationResult(
            status=status,
            observation=saved,
            violations=violations,
            repairable_bullet_ids=repairable_bullet_ids,
        )


def _structured_bullet_ids(structured: dict[str, object]) -> set[str]:
    result: set[str] = set()
    sections = structured.get("sections")
    if not isinstance(sections, list):
        return result
    for section in sections:
        if not isinstance(section, dict):
            continue
        items = section.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            bullets = item.get("bullets")
            if not isinstance(bullets, list):
                continue
            for bullet in bullets:
                if isinstance(bullet, dict) and isinstance(bullet.get("id"), str):
                    result.add(bullet["id"])
    return result


def _required_font_families(
    structured: dict[str, object], template_id: str
) -> set[str]:
    template = get_resume_template(template_id)
    text = _rendered_string_content(structured)
    required: set[str] = set()
    if any("\u3400" <= character <= "\u9fff" for character in text):
        required.add(template.profile.chinese_font.family)
    if any(character.isascii() and character.isalnum() for character in text):
        required.add(template.profile.english_font.family)
    if not required:
        required.add(template.profile.english_font.family)
    return required


def _rendered_string_content(structured: dict[str, object]) -> str:
    rendered_keys = {
        "name",
        "email",
        "phone",
        "location",
        "linkedin",
        "heading",
        "title",
        "organization",
        "role",
        "start_date",
        "end_date",
        "raw_text",
        "text",
    }
    values: list[str] = []

    def visit(value: object, key: str | None = None) -> None:
        if isinstance(value, str):
            if key in rendered_keys:
                values.append(value)
            return
        if isinstance(value, dict):
            for nested_key, nested in value.items():
                visit(nested, nested_key)
            return
        if isinstance(value, list):
            for nested in value:
                visit(nested, key)

    visit(structured)
    return " ".join(values)
