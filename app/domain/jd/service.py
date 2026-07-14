from __future__ import annotations

from app.core.errors import NotFoundError
from app.core.types import JD_PREFIX, generate_id
from app.domain.jd.models import JdRecord, JdRequirement, JdRequirementDraft
from app.domain.jd.repository import JdRepository


class JdService:
    def __init__(self, repo: JdRepository) -> None:
        self._repo = repo

    async def list_jds(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
        q: str | None = None,
        company: str | None = None,
    ) -> tuple[list[JdRecord], str | None]:
        return await self._repo.list(
            user_id,
            limit=limit,
            cursor=cursor,
            q=q,
            company=company,
        )

    async def get_jd(self, user_id: str, jd_id: str) -> JdRecord:
        jd = await self._repo.get(user_id, jd_id)
        if not jd:
            raise NotFoundError(f"JD not found: {jd_id}")
        return jd

    async def create_jd(
        self,
        user_id: str,
        *,
        title: str,
        raw_text: str,
        company: str | None = None,
        target_role: str | None = None,
        requirements: list[JdRequirementDraft] | None = None,
        source_thread_id: str | None = None,
    ) -> JdRecord:
        jd_id = generate_id(JD_PREFIX)
        return await self._repo.create(
            jd_id,
            user_id,
            title,
            raw_text,
            company=company,
            target_role=target_role,
            requirements=self._normalize_requirements(requirements or []),
            source_thread_id=source_thread_id,
        )

    async def update_requirements(
        self, user_id: str, jd_id: str, requirements: list[JdRequirementDraft]
    ) -> JdRecord:
        await self.get_jd(user_id, jd_id)  # ownership check
        return await self._repo.update_requirements(
            jd_id, self._normalize_requirements(requirements)
        )

    async def create_or_update_from_raw_text(
        self,
        user_id: str,
        raw_text: str,
        *,
        source_thread_id: str | None = None,
    ) -> JdRecord:
        """Create a JD record from raw pasted text (no dedup — always creates a new row)."""
        jd_id = generate_id(JD_PREFIX)
        title = raw_text[:60].strip().splitlines()[0] or "Pasted JD"
        return await self._repo.create(
            jd_id,
            user_id,
            title,
            raw_text,
            source_thread_id=source_thread_id,
        )

    async def delete_jd(self, user_id: str, jd_id: str) -> None:
        await self.get_jd(user_id, jd_id)
        await self._repo.delete(user_id, jd_id)

    @staticmethod
    def _normalize_requirements(
        requirements: list[JdRequirementDraft],
    ) -> list[JdRequirement]:
        return [
            JdRequirement(
                id=req.id or generate_id("req-"),
                text=req.text,
                category=req.category,
                importance=req.importance,
            )
            for req in requirements
        ]
