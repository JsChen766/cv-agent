from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, Field

from app.core.types import (
    ExperienceCategory,
    ExperienceStatus,
    ImportCandidateStatus,
    ImportJobStatus,
    ImportSource,
)
from app.domain.resume.factbank.models import FactBankStatus


class ExperienceRevision(BaseModel):
    id: str
    experience_id: str
    content: str  # markdown
    source: str  # "manual" | "ai_generated" | "file_import"
    revision_hash: str | None = None
    factbank_status: FactBankStatus = "pending"
    created_at: datetime


class Experience(BaseModel):
    id: str
    user_id: str
    category: ExperienceCategory
    title: str
    organization: str | None = None
    role: str | None = None
    location: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    tags: list[str] = Field(default_factory=list)
    status: ExperienceStatus = "active"
    current_revision_id: str | None = None
    # Populated on demand
    current_revision: ExperienceRevision | None = None
    revisions: list[ExperienceRevision] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class ImportJob(BaseModel):
    id: str
    user_id: str
    source: ImportSource
    status: ImportJobStatus
    file_id: str | None = None
    created_at: datetime
    updated_at: datetime


class ExperiencePatch(BaseModel):
    title: str | None = None
    organization: str | None = None
    role: str | None = None
    location: str | None = None
    category: ExperienceCategory | None = None
    start_date: date | str | None = None
    end_date: date | str | None = None
    tags: list[str] | None = None
    current_revision_id: str | None = None


class ImportCandidateDraft(BaseModel):
    category: ExperienceCategory
    title: str
    content: str
    organization: str | None = None
    role: str | None = None
    location: str | None = None


class ImportCandidateCreate(ImportCandidateDraft):
    id: str
    import_job_id: str
    user_id: str


class ImportCandidate(BaseModel):
    id: str
    import_job_id: str
    user_id: str
    category: ExperienceCategory
    title: str
    organization: str | None = None
    role: str | None = None
    location: str | None = None
    content: str  # markdown
    status: ImportCandidateStatus = "pending"
    created_at: datetime
    updated_at: datetime
