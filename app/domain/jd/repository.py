from __future__ import annotations

from typing import Protocol

from app.domain.jd.models import JdRecord


class JdRepository(Protocol):
    async def list(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
    ) -> tuple[list[JdRecord], str | None]: ...

    async def get(self, user_id: str, jd_id: str) -> JdRecord | None: ...

    async def create(
        self,
        jd_id: str,
        user_id: str,
        title: str,
        raw_text: str,
        *,
        company: str | None = None,
        target_role: str | None = None,
        requirements: list[dict] | None = None,
    ) -> JdRecord: ...

    async def update_requirements(
        self, jd_id: str, requirements: list[dict]
    ) -> JdRecord: ...

    async def delete(self, user_id: str, jd_id: str) -> None: ...
