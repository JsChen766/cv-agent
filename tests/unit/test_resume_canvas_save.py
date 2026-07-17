from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError as PydanticValidationError

from app.api.routes.product.resume import _serialize_variant
from app.api.routes.threads import SaveResumeCanvasRequest
from app.domain.resume.models import Resume, ResumeVariant
from app.domain.resume.service import ResumeService


def _structured_resume() -> dict[str, object]:
    return {
        "language": "zh-CN",
        "contact": {"name": "张三", "email": "zhang@example.com"},
        "sections": [
            {
                "id": "section-1",
                "type": "experience",
                "heading": "工作经历",
                "items": [
                    {
                        "id": "item-1",
                        "title": "Software Engineer",
                        "organization": "Example",
                        "bullets": [{"id": "bullet-1", "text": "Built APIs"}],
                    }
                ],
            }
        ],
    }


def test_canvas_save_request_prefers_structured_without_requiring_content() -> None:
    body = SaveResumeCanvasRequest(
        selectedVariantId="variant-1",
        structured=_structured_resume(),
    )

    assert body.content is None
    assert body.structured == _structured_resume()


def test_canvas_save_request_keeps_legacy_content_only_compatibility() -> None:
    body = SaveResumeCanvasRequest(
        selectedVariantId="variant-1",
        content="# Legacy resume",
    )

    assert body.structured is None
    assert body.content == "# Legacy resume"


def test_canvas_save_request_rejects_missing_resume_source() -> None:
    with pytest.raises(PydanticValidationError, match="Either structured or content is required"):
        SaveResumeCanvasRequest(selectedVariantId="variant-1")


@pytest.mark.asyncio
async def test_service_derives_content_when_saving_canonical_structure() -> None:
    now = datetime.now()
    original = ResumeVariant(
        id="variant-1",
        resume_id="resume-1",
        title="Original",
        content="client supplied content must not win",
        structured=_structured_resume(),
        created_at=now,
    )
    owned_resume = Resume(
        id="resume-1",
        user_id="user-1",
        title="Resume",
        created_at=now,
        updated_at=now,
    )
    repo = MagicMock()
    repo.get_variant = AsyncMock(return_value=original)
    repo.get = AsyncMock(return_value=owned_resume)

    async def persist(
        user_id: str,
        variant_id: str,
        structured: dict[str, object],
        content: str,
        *,
        title: str | None = None,
    ) -> ResumeVariant:
        assert user_id == "user-1"
        assert variant_id == "variant-1"
        assert title == "Saved title"
        assert "张三" in content
        assert "Software Engineer" in content
        assert "client supplied content" not in content
        return original.model_copy(
            update={
                "title": title,
                "structured": structured,
                "content": content,
            }
        )

    repo.save_variant_structure = AsyncMock(side_effect=persist)
    service = ResumeService(repo)

    result = await service.save_variant_structure(
        "user-1",
        "variant-1",
        _structured_resume(),
        title="Saved title",
    )

    assert result.title == "Saved title"
    assert result.structured == _structured_resume()
    repo.save_variant_structure.assert_awaited_once()


def test_resume_detail_serializes_structured_source() -> None:
    variant = ResumeVariant(
        id="variant-1",
        resume_id="resume-1",
        title="Draft",
        content="# Draft",
        structured=_structured_resume(),
        created_at=datetime.now(),
    )

    serialized = _serialize_variant(variant)

    assert serialized["structured"] == _structured_resume()
