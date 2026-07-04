from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.core.types import ArtifactType


class Artifact(BaseModel):
    id: str
    user_id: str
    type: ArtifactType
    title: str
    content: str  # markdown
    source_jd_id: str | None = None
    source_experience_ids: list[str] = []
    word_count: int = 0
    created_at: datetime
    updated_at: datetime
