from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field


class RetrievalRequirement(BaseModel):
    requirement_id: str
    description: str
    category: str
    keywords: tuple[str, ...] = ()
    importance: Literal["must_have", "preferred", "optional"]
    weight: float = Field(ge=0.0, le=1.0)


class RetrievalFact(BaseModel):
    fact_id: str
    experience_id: str
    source_revision_id: str
    source_revision_hash: str
    source_text: str
    technologies: tuple[str, ...] = ()
    lexical_tokens: tuple[str, ...] = ()
    strength_score: float = Field(ge=0.0, le=1.0)
    experience_category: str
    experience_title: str
    organization: str | None = None
    role: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    factbank_status: str = "ready"
    embedding: tuple[float, ...] = Field(default=(), exclude=True)


class ExperienceFactBundle(BaseModel):
    experience_id: str
    revision_id: str
    revision_hash: str
    content: str
    title: str
    organization: str | None = None
    role: str | None = None
    category: str
    start_date: date | None = None
    end_date: date | None = None
    tags: tuple[str, ...] = ()
    factbank_status: str
    facts: tuple[RetrievalFact, ...] = ()


class FactScoreBreakdown(BaseModel):
    semantic_similarity: float = Field(ge=0.0, le=1.0)
    lexical_technology_match: float = Field(ge=0.0, le=1.0)
    uncovered_requirement_gain: float = Field(ge=0.0, le=1.0)
    evidence_strength: float = Field(ge=0.0, le=1.0)
    recency: float = Field(ge=0.0, le=1.0)
    weighted_total: float = Field(ge=0.0)


class RankedFact(BaseModel):
    fact_id: str
    experience_id: str
    source_revision_id: str
    source_text: str
    technologies: tuple[str, ...] = ()
    selected: bool
    rank: int | None = None
    score: FactScoreBreakdown
    marginal_value: float
    matched_requirement_ids: tuple[str, ...] = ()
    selection_reasons: tuple[str, ...] = ()
    rejection_reasons: tuple[str, ...] = ()
    degradation_sources: tuple[str, ...] = ()


class RetrievalDiagnostics(BaseModel):
    total_experiences: int = Field(ge=0)
    total_facts: int = Field(ge=0)
    selected_facts: int = Field(ge=0)
    ready_facts: int = Field(ge=0)
    fallback_facts: int = Field(ge=0)
    requirement_embedding_cache_hits: int = Field(default=0, ge=0)
    requirement_embedding_cache_misses: int = Field(default=0, ge=0)
    warnings: tuple[str, ...] = ()
    ranking_version: str


class HybridRetrievalResult(BaseModel):
    requirements: tuple[RetrievalRequirement, ...]
    facts: tuple[RankedFact, ...]
    selected_fact_ids: tuple[str, ...]
    diagnostics: RetrievalDiagnostics
