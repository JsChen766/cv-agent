from __future__ import annotations

import copy
from typing import Any

from app.core.errors import NotFoundError, ValidationError
from app.core.types import RESUME_PREFIX, VARIANT_PREFIX, generate_id
from app.domain.resume.content_style import normalize_resume_narrative_punctuation
from app.domain.resume.layout_models import LayoutConstraint
from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.models import (
    Resume,
    ResumeItem,
    ResumeItemCreate,
    ResumeItemPatch,
    ResumePatch,
    ResumeVariant,
    ResumeVariantCreate,
    ResumeVariantPatch,
    ResumeVariantPatchResult,
    ResumeVariantPublicationStatus,
    ResumeVariantQualityStatus,
)
from app.domain.resume.patch import apply_patch_operations
from app.domain.resume.render import render_structured_to_markdown
from app.domain.resume.repository import ResumeRepository


class ResumeService:
    def __init__(
        self,
        repo: ResumeRepository,
        layout: ResumeLayoutService | None = None,
    ) -> None:
        self._repo = repo
        self._layout = layout

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

    async def get_repository_resume(self, user_id: str, resume_id: str) -> Resume:
        """Return only variants that are safe to expose in the resume repository."""
        resume = await self.get_resume(user_id, resume_id)
        published = [
            variant
            for variant in resume.variants
            if variant.publication_status == "published" and variant.gate_status != "failed"
        ]
        if resume.variants and not published:
            raise NotFoundError(f"Resume not found: {resume_id}")
        return resume.model_copy(update={"variants": published})

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

    async def update_resume(self, user_id: str, resume_id: str, patch: ResumePatch) -> Resume:
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

    async def delete_item(self, user_id: str, resume_id: str, item_id: str) -> None:
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

    async def get_acceptable_variant(self, user_id: str, variant_id: str) -> ResumeVariant:
        """Return a user-owned variant only when it passed the persisted quality gate."""
        variant = await self.get_variant(variant_id)
        await self.get_resume(user_id, variant.resume_id)
        if variant.gate_status != "passed" or variant.publication_status == "discarded":
            raise ValidationError(
                "Resume variant has not passed the quality gate",
                code="resume_variant_not_acceptable",
            )
        return variant

    async def update_variant(
        self, user_id: str, variant_id: str, patch: ResumeVariantPatch
    ) -> ResumeVariant:
        variant = await self.get_variant(variant_id)
        await self.get_resume(user_id, variant.resume_id)
        return await self._repo.update_variant(user_id, variant_id, patch)

    async def save_variant_structure(
        self,
        user_id: str,
        variant_id: str,
        structured: dict[str, Any],
        *,
        title: str | None = None,
    ) -> ResumeVariant:
        """Save one canvas revision while keeping structured JSON canonical.

        The Markdown content is always derived here so callers cannot persist a
        structured/content pair that describes two different resumes.
        """
        variant = await self.get_variant(variant_id)
        await self.get_resume(user_id, variant.resume_id)
        canonical = copy.deepcopy(structured)
        content = render_structured_to_markdown(canonical)
        if not content.strip():
            raise ValueError("Resume structure must contain renderable content")
        return await self._repo.save_variant_structure(
            user_id,
            variant_id,
            canonical,
            content,
            title=title,
        )

    async def list_variants(self, resume_id: str) -> list[ResumeVariant]:
        return await self._repo.list_variants(resume_id)

    async def set_variant_quality(
        self,
        user_id: str,
        variant_id: str,
        status: ResumeVariantQualityStatus,
        issues: list[dict[str, Any]],
        *,
        gate_version: str = "browser-layout-gate-v1",
        publication_status: ResumeVariantPublicationStatus | None = None,
    ) -> ResumeVariant:
        return await self._repo.update_variant_quality(
            user_id,
            variant_id,
            status,
            issues,
            gate_version,
            publication_status,
        )

    async def set_variant_publication(
        self,
        user_id: str,
        variant_id: str,
        status: ResumeVariantPublicationStatus,
    ) -> ResumeVariant:
        return await self._repo.update_variant_publication(user_id, variant_id, status)

    async def patch_variant(
        self,
        user_id: str,
        variant_id: str,
        operations: list[dict[str, Any]],
    ) -> ResumeVariantPatchResult:
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
        if self._layout is None:
            raise RuntimeError("Resume layout service is required for structured canvas edits")
        new_structured = apply_patch_operations(variant.structured, operations)
        return await self._persist_structured_revision(variant, new_structured)

    async def replace_variant_structure(
        self,
        user_id: str,
        variant_id: str,
        structured: dict[str, Any],
    ) -> ResumeVariantPatchResult:
        """Persist a full editor snapshot through the same versioned layout gate.

        The editor may replace user-owned resume content, but it cannot change
        the server-owned template/profile contract used by the quality gate.
        """
        variant = await self.get_variant(variant_id)
        await self.get_resume(user_id, variant.resume_id)
        if not variant.structured:
            raise NotFoundError(f"Variant has no structured data: {variant_id}")
        if self._layout is None:
            raise RuntimeError("Resume layout service is required for structured canvas edits")
        canonical = copy.deepcopy(structured)
        for key in (
            "layout_template_id",
            "layout_profile_version",
            "layout_profile_hash",
        ):
            if canonical.get(key) != variant.structured.get(key):
                raise ValueError(f"Resume editor cannot change {key}")
        return await self._persist_structured_revision(variant, canonical)

    async def _persist_structured_revision(
        self,
        variant: ResumeVariant,
        structured: dict[str, Any],
    ) -> ResumeVariantPatchResult:
        if self._layout is None:
            raise RuntimeError("Resume layout service is required for structured canvas edits")
        new_structured = normalize_resume_narrative_punctuation(structured)
        report = self._layout.measure_resume_layout(new_structured, LayoutConstraint())
        usage = report.pages[0].usage_ratio if report.pages else 0.0
        new_structured["layout_usage_ratio"] = usage
        new_structured["layout_target_band"] = {
            "minimum": report.minimum_page_usage_ratio,
            "target": report.target_page_usage_ratio,
            "maximum": report.maximum_page_usage_ratio,
        }
        new_content = render_structured_to_markdown(new_structured)
        if not new_content.strip():
            raise ValueError("Resume structure must contain renderable content")
        persisted = await self._repo.patch_variant_structured(
            variant_id=variant.id,
            structured=new_structured,
            content=new_content,
            parent_variant_id=variant.id,
        )
        return ResumeVariantPatchResult(
            **persisted.model_dump(),
            layout_report=report,
            quality_status="pass" if report.status == "pass" else "needs_revision",
        )
