from __future__ import annotations

import json
from collections.abc import Sequence
from hashlib import sha256

from app.core.errors import NotFoundError
from app.core.types import JD_PREFIX, generate_id
from app.domain.jd.models import (
    JdRecord,
    JdRequirement,
    JdRequirementDraft,
    JdRequirementImportance,
    JdRequirementsOrigin,
)
from app.domain.jd.repository import JdRepository
from app.domain.jd.requirement_map.models import Requirement, RequirementMapResolution
from app.domain.jd.requirement_map.service import (
    RequirementMapService,
    compute_jd_hash,
    normalize_jd_text,
)


class JdService:
    def __init__(
        self,
        repo: JdRepository,
        requirement_maps: RequirementMapService | None = None,
    ) -> None:
        self._repo = repo
        self._requirement_maps = requirement_maps

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
        jd_hash: str | None = None,
        requirement_map_id: str | None = None,
        requirements_origin: JdRequirementsOrigin | None = None,
    ) -> JdRecord:
        if requirements is None and self._requirement_maps is not None:
            resolution = await self._requirement_maps.resolve(user_id, raw_text)
            requirement_map = resolution.requirement_map
            title = requirement_map.title or title
            company = requirement_map.company or company
            target_role = requirement_map.target_role or target_role
            requirements = [self._to_legacy_draft(item) for item in requirement_map.requirements]
            jd_hash = requirement_map.jd_hash
            requirement_map_id = requirement_map.requirement_map_id
            requirements_origin = "parsed"
        elif requirements is not None:
            requirements_origin = requirements_origin or "manual"
            current_hash = compute_jd_hash(normalize_jd_text(raw_text))
            if requirements_origin == "parsed" and jd_hash != current_hash:
                requirements_origin = "manual"
            jd_hash = current_hash
        if requirements_origin == "manual":
            requirement_map_id = None
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
            jd_hash=jd_hash,
            requirement_map_id=requirement_map_id,
            requirements_origin=requirements_origin or "legacy",
        )

    async def analyze_raw_text(
        self,
        user_id: str,
        raw_text: str,
    ) -> RequirementMapResolution:
        if self._requirement_maps is None:
            raise RuntimeError("RequirementMap service is unavailable")
        return await self._requirement_maps.resolve(user_id, raw_text)

    async def ensure_requirement_map(self, user_id: str, jd_id: str) -> JdRecord:
        jd = await self.get_jd(user_id, jd_id)
        if jd.requirement_map_id is not None or jd.requirements_origin == "manual":
            return jd
        resolution = await self.analyze_raw_text(user_id, jd.raw_text)
        requirement_map = resolution.requirement_map
        requirements = self._normalize_requirements(
            [self._to_legacy_draft(item) for item in requirement_map.requirements]
        )
        return await self._repo.update_analysis(
            jd.id,
            title=requirement_map.title or jd.title,
            company=requirement_map.company or jd.company,
            target_role=requirement_map.target_role or jd.target_role,
            requirements=requirements,
            jd_hash=requirement_map.jd_hash,
            requirement_map_id=requirement_map.requirement_map_id,
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
        title = raw_text[:60].strip().splitlines()[0] or "Pasted JD"
        return await self.create_jd(
            user_id,
            title=title,
            raw_text=raw_text,
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
                keywords=req.keywords,
                weight=req.weight,
                v2_importance=req.v2_importance,
                v2_category=req.v2_category,
            )
            for req in requirements
        ]

    @staticmethod
    def _to_legacy_draft(requirement: Requirement) -> JdRequirementDraft:
        importance: JdRequirementImportance
        if requirement.importance == "must_have":
            importance = "high"
        elif requirement.importance == "optional":
            importance = "low"
        else:
            importance = "medium"
        category = {
            "qualification": "experience",
            "responsibility": "experience",
            "technology": "skill",
            "domain": "domain",
            "soft_skill": "skill",
        }[requirement.category]
        return JdRequirementDraft(
            id=requirement.requirement_id,
            text=requirement.description,
            category=category,
            importance=importance,
            keywords=requirement.keywords,
            weight=requirement.weight,
            v2_importance=requirement.importance,
            v2_category=requirement.category,
        )


def requirements_fingerprint(requirements: Sequence[object]) -> str:
    normalized: list[object] = []
    for requirement in requirements:
        if hasattr(requirement, "model_dump"):
            value = requirement.model_dump(mode="json")
        else:
            value = requirement
        normalized.append(value)
    payload = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(payload.encode("utf-8")).hexdigest()
