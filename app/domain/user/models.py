from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.core.types import CareerStage


class User(BaseModel):
    id: str
    email: str
    hashed_password: str
    is_active: bool = True
    created_at: datetime
    updated_at: datetime


class UserProfile(BaseModel):
    user_id: str
    full_name: str | None = None
    email: str | None = None
    phone: str | None = None
    location: str | None = None
    linkedin_url: str | None = None
    github_url: str | None = None
    personal_website: str | None = None
    current_title: str | None = None
    current_company: str | None = None
    years_of_experience: int | None = None
    career_stage: CareerStage | None = None
    target_roles: list[str] = Field(default_factory=list)
    target_industries: list[str] = Field(default_factory=list)
    target_locations: list[str] = Field(default_factory=list)
    preferred_language: str = "zh-CN"  # "zh-CN" | "en-US"
    resume_style: str | None = None  # "concise" | "detailed"
    updated_at: datetime | None = None
