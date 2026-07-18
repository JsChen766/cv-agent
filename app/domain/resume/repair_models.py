"""Framework-free contracts for one batched local bullet repair."""

from __future__ import annotations

from pydantic import BaseModel, Field


class BulletRepairCandidate(BaseModel):
    text: str = Field(min_length=1)
    source_fact_ids: list[str] = Field(default_factory=list)
    matched_jd_requirement_ids: list[str] = Field(default_factory=list)


class BulletRepairChoice(BaseModel):
    bullet_id: str = Field(min_length=1)
    candidates: list[BulletRepairCandidate] = Field(min_length=1, max_length=3)


class BulletRepairBatch(BaseModel):
    repairs: list[BulletRepairChoice] = Field(min_length=1)
