from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

RequirementCategory = Literal[
    "qualification",
    "responsibility",
    "technology",
    "domain",
    "soft_skill",
]
RequirementImportance = Literal["must_have", "preferred", "optional"]
RequirementMapSource = Literal["parsed", "manual", "legacy"]


class ParsedRequirementDraft(BaseModel):
    description: str
    category: RequirementCategory
    keywords: tuple[str, ...] = ()
    importance: RequirementImportance


class ParsedJdDraft(BaseModel):
    title: str | None = None
    company: str | None = None
    target_role: str | None = None
    requirements: tuple[ParsedRequirementDraft, ...] = ()


class Requirement(ParsedRequirementDraft):
    requirement_id: str
    weight: float = Field(ge=0.0, le=1.0)


class RequirementMap(BaseModel):
    requirement_map_id: str
    user_id: str
    jd_hash: str
    normalization_version: str
    schema_version: str
    parser_version: str
    parser_model: str
    title: str | None = None
    company: str | None = None
    target_role: str | None = None
    requirements: tuple[Requirement, ...] = ()
    source: RequirementMapSource = "parsed"
    created_at: datetime
    updated_at: datetime


class RequirementMapResolution(BaseModel):
    requirement_map: RequirementMap
    cache_hit: bool
    normalized_length: int = Field(ge=0)
    duplicate_count: int = Field(default=0, ge=0)
