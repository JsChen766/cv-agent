"""Unit tests for UserService — no database required."""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core.errors import ConflictError, UnauthorizedError
from app.domain.user.models import User
from app.domain.user.service import UserService


def _make_user(user_id: str = "user-1", email: str = "test@example.com") -> User:
    return User(
        id=user_id,
        email=email,
        hashed_password="$2b$12$fakehash",
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )


@pytest.fixture
def repo():
    r = MagicMock()
    r.get_by_id = AsyncMock(return_value=None)
    r.get_by_email = AsyncMock(return_value=None)
    r.create = AsyncMock()
    r.get_profile = AsyncMock(return_value=None)
    r.upsert_profile = AsyncMock()
    return r


@pytest.fixture
def svc(repo):
    return UserService(repo)


# ── register ──────────────────────────────────────────────────────────────────

async def test_register_creates_user(svc, repo):
    user = _make_user()
    repo.create.return_value = user
    result = await svc.register("test@example.com", "password123")
    assert result.email == "test@example.com"
    repo.create.assert_called_once()


async def test_register_raises_on_duplicate_email(svc, repo):
    repo.get_by_email.return_value = _make_user()
    with pytest.raises(ConflictError):
        await svc.register("test@example.com", "password123")


# ── authenticate ──────────────────────────────────────────────────────────────

async def test_authenticate_raises_on_wrong_password(svc, repo):
    user = _make_user()
    # Store a real hash so verify_password can check
    real_svc = svc
    user.hashed_password = real_svc.hash_password("correct")
    repo.get_by_email.return_value = user

    with pytest.raises(UnauthorizedError):
        await svc.authenticate("test@example.com", "wrong")


async def test_authenticate_returns_user_on_correct_password(svc, repo):
    user = _make_user()
    user.hashed_password = svc.hash_password("correct")
    repo.get_by_email.return_value = user

    result = await svc.authenticate("test@example.com", "correct")
    assert result.id == user.id


async def test_authenticate_raises_when_user_not_found(svc, repo):
    repo.get_by_email.return_value = None
    with pytest.raises(UnauthorizedError):
        await svc.authenticate("nobody@example.com", "pass")
