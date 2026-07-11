"""FastAPI dependency injection wiring."""

from __future__ import annotations

import asyncpg
from fastapi import Cookie, Depends, Header

from app.api.auth_utils import decode_access_token
from app.core.config import settings
from app.core.errors import ExternalServiceError, UnauthorizedError
from app.domain.artifact.service import ArtifactService
from app.domain.experience.service import ExperienceService
from app.domain.jd.service import JdService
from app.domain.preference.service import PreferenceService
from app.domain.resume.service import ResumeService
from app.domain.user.models import User
from app.domain.user.service import UserService
from app.infra.db.connection import get_pool
from app.infra.db.repositories.artifact_repo import PostgresArtifactRepository
from app.infra.db.repositories.experience_repo import PostgresExperienceRepository
from app.infra.db.repositories.jd_repo import PostgresJdRepository
from app.infra.db.repositories.preference_repo import PostgresPreferenceRepository
from app.infra.db.repositories.resume_repo import PostgresResumeRepository
from app.infra.db.repositories.user_repo import PostgresUserRepository
from app.rag.evidence.indexer import EvidenceExperienceIndexer
from app.tools.base import ServiceContainer

# ── Pool ──────────────────────────────────────────────────────────────────────

async def pool_dep() -> asyncpg.Pool | None:
    """Return the DB pool, or None if not yet initialised (e.g. during tests)."""
    try:
        return get_pool()
    except RuntimeError:
        return None


# ── Services ──────────────────────────────────────────────────────────────────

def _require_pool(pool: asyncpg.Pool | None) -> asyncpg.Pool:
    if pool is None:
        raise ExternalServiceError("Database unavailable")
    return pool


def build_service_container(pool: asyncpg.Pool | None) -> ServiceContainer:
    checked_pool = _require_pool(pool)
    return ServiceContainer(
        experience=ExperienceService(
            PostgresExperienceRepository(checked_pool),
            EvidenceExperienceIndexer(checked_pool),
        ),
        jd=JdService(PostgresJdRepository(checked_pool)),
        resume=ResumeService(PostgresResumeRepository(checked_pool)),
        artifact=ArtifactService(PostgresArtifactRepository(checked_pool)),
        preference=PreferenceService(PostgresPreferenceRepository(checked_pool)),
        user=UserService(PostgresUserRepository(checked_pool)),
    )


async def get_user_service(pool: asyncpg.Pool | None = Depends(pool_dep)) -> UserService:
    return UserService(PostgresUserRepository(_require_pool(pool)))


async def get_experience_service(pool: asyncpg.Pool | None = Depends(pool_dep)) -> ExperienceService:
    checked_pool = _require_pool(pool)
    return ExperienceService(
        PostgresExperienceRepository(checked_pool),
        EvidenceExperienceIndexer(checked_pool),
    )


async def get_jd_service(pool: asyncpg.Pool | None = Depends(pool_dep)) -> JdService:
    return JdService(PostgresJdRepository(_require_pool(pool)))


async def get_resume_service(pool: asyncpg.Pool | None = Depends(pool_dep)) -> ResumeService:
    return ResumeService(PostgresResumeRepository(_require_pool(pool)))


async def get_artifact_service(pool: asyncpg.Pool | None = Depends(pool_dep)) -> ArtifactService:
    return ArtifactService(PostgresArtifactRepository(_require_pool(pool)))


async def get_preference_service(pool: asyncpg.Pool | None = Depends(pool_dep)) -> PreferenceService:
    return PreferenceService(PostgresPreferenceRepository(_require_pool(pool)))


# ── Auth ──────────────────────────────────────────────────────────────────────

def _extract_token(
    authorization: str | None = Header(default=None),
    access_token: str | None = Cookie(default=None),
) -> str | None:
    """Extract Bearer token from Authorization header or cookie."""
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:]
    if access_token:
        return access_token
    return None


async def get_current_user(
    token: str | None = Depends(_extract_token),
    pool: asyncpg.Pool | None = Depends(pool_dep),
) -> User:
    if token is None and settings.environment == "development" and settings.dev_auto_auth:
        user_svc = UserService(PostgresUserRepository(_require_pool(pool)))
        return await user_svc.get_by_id(settings.dev_user_id)
    if token is None:
        raise UnauthorizedError("No authentication token provided")
    user_id = decode_access_token(token)
    user_svc = UserService(PostgresUserRepository(_require_pool(pool)))
    return await user_svc.get_by_id(user_id)


async def get_current_user_id(
    token: str | None = Depends(_extract_token),
) -> str:
    if token is None and settings.environment == "development" and settings.dev_auto_auth:
        return settings.dev_user_id
    if token is None:
        raise UnauthorizedError("No authentication token provided")
    return decode_access_token(token)
