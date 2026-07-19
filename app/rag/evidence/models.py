from __future__ import annotations

from pydantic import BaseModel, Field


class Claim(BaseModel):
    fact_id: str | None = None
    experience_id: str | None = None
    text: str
    category: str = "achievement"  # "achievement" | "skill" | "responsibility" | "metric"
    is_quantified: bool = False


class ExperienceWithClaims(BaseModel):
    experience_id: str
    revision_id: str | None = None
    title: str
    organization: str | None = None
    role: str | None = None
    category: str = "other"  # "work" | "project" | "education" | "volunteer" | "other"
    start_date: str | None = None  # ISO "YYYY-MM-DD" (from DATE column)
    end_date: str | None = None
    tags: list[str] = Field(default_factory=list)
    content: str
    claims: list[Claim] = Field(default_factory=list)
    claims_indexed: bool = False
    factbank_status: str = "pending"
    relevance_score: float = 0.0


class EvidenceMatch(BaseModel):
    requirement_id: str
    requirement_text: str
    matched_claims: list[Claim]
    match_score: float


class EvidencePack(BaseModel):
    matches: list[EvidenceMatch] = Field(default_factory=list)
    coverage_ratio: float = 0.0  # % of requirements with at least one match
    total_requirements: int = 0
