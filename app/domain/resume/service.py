from __future__ import annotations

from app.core.errors import NotFoundError
from app.core.types import RESUME_PREFIX, VARIANT_PREFIX, generate_id
from app.domain.resume.models import (
    Resume,
    ResumeItem,
    ResumeItemCreate,
    ResumeItemPatch,
    ResumePatch,
    ResumeVariant,
    ResumeVariantCreate,
    ResumeVariantPatch,
)
from app.domain.resume.patch import apply_patch_operations
from app.domain.resume.render import render_structured_to_markdown
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
        self, user_id: str, resume_id: str, patch: ResumePatch
    ) -> Resume:
        await self.get_resume(user_id, resume_id)
        return await self._repo.update(user_id, resume_id, patch)

    async def delete_resume(self, user_id: str, resume_id: str) -> None:
        await self.get_resume(user_id, resume_id)
        await self._repo.delete(user_id, resume_id)

    # ── Items ─────────────────────────────────────────────────────────────────

    async def add_item(self, user_id: str, resume_id: str, data: ResumeItemCreate) -> ResumeItem:
        await self.get_resume(user_id, resume_id)
        item_id = generate_id("item-")
        return await self._repo.add_item(item_id, resume_id, data)

    async def get_item_by_id(self, user_id: str, item_id: str) -> ResumeItem:
        item = await self._repo.get_item_for_user(user_id, item_id)
        if not item:
            raise NotFoundError(f"Resume item not found: {item_id}")
        return item

    async def update_item(
        self, user_id: str, resume_id: str, item_id: str, patch: ResumeItemPatch
    ) -> ResumeItem:
        await self.get_resume(user_id, resume_id)
        item = await self._repo.update_item(user_id, item_id, patch)
        if item.resume_id != resume_id:
            raise NotFoundError(f"Resume item not found: {item_id}")
        return item

    async def update_item_by_id(
        self, user_id: str, item_id: str, patch: ResumeItemPatch
    ) -> ResumeItem:
        item = await self._repo.get_item_for_user(user_id, item_id)
        if not item:
            raise NotFoundError(f"Resume item not found: {item_id}")
        return await self._repo.update_item(user_id, item_id, patch)

    async def delete_item(
        self, user_id: str, resume_id: str, item_id: str
    ) -> None:
        await self.get_resume(user_id, resume_id)
        item = await self._repo.get_item_for_user(user_id, item_id)
        if not item or item.resume_id != resume_id:
            raise NotFoundError(f"Resume item not found: {item_id}")
        deleted = await self._repo.delete_item(user_id, item_id)
        if not deleted:
            raise NotFoundError(f"Resume item not found: {item_id}")

    async def delete_item_by_id(self, user_id: str, item_id: str) -> None:
        deleted = await self._repo.delete_item(user_id, item_id)
        if not deleted:
            raise NotFoundError(f"Resume item not found: {item_id}")

    async def reorder_items(
        self, user_id: str, resume_id: str, ordered_ids: list[str]
    ) -> list[ResumeItem]:
        await self.get_resume(user_id, resume_id)
        return await self._repo.reorder_items(resume_id, ordered_ids)

    # ── Variants ──────────────────────────────────────────────────────────────

    async def save_variant(self, resume_id: str, data: ResumeVariantCreate) -> ResumeVariant:
        variant_id = generate_id(VARIANT_PREFIX)
        return await self._repo.add_variant(variant_id, resume_id, data)

    async def save_variant_with_id(
        self, resume_id: str, variant_id: str, data: ResumeVariantCreate
    ) -> ResumeVariant:
        return await self._repo.add_variant(variant_id, resume_id, data)

    async def get_variant(self, variant_id: str) -> ResumeVariant:
        v = await self._repo.get_variant(variant_id)
        if not v:
            raise NotFoundError(f"Variant not found: {variant_id}")
        return v

    async def update_variant(
        self, user_id: str, variant_id: str, patch: ResumeVariantPatch
    ) -> ResumeVariant:
        variant = await self.get_variant(variant_id)
        await self.get_resume(user_id, variant.resume_id)
        return await self._repo.update_variant(user_id, variant_id, patch)

    async def list_variants(self, resume_id: str) -> list[ResumeVariant]:
        return await self._repo.list_variants(resume_id)

    async def patch_variant(
        self,
        user_id: str,
        variant_id: str,
        operations: list[dict],
    ) -> ResumeVariant:
        """Apply deterministic patch ops to a variant's structured data.

        Ownership is verified via the variant's resume. A new variant row is
        created (with parent_variant_id pointing to the source), so the version
        chain is preserved. The whole batch is atomic — any bad op raises
        ValueError before any DB write occurs.
        """
        variant = await self.get_variant(variant_id)
        await self.get_resume(user_id, variant.resume_id)
        if not variant.structured:
            raise NotFoundError(f"Variant has no structured data: {variant_id}")
        new_structured = apply_patch_operations(variant.structured, operations)
        new_content = render_structured_to_markdown(new_structured)
        return await self._repo.patch_variant_structured(
            variant_id=variant_id,
            structured=new_structured,
            content=new_content,
            parent_variant_id=variant_id,
        )
