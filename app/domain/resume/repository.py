from __future__ import annotations

from typing import Protocol

from app.domain.resume.models import Resume, ResumeItem, ResumeVariant


class ResumeRepository(Protocol):
    async def list(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
    ) -> tuple[list[Resume], str | None]: ...

    async def get(self, user_id: str, resume_id: str) -> Resume | None: ...

    async def create(
        self,
        resume_id: str,
        user_id: str,
        title: str,
        *,
        target_role: str | None = None,
        jd_id: str | None = None,
    ) -> Resume: ...

    async def update(self, user_id: str, resume_id: str, patch: dict) -> Resume: ...

    async def delete(self, user_id: str, resume_id: str) -> None: ...

    # ── Items ─────────────────────────────────────────────────────────────────
    async def add_item(self, item_id: str, resume_id: str, data: dict) -> ResumeItem: ...

    async def update_item(self, item_id: str, patch: dict) -> ResumeItem: ...

    async def delete_item(self, item_id: str) -> None: ...

    async def reorder_items(self, resume_id: str, ordered_ids: list[str]) -> list[ResumeItem]: ...

    # ── Variants ──────────────────────────────────────────────────────────────
    async def add_variant(self, variant_id: str, resume_id: str, data: dict) -> ResumeVariant: ...

    async def get_variant(self, variant_id: str) -> ResumeVariant | None: ...

    async def list_variants(self, resume_id: str) -> list[ResumeVariant]: ...
