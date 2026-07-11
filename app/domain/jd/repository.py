from __future__ import annotations

import builtins
from typing import Protocol

from app.domain.jd.models import JdRecord, JdRequirement


class JdRepository(Protocol):
    async def list(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
    ) -> tuple[builtins.list[JdRecord], str | None]: ...

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
        requirements: builtins.list[JdRequirement] | None = None,
        source_thread_id: str | None = None,
    ) -> JdRecord: ...

    async def update_requirements(
        self, jd_id: str, requirements: builtins.list[JdRequirement]
    ) -> JdRecord: ...

    async def delete(self, user_id: str, jd_id: str) -> None: ...
