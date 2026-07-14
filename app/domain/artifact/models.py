from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.core.types import ArtifactType


class Artifact(BaseModel):
    id: str
    user_id: str
    type: ArtifactType
    title: str
    content: str  # markdown, derived from `structured` when present
    structured: dict | None = None  # type-specific structured JSON (canvas source of truth)
    thread_id: str | None = None
    source_jd_id: str | None = None
    source_experience_ids: list[str] = Field(default_factory=list)
    word_count: int = 0
    created_at: datetime
    updated_at: datetime
