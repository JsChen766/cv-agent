"""Framework-free contracts for one batched local bullet repair."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

RepairRejectionCode = Literal[
    "no_failing_bullets",
    "duplicate_repair_id",
    "repair_id_mismatch",
    "unknown_bullet",
    "unknown_source_experience",
    "fact_id_not_allowed",
    "grounding_missing",
    "coverage_mismatch",
    "number_not_allowed",
    "terminal_period",
    "layout_not_pass",
    "no_passing_candidate",
]


class BulletRepairCandidate(BaseModel):
    text: str = Field(min_length=1)
    source_fact_ids: list[str] = Field(default_factory=list)
    matched_jd_requirement_ids: list[str] = Field(default_factory=list)


class BulletRepairChoice(BaseModel):
    bullet_id: str = Field(min_length=1)
    candidates: list[BulletRepairCandidate] = Field(min_length=1, max_length=3)


class BulletRepairBatch(BaseModel):
    repairs: list[BulletRepairChoice] = Field(min_length=1)


class BulletRepairCandidateDiagnostic(BaseModel):
    """PII-free validation result for one transient model candidate."""

    bullet_id: str
    candidate_index: int = Field(ge=0)
    rejection_codes: list[RepairRejectionCode] = Field(default_factory=list)
    fit_status: str | None = None
    last_line_ratio: float | None = None
    selected: bool = False


class BulletRepairEvaluation(BaseModel):
    """Atomic repair result plus diagnostics safe to retain in graph state."""

    structure: dict[str, Any] | None = None
    batch_rejection_codes: list[RepairRejectionCode] = Field(default_factory=list)
    candidates: list[BulletRepairCandidateDiagnostic] = Field(default_factory=list)

    @property
    def rejection_codes(self) -> list[RepairRejectionCode]:
        values = list(self.batch_rejection_codes)
        for candidate in self.candidates:
            values.extend(candidate.rejection_codes)
        return list(dict.fromkeys(values))
