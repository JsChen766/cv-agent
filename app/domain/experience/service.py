from __future__ import annotations

from app.core.errors import NotFoundError
from app.core.types import (
    CANDIDATE_PREFIX,
    EXP_PREFIX,
    JOB_PREFIX,
    ExperienceCategory,
    generate_id,
)
from app.domain.experience.models import (
    Experience,
    ExperiencePatch,
    ExperienceRevision,
    ImportCandidate,
    ImportCandidateCreate,
    ImportCandidateDraft,
    ImportJob,
)
from app.domain.experience.repository import ExperienceRepository


class ExperienceService:
    def __init__(self, repo: ExperienceRepository) -> None:
        self._repo = repo

    # ── List / Get ────────────────────────────────────────────────────────────

    async def list_experiences(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
        category: str | None = None,
        tags: list[str] | None = None,
        q: str | None = None,
    ) -> tuple[list[Experience], str | None]:
        return await self._repo.list(
            user_id, limit=limit, cursor=cursor, category=category, tags=tags, q=q
        )

    async def get_experience(self, user_id: str, experience_id: str) -> Experience:
        exp = await self._repo.get(user_id, experience_id)
        if not exp:
            raise NotFoundError(f"Experience not found: {experience_id}")
        return exp

    # ── Create ────────────────────────────────────────────────────────────────

    async def create_experience(
        self,
        user_id: str,
        *,
        category: ExperienceCategory,
        title: str,
        content: str,
        organization: str | None = None,
        role: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        tags: list[str] | None = None,
        source: str = "manual",
    ) -> Experience:
        exp_id = generate_id(EXP_PREFIX)
        rev_id = generate_id("rev-")
        exp = await self._repo.create(
            exp_id,
            user_id,
            category,
            title,
            organization=organization,
            role=role,
            start_date=start_date,
            end_date=end_date,
            tags=tags,
        )
        revision = await self._repo.add_revision(rev_id, exp_id, content, source)
        exp.current_revision = revision
        exp.current_revision_id = revision.id
        return exp

    # ── Update meta ───────────────────────────────────────────────────────────

    async def update_experience_meta(
        self, user_id: str, experience_id: str, patch: ExperiencePatch
    ) -> Experience:
        await self.get_experience(user_id, experience_id)  # ownership check
        return await self._repo.update(user_id, experience_id, patch)

    # ── Add revision ──────────────────────────────────────────────────────────

    async def add_revision(
        self,
        user_id: str,
        experience_id: str,
        content: str,
        source: str = "manual",
    ) -> ExperienceRevision:
        await self.get_experience(user_id, experience_id)  # ownership check
        rev_id = generate_id("rev-")
        return await self._repo.add_revision(rev_id, experience_id, content, source)

    async def get_revisions(
        self, user_id: str, experience_id: str
    ) -> list[ExperienceRevision]:
        await self.get_experience(user_id, experience_id)
        return await self._repo.get_revisions(experience_id)

    # ── Archive ───────────────────────────────────────────────────────────────

    async def archive_experience(self, user_id: str, experience_id: str) -> None:
        await self.get_experience(user_id, experience_id)
        await self._repo.archive(user_id, experience_id)

    # ── Import: text ──────────────────────────────────────────────────────────

    async def start_import_from_text(
        self,
        user_id: str,
        raw_text: str,
        candidates_data: list[ImportCandidateDraft],
    ) -> tuple[ImportJob, list[ImportCandidate]]:
        job_id = generate_id(JOB_PREFIX)
        job = await self._repo.create_import_job(job_id, user_id, "text")

        candidate_rows = [
            ImportCandidateCreate(
                id=generate_id(CANDIDATE_PREFIX),
                import_job_id=job_id,
                user_id=user_id,
                category=c.category,
                title=c.title,
                content=c.content,
                organization=c.organization,
                role=c.role,
            )
            for c in candidates_data
        ]
        candidates = await self._repo.create_candidates(candidate_rows)
        await self._repo.update_import_job_status(job_id, "completed")
        return job, candidates

    async def start_import_from_file(
        self,
        user_id: str,
        file_id: str,
        candidates_data: list[ImportCandidateDraft],
    ) -> tuple[ImportJob, list[ImportCandidate]]:
        job_id = generate_id(JOB_PREFIX)
        job = await self._repo.create_import_job(job_id, user_id, "file", file_id)

        candidate_rows = [
            ImportCandidateCreate(
                id=generate_id(CANDIDATE_PREFIX),
                import_job_id=job_id,
                user_id=user_id,
                category=c.category,
                title=c.title,
                content=c.content,
                organization=c.organization,
                role=c.role,
            )
            for c in candidates_data
        ]
        candidates = await self._repo.create_candidates(candidate_rows)
        await self._repo.update_import_job_status(job_id, "completed")
        return job, candidates

    # ── Accept / Reject candidates ────────────────────────────────────────────

    async def accept_candidate(
        self, user_id: str, candidate_id: str
    ) -> Experience:
        candidate = await self._repo.get_candidate(user_id, candidate_id)
        if not candidate:
            raise NotFoundError(f"Import candidate not found: {candidate_id}")

        exp = await self.create_experience(
            user_id,
            category=candidate.category,
            title=candidate.title,
            content=candidate.content,
            organization=candidate.organization,
            role=candidate.role,
            source="file_import",
        )
        await self._repo.update_candidate_status(candidate_id, "accepted")
        return exp

    async def reject_candidate(self, user_id: str, candidate_id: str) -> None:
        candidate = await self._repo.get_candidate(user_id, candidate_id)
        if not candidate:
            raise NotFoundError(f"Import candidate not found: {candidate_id}")
        await self._repo.update_candidate_status(candidate_id, "rejected")
