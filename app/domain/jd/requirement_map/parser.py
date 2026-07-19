from __future__ import annotations

from typing import Protocol

from app.domain.jd.requirement_map.models import ParsedJdDraft


class RequirementMapParser(Protocol):
    async def parse(self, normalized_jd_text: str) -> ParsedJdDraft: ...
