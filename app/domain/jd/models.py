from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

JdRequirementImportance = Literal["high", "medium", "low"]


class JdRequirement(BaseModel):
    id: str
    text: str
    category: str = "skill"
    importance: JdRequirementImportance = "medium"


class JdRequirementDraft(BaseModel):
    id: str | None = None
    text: str
    category: str = "skill"
    importance: JdRequirementImportance = "medium"


class JdRecord(BaseModel):
    id: str
    user_id: str
    title: str
    company: str | None = None
    target_role: str | None = None
    raw_text: str
    requirements: list[JdRequirement] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
