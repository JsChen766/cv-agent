from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

FactBankStatus = Literal[
    "pending",
    "extracting",
    "indexing",
    "retry",
    "ready",
    "failed",
]
FactBankMode = Literal["extracted", "reused", "deterministic_fallback"]


class FactDraft(BaseModel):
    """Provider-neutral atomic fact extracted from one revision."""

    action: str | None = None
    object: str | None = None
    method: str | None = None
    technologies: tuple[str, ...] = ()
    scope: str | None = None
    constraint: str | None = None
    result: str | None = None
    metrics: tuple[str, ...] = ()
    time_range: str | None = None
    source_text: str


class FactRecord(FactDraft):
    fact_id: str
    experience_id: str
    source_revision_id: str
    source_revision_hash: str
    source_start: int = Field(ge=0)
    source_end: int = Field(ge=0)
    strength_score: float = Field(ge=0.0, le=1.0)
    lexical_tokens: tuple[str, ...] = ()
    embedding_ref: str | None = None


class FactBankRevisionTask(BaseModel):
    revision_id: str
    experience_id: str
    user_id: str
    content: str
    revision_hash: str
    status: FactBankStatus
    mode: FactBankMode | None = None
    worker_id: str | None = None
    built_schema_version: str | None = None
    built_extractor_version: str | None = None
    built_embedding_model: str | None = None
    attempt_count: int = Field(default=0, ge=0)


class ReusableFactBank(BaseModel):
    facts: tuple[FactRecord, ...]
    fact_embeddings: tuple[tuple[float, ...], ...]
    content_embedding: tuple[float, ...]


class FactBankBuildResult(BaseModel):
    revision_id: str
    fact_count: int = Field(ge=0)
    mode: FactBankMode
    completed_at: datetime
