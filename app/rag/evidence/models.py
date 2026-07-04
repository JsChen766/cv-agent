from __future__ import annotations

from pydantic import BaseModel


class Claim(BaseModel):
    text: str
    category: str = "achievement"  # "achievement" | "skill" | "responsibility" | "metric"
    is_quantified: bool = False


class ExperienceWithClaims(BaseModel):
    experience_id: str
    title: str
    organization: str | None = None
    content: str
    claims: list[Claim] = []
    relevance_score: float = 0.0


class EvidenceMatch(BaseModel):
    requirement_id: str
    requirement_text: str
    matched_claims: list[Claim]
    match_score: float


class EvidencePack(BaseModel):
    matches: list[EvidenceMatch] = []
    coverage_ratio: float = 0.0   # % of requirements with at least one match
    total_requirements: int = 0
