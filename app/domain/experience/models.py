from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel

from app.core.types import ExperienceCategory, ExperienceStatus, ImportCandidateStatus, ImportSource


class ExperienceRevision(BaseModel):
    id: str
    experience_id: str
    content: str           # markdown
    source: str            # "manual" | "ai_generated" | "file_import"
    created_at: datetime


class Experience(BaseModel):
    id: str
    user_id: str
    category: ExperienceCategory
    title: str
    organization: str | None = None
    role: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    tags: list[str] = []
    status: ExperienceStatus = "active"
    current_revision_id: str | None = None
    # Populated on demand
    current_revision: ExperienceRevision | None = None
    revisions: list[ExperienceRevision] = []
    created_at: datetime
    updated_at: datetime


class ImportJob(BaseModel):
    id: str
    user_id: str
    source: ImportSource
    status: str  # "processing" | "completed" | "failed"
    file_id: str | None = None
    created_at: datetime
    updated_at: datetime


class ImportCandidate(BaseModel):
    id: str
    import_job_id: str
    user_id: str
    category: ExperienceCategory
    title: str
    organization: str | None = None
    role: str | None = None
    content: str       # markdown
    status: ImportCandidateStatus = "pending"
    created_at: datetime
    updated_at: datetime
