from __future__ import annotations

from app.core.errors import NotFoundError
from app.core.types import RESUME_PREFIX, VARIANT_PREFIX, generate_id
from app.domain.resume.models import Resume, ResumeItem, ResumeVariant
from app.domain.resume.repository import ResumeRepository


class ResumeService:
    def __init__(self, repo: ResumeRepository) -> None:
        self._repo = repo

    async def list_resumes(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
    ) -> tuple[list[Resume], str | None]:
        return await self._repo.list(user_id, limit=limit, cursor=cursor)

    async def get_resume(self, user_id: str, resume_id: str) -> Resume:
        resume = await self._repo.get(user_id, resume_id)
        if not resume:
            raise NotFoundError(f"Resume not found: {resume_id}")
        return resume

    async def create_resume(
        self,
        user_id: str,
        title: str,
        *,
        target_role: str | None = None,
        jd_id: str | None = None,
    ) -> Resume:
        resume_id = generate_id(RESUME_PREFIX)
        return await self._repo.create(
            resume_id, user_id, title, target_role=target_role, jd_id=jd_id
        )

    async def update_resume(
        self, user_id: str, resume_id: str, patch: dict
    ) -> Resume:
        await self.get_resume(user_id, resume_id)
        return await self._repo.update(user_id, resume_id, patch)

    async def delete_resume(self, user_id: str, resume_id: str) -> None:
        await self.get_resume(user_id, resume_id)
        await self._repo.delete(user_id, resume_id)

    # ── Items ─────────────────────────────────────────────────────────────────

    async def add_item(self, user_id: str, resume_id: str, data: dict) -> ResumeItem:
        await self.get_resume(user_id, resume_id)
        item_id = generate_id("item-")
        return await self._repo.add_item(item_id, resume_id, data)

    async def update_item(
        self, user_id: str, resume_id: str, item_id: str, patch: dict
    ) -> ResumeItem:
        await self.get_resume(user_id, resume_id)
        return await self._repo.update_item(item_id, patch)

    async def delete_item(
        self, user_id: str, resume_id: str, item_id: str
    ) -> None:
        await self.get_resume(user_id, resume_id)
        await self._repo.delete_item(item_id)

    async def reorder_items(
        self, user_id: str, resume_id: str, ordered_ids: list[str]
    ) -> list[ResumeItem]:
        await self.get_resume(user_id, resume_id)
        return await self._repo.reorder_items(resume_id, ordered_ids)

    # ── Variants ──────────────────────────────────────────────────────────────

    async def save_variant(self, resume_id: str, data: dict) -> ResumeVariant:
        variant_id = generate_id(VARIANT_PREFIX)
        return await self._repo.add_variant(variant_id, resume_id, data)

    async def get_variant(self, variant_id: str) -> ResumeVariant:
        v = await self._repo.get_variant(variant_id)
        if not v:
            raise NotFoundError(f"Variant not found: {variant_id}")
        return v
