from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class JdRequirement(BaseModel):
    id: str
    text: str
    category: str  # "must_have" | "nice_to_have" | "skill" | "experience"
    importance: str  # "high" | "medium" | "low"


class JdRecord(BaseModel):
    id: str
    user_id: str
    title: str
    company: str | None = None
    target_role: str | None = None
    raw_text: str
    requirements: list[JdRequirement] = []
    created_at: datetime
    updated_at: datetime
