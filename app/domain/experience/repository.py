from __future__ import annotations

from typing import Protocol

from app.domain.experience.models import Experience, ExperienceRevision, ImportCandidate, ImportJob


class ExperienceRepository(Protocol):
    # ── Experience CRUD ───────────────────────────────────────────────────────
    async def list(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
        category: str | None = None,
        tags: list[str] | None = None,
        q: str | None = None,
    ) -> tuple[list[Experience], str | None]:
        """Return (items, next_cursor). next_cursor is None when no more pages."""
        ...

    async def get(self, user_id: str, experience_id: str) -> Experience | None: ...

    async def create(
        self,
        experience_id: str,
        user_id: str,
        category: str,
        title: str,
        *,
        organization: str | None = None,
        role: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        tags: list[str] | None = None,
    ) -> Experience: ...

    async def update(self, user_id: str, experience_id: str, patch: dict) -> Experience: ...

    async def archive(self, user_id: str, experience_id: str) -> None: ...

    # ── Revisions ─────────────────────────────────────────────────────────────
    async def get_revisions(self, experience_id: str) -> list[ExperienceRevision]: ...

    async def add_revision(
        self,
        revision_id: str,
        experience_id: str,
        content: str,
        source: str,
    ) -> ExperienceRevision: ...

    # ── Import Jobs ───────────────────────────────────────────────────────────
    async def create_import_job(
        self, job_id: str, user_id: str, source: str, file_id: str | None = None
    ) -> ImportJob: ...

    async def update_import_job_status(self, job_id: str, status: str) -> None: ...

    async def create_candidates(
        self, candidates: list[dict]
    ) -> list[ImportCandidate]: ...

    async def get_candidate(
        self, user_id: str, candidate_id: str
    ) -> ImportCandidate | None: ...

    async def update_candidate_status(
        self, candidate_id: str, status: str
    ) -> ImportCandidate: ...
