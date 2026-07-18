from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core.errors import ValidationError
from app.domain.resume.models import Resume, ResumeVariant
from app.domain.resume.service import ResumeService


def _variant(status: str) -> ResumeVariant:
    return ResumeVariant.model_validate(
        {
            "id": f"variant-{status}",
            "resume_id": "resume-1",
            "title": "Draft",
            "content": "# Resume",
            "gate_status": status,
            "created_at": datetime.now(UTC),
        }
    )


def _service(variant: ResumeVariant) -> ResumeService:
    now = datetime.now(UTC)
    resume = Resume(
        id="resume-1",
        user_id="user-1",
        title="Resume",
        created_at=now,
        updated_at=now,
    )
    repo = MagicMock()
    repo.get_variant = AsyncMock(return_value=variant)
    repo.get = AsyncMock(return_value=resume)
    return ResumeService(repo)


async def test_passed_variant_is_acceptable() -> None:
    variant = _variant("passed")

    result = await _service(variant).get_acceptable_variant("user-1", variant.id)

    assert result.id == variant.id


@pytest.mark.parametrize("status", ["unverified", "needs_revision", "failed"])
async def test_non_passed_variant_is_not_acceptable(status: str) -> None:
    variant = _variant(status)

    with pytest.raises(ValidationError) as exc_info:
        await _service(variant).get_acceptable_variant("user-1", variant.id)

    assert exc_info.value.code == "resume_variant_not_acceptable"
