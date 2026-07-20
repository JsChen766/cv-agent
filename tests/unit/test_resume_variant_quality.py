from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core.errors import NotFoundError, ValidationError
from app.domain.resume.models import Resume, ResumeVariant
from app.domain.resume.service import ResumeService
from app.infra.db.repositories.resume_repo import PostgresResumeRepository


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


def _resume_with_variants(*variants: ResumeVariant) -> Resume:
    now = datetime.now(UTC)
    return Resume(
        id="resume-1",
        user_id="user-1",
        title="Resume",
        variants=list(variants),
        created_at=now,
        updated_at=now,
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


async def test_discarded_passed_variant_is_not_acceptable() -> None:
    variant = _variant("passed").model_copy(update={"publication_status": "discarded"})

    with pytest.raises(ValidationError) as exc_info:
        await _service(variant).get_acceptable_variant("user-1", variant.id)

    assert exc_info.value.code == "resume_variant_not_acceptable"


async def test_repository_detail_only_exposes_published_nonfailed_variants() -> None:
    published = _variant("passed").model_copy(update={"publication_status": "published"})
    staged = _variant("passed").model_copy(
        update={"id": "variant-staged", "publication_status": "staged"}
    )
    failed = _variant("failed").model_copy(
        update={"id": "variant-failed", "publication_status": "published"}
    )
    repo = MagicMock()
    repo.get = AsyncMock(return_value=_resume_with_variants(published, staged, failed))

    result = await ResumeService(repo).get_repository_resume("user-1", "resume-1")

    assert [variant.id for variant in result.variants] == [published.id]


async def test_repository_detail_hides_resume_with_only_staged_variant() -> None:
    staged = _variant("passed").model_copy(update={"publication_status": "staged"})
    repo = MagicMock()
    repo.get = AsyncMock(return_value=_resume_with_variants(staged))

    with pytest.raises(NotFoundError, match="Resume not found"):
        await ResumeService(repo).get_repository_resume("user-1", "resume-1")


class _ConnectionContext:
    def __init__(self, connection: AsyncMock) -> None:
        self.connection = connection

    async def __aenter__(self) -> AsyncMock:
        return self.connection

    async def __aexit__(self, *args: object) -> None:
        return None


async def test_repository_list_filters_to_manual_or_published_resumes() -> None:
    connection = AsyncMock()
    connection.fetch.return_value = []
    pool = MagicMock()
    pool.acquire.return_value = _ConnectionContext(connection)

    await PostgresResumeRepository(pool).list("user-1")

    sql = connection.fetch.await_args.args[0]
    assert "NOT EXISTS (SELECT 1 FROM resume_variants" in sql
    assert "visible_variant.publication_status = 'published'" in sql
    assert "visible_variant.quality_status <> 'failed'" in sql
