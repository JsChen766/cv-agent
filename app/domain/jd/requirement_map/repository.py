from __future__ import annotations

from typing import Protocol

from app.domain.jd.requirement_map.models import RequirementMap


class RequirementMapRepository(Protocol):
    async def get_cached(
        self,
        user_id: str,
        jd_hash: str,
        *,
        normalization_version: str,
        schema_version: str,
        parser_version: str,
        parser_model: str,
    ) -> RequirementMap | None: ...

    async def save(self, requirement_map: RequirementMap) -> RequirementMap: ...
