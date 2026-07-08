from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ResumeStatus = Literal["draft", "active", "published", "archived"]
ResumeSectionType = Literal["summary", "experience", "education", "skills", "projects", "other"]


class ScoreBreakdown(BaseModel):
    overall: float = 0.0
    relevance: float = 0.0
    clarity: float = 0.0
    evidence_strength: float = 0.0
    quantified_impact: float = 0.0


class EvidenceItem(BaseModel):
    requirement_id: str
    requirement_text: str
    supporting_claims: list[str] = Field(default_factory=list)
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
    score: ScoreBreakdown = Field(default_factory=ScoreBreakdown)
    evidence_summary: list[EvidenceItem] = Field(default_factory=list)
    risk_summary: list[RiskItem] = Field(default_factory=list)
    missing_info: list[str] = Field(default_factory=list)
    created_at: datetime


class ResumeItem(BaseModel):
    id: str
    resume_id: str
    section_type: ResumeSectionType
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
    status: ResumeStatus = "draft"
    items: list[ResumeItem] = Field(default_factory=list)
    variants: list[ResumeVariant] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class ResumePatch(BaseModel):
    title: str | None = None
    target_role: str | None = None
    jd_id: str | None = None
    status: ResumeStatus | None = None


class ResumeItemCreate(BaseModel):
    section_type: ResumeSectionType
    title: str | None = None
    content_snapshot: str = ""
    order_index: int = 0
    source_experience_id: str | None = None
    source_variant_id: str | None = None


class ResumeItemPatch(BaseModel):
    title: str | None = None
    content_snapshot: str | None = None
    order_index: int | None = None
    hidden: bool | None = None
    pinned: bool | None = None

    @property
    def has_changes(self) -> bool:
        return bool(self.model_dump(exclude_none=True))


class ResumeVariantCreate(BaseModel):
    jd_id: str | None = None
    title: str = "Variant"
    content: str = ""
    score: ScoreBreakdown = Field(default_factory=ScoreBreakdown)
    evidence_summary: list[EvidenceItem] = Field(default_factory=list)
    risk_summary: list[RiskItem] = Field(default_factory=list)
    missing_info: list[str] = Field(default_factory=list)
