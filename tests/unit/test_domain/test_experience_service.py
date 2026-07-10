"""Unit tests for ExperienceService — no database required."""

from datetime import date, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core.errors import NotFoundError
from app.domain.experience.models import (
    Experience,
    ExperiencePatch,
    ExperienceRevision,
    ImportCandidate,
)
from app.domain.experience.service import ExperienceService


def _make_exp(exp_id: str = "exp-1") -> Experience:
    return Experience(
        id=exp_id,
        user_id="user-1",
        category="work",
        title="Software Engineer",
        status="active",
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )


def _make_rev(rev_id: str = "rev-1", exp_id: str = "exp-1") -> ExperienceRevision:
    return ExperienceRevision(
        id=rev_id,
        experience_id=exp_id,
        content="# Work Experience\n- Built stuff",
        source="manual",
        created_at=datetime.now(),
    )


def _make_candidate() -> ImportCandidate:
    return ImportCandidate(
        id="cand-1",
        import_job_id="job-1",
        user_id="user-1",
        category="work",
        title="Engineer",
        content="content",
        status="pending",
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )


@pytest.fixture
def repo():
    r = MagicMock()
    r.list = AsyncMock(return_value=([], None))
    r.get = AsyncMock(return_value=None)
    r.create = AsyncMock()
    r.update = AsyncMock()
    r.archive = AsyncMock()
    r.get_revisions = AsyncMock(return_value=[])
    r.add_revision = AsyncMock()
    r.create_import_job = AsyncMock()
    r.update_import_job_status = AsyncMock()
    r.create_candidates = AsyncMock(return_value=[])
    r.get_candidate = AsyncMock(return_value=None)
    r.update_candidate_status = AsyncMock()
    return r


@pytest.fixture
def svc(repo):
    return ExperienceService(repo)


async def test_get_experience_raises_not_found(svc, repo):
    repo.get.return_value = None
    with pytest.raises(NotFoundError):
        await svc.get_experience("user-1", "exp-missing")


async def test_create_experience_calls_add_revision(svc, repo):
    exp = _make_exp()
    rev = _make_rev()
    repo.create.return_value = exp
    repo.add_revision.return_value = rev

    result = await svc.create_experience(
        "user-1", category="work", title="Engineer", content="# content"
    )
    assert result.current_revision_id == rev.id
    repo.add_revision.assert_called_once()


async def test_create_experience_converts_iso_date_strings_before_repo(svc, repo):
    exp = _make_exp()
    rev = _make_rev()
    repo.create.return_value = exp
    repo.add_revision.return_value = rev

    await svc.create_experience(
        "user-1",
        category="work",
        title="Engineer",
        content="# content",
        start_date="2025-09-01",
        end_date="2025-12",
    )

    assert repo.create.call_args.kwargs["start_date"] == date(2025, 9, 1)
    assert repo.create.call_args.kwargs["end_date"] == date(2025, 12, 1)


async def test_archive_calls_repo(svc, repo):
    repo.get.return_value = _make_exp()
    await svc.archive_experience("user-1", "exp-1")
    repo.archive.assert_called_once_with("user-1", "exp-1")


async def test_update_experience_meta_converts_iso_date_strings_before_repo(svc, repo):
    exp = _make_exp()
    repo.get.return_value = exp
    repo.update.return_value = exp

    await svc.update_experience_meta(
        "user-1",
        "exp-1",
        ExperiencePatch(start_date="2025-09-01", end_date="2025-12"),
    )

    sent_patch = repo.update.call_args.args[2]
    assert sent_patch.start_date == date(2025, 9, 1)
    assert sent_patch.end_date == date(2025, 12, 1)


async def test_accept_candidate_creates_experience(svc, repo):
    candidate = _make_candidate()
    exp = _make_exp()
    rev = _make_rev()
    repo.get_candidate.return_value = candidate
    repo.create.return_value = exp
    repo.add_revision.return_value = rev

    result = await svc.accept_candidate("user-1", "cand-1")
    # create() mock returns _make_exp() — what matters is it was called and status updated
    assert result.id == exp.id
    repo.update_candidate_status.assert_called_once_with("cand-1", "accepted")


async def test_reject_candidate_not_found_raises(svc, repo):
    repo.get_candidate.return_value = None
    with pytest.raises(NotFoundError):
        await svc.reject_candidate("user-1", "cand-missing")
