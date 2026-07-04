from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class ScoreBreakdown(BaseModel):
    overall: float = 0.0
    relevance: float = 0.0
    clarity: float = 0.0
    evidence_strength: float = 0.0
    quantified_impact: float = 0.0


class EvidenceItem(BaseModel):
    requirement_id: str
    requirement_text: str
    supporting_claims: list[str]
    match_score: float


class RiskItem(BaseModel):
    type: str   # "unverifiable_claim" | "missing_evidence" | "overstatement"
    text: str
    severity: str  # "high" | "medium" | "low"


class ResumeVariant(BaseModel):
    id: str
    resume_id: str
    jd_id: str | None = None
    title: str
    content: str  # full markdown resume text
    score: ScoreBreakdown = ScoreBreakdown()
    evidence_summary: list[EvidenceItem] = []
    risk_summary: list[RiskItem] = []
    missing_info: list[str] = []
    created_at: datetime


class ResumeItem(BaseModel):
    id: str
    resume_id: str
    section_type: str  # "summary" | "experience" | "education" | "skills" | "projects"
    title: str | None = None
    content_snapshot: str  # current text content
    order_index: int = 0
    hidden: bool = False
    pinned: bool = False
    source_experience_id: str | None = None
    source_variant_id: str | None = None
    created_at: datetime
    updated_at: datetime


class Resume(BaseModel):
    id: str
    user_id: str
    title: str
    target_role: str | None = None
    jd_id: str | None = None
    status: str = "draft"  # "draft" | "published"
    items: list[ResumeItem] = []
    variants: list[ResumeVariant] = []
    created_at: datetime
    updated_at: datetime
