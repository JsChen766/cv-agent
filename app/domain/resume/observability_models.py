"""Domain models for resume-generation runs and browser layout observations."""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

RunStatus = Literal["running", "completed", "interrupted", "failed", "cancelled"]
RunTrigger = Literal[
    "chat",
    "chat_stream",
    "product_action",
    "application_package",
    "tier3_edit",
    "interrupt_resume",
    "tool_bypass",
]
ObservationSurface = Literal["preview", "review", "print", "application_package"]


class ResumeGenerationRunStart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    user_id: str
    request_id: str | None = None
    thread_id: str | None = None
    turn_id: str | None = None
    parent_run_id: str | None = None
    trigger: RunTrigger
    trace_version: str
    provider: str | None = None
    model: str | None = None
    started_at: datetime


class ResumeGenerationRunFinish(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    user_id: str
    status: Literal["completed", "interrupted", "failed", "cancelled"]
    resume_id: str | None = None
    variant_id: str | None = None
    provider: str | None = None
    model: str | None = None
    graph_duration_ms: int | None = Field(default=None, ge=0)
    endpoint_duration_ms: int | None = Field(default=None, ge=0)
    llm_logical_calls: int = Field(default=0, ge=0)
    llm_physical_requests: int = Field(default=0, ge=0)
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    payload_hash: str | None = None
    payload_snapshot: object | None = None
    layout_report: object | None = None
    metrics: dict[str, object]
    error_code: str | None = None
    completed_at: datetime


class BrowserViewport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    width_px: float = Field(gt=0)
    height_px: float = Field(gt=0)
    device_pixel_ratio: float = Field(gt=0)


class BrowserBulletMeasurement(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bullet_id: str = Field(min_length=1)
    line_count: int = Field(ge=1)
    last_line_width_px: float = Field(ge=0)
    available_line_width_px: float = Field(gt=0)


class BrowserLayoutObservationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str | None = None
    surface: ObservationSurface
    measurement_version: Literal["browser-layout-observation-v1"]
    profile_version: str = Field(min_length=1)
    profile_hash: str = Field(min_length=1)
    fonts_ready: bool
    loaded_font_families: list[str]
    page_count: int = Field(ge=0)
    overflow_px: float = Field(ge=0)
    used_height_px: float = Field(ge=0)
    available_height_px: float = Field(gt=0)
    viewport: BrowserViewport
    page_metrics: list[dict[str, Any]] = Field(default_factory=list)
    bullets: list[BrowserBulletMeasurement]
    client_build: str = Field(min_length=1)
    observed_at: datetime
    idempotency_key: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def validate_finite_unique_dimensions(self) -> BrowserLayoutObservationInput:
        dimensions = [
            self.overflow_px,
            self.used_height_px,
            self.available_height_px,
            self.viewport.width_px,
            self.viewport.height_px,
            self.viewport.device_pixel_ratio,
            *(bullet.last_line_width_px for bullet in self.bullets),
            *(bullet.available_line_width_px for bullet in self.bullets),
        ]
        if not all(math.isfinite(value) for value in dimensions):
            raise ValueError("layout dimensions must be finite")
        bullet_ids = [bullet.bullet_id for bullet in self.bullets]
        if len(bullet_ids) != len(set(bullet_ids)):
            raise ValueError("bullet IDs must be unique")
        if any(not family.strip() for family in self.loaded_font_families):
            raise ValueError("loaded font family names cannot be blank")
        return self


class BrowserBulletMetric(BaseModel):
    bullet_id: str
    line_count: int
    last_line_width_px: float
    available_line_width_px: float
    last_line_ratio: float


class BrowserLayoutObservationCreate(BaseModel):
    id: str
    run_id: str | None
    user_id: str
    resume_id: str
    variant_id: str
    surface: ObservationSurface
    measurement_version: str
    profile_version: str
    profile_hash: str
    profile_matches: bool
    fonts_ready: bool
    loaded_font_families: list[str]
    page_count: int
    overflow_px: float
    page_usage_ratio: float
    viewport: dict[str, object]
    page_metrics: list[dict[str, Any]]
    bullet_metrics: list[dict[str, object]]
    client_build: str
    observed_at: datetime
    idempotency_key: str


class BrowserLayoutObservationResult(BrowserLayoutObservationCreate):
    created_at: datetime
    created: bool = True


class ResumeGenerationRunRecord(BaseModel):
    id: str
    user_id: str
    thread_id: str | None = None
    turn_id: str | None = None
    trigger: str
    status: str
    variant_id: str | None = None
    metrics: dict[str, object] = Field(default_factory=dict)


class VariantLayoutProfile(BaseModel):
    profile_version: str | None = None
    profile_hash: str | None = None
