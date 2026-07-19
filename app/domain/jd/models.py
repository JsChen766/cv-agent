from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

JdRequirementImportance = Literal["high", "medium", "low"]
JdRequirementsOrigin = Literal["parsed", "manual", "legacy"]


class JdRequirement(BaseModel):
    id: str
    text: str
    category: str = "skill"
    importance: JdRequirementImportance = "medium"
    keywords: tuple[str, ...] = ()
    weight: float | None = Field(default=None, ge=0.0, le=1.0)
    v2_importance: Literal["must_have", "preferred", "optional"] | None = None


class JdRequirementDraft(BaseModel):
    id: str | None = None
    text: str
    category: str = "skill"
    importance: JdRequirementImportance = "medium"
    keywords: tuple[str, ...] = ()
    weight: float | None = Field(default=None, ge=0.0, le=1.0)
    v2_importance: Literal["must_have", "preferred", "optional"] | None = None


class JdRecord(BaseModel):
    id: str
    user_id: str
    title: str
    company: str | None = None
    target_role: str | None = None
    raw_text: str
    requirements: list[JdRequirement] = Field(default_factory=list)
    jd_hash: str | None = None
    requirement_map_id: str | None = None
    requirements_origin: JdRequirementsOrigin = "legacy"
    source_thread_id: str | None = None
    created_at: datetime
    updated_at: datetime
