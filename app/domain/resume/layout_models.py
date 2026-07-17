"""Pure domain models for resume layout constraints and reports."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

BulletFitStatus = Literal["pass", "too_short", "awkward_wrap", "unfixable_grounded_short"]
LayoutStatus = Literal["pass", "needs_revision", "needs_user_decision", "profile_mismatch"]


class LayoutConstraint(BaseModel):
    max_pages: int | None = Field(default=1, ge=1)
    requested_pages: int | None = Field(default=None, ge=1)
    minimum_page_usage_ratio: float = Field(default=0.80, ge=0.0, le=1.0)
    target_page_usage_ratio: float = Field(default=0.88, ge=0.0, le=1.0)
    maximum_page_usage_ratio: float = Field(default=0.95, ge=0.0, le=1.0)

    def model_post_init(self, __context: object) -> None:
        if not (
            self.minimum_page_usage_ratio
            <= self.target_page_usage_ratio
            <= self.maximum_page_usage_ratio
        ):
            raise ValueError("Page usage ratios must satisfy minimum <= target <= maximum")

    @property
    def is_single_page(self) -> bool:
        """Whether one page is a hard upper bound."""
        return self.max_pages == 1

    @property
    def targets_one_page(self) -> bool:
        """Whether the first page should be filled even when overflow is allowed."""
        return self.is_single_page or self.requested_pages == 1

    @property
    def allows_overflow(self) -> bool:
        return self.max_pages is None


class BulletFitReport(BaseModel):
    bullet_id: str
    section_type: str
    item_id: str
    line_count: int
    line_widths_mm: list[float]
    last_line_width_mm: float
    last_line_ratio: float
    target_ratio: float
    gate_ratio: float
    status: BulletFitStatus
    recommendation: Literal["shorten", "expand_from_source", "rephrase", "remove", "none"]


class BlockLayoutReport(BaseModel):
    block_id: str
    block_type: str
    page_number: int
    start_y_mm: float
    end_y_mm: float
    height_mm: float
    forced_break: bool = False


class PageReport(BaseModel):
    page_number: int
    available_height_mm: float
    used_height_mm: float
    usage_ratio: float
    overflow_mm: float = 0.0
    blocks: list[BlockLayoutReport] = Field(default_factory=list)


class SectionLayoutReport(BaseModel):
    section_id: str
    section_type: str
    start_page: int
    end_page: int
    height_mm: float
    forced_item_break_ids: list[str] = Field(default_factory=list)


class LayoutViolation(BaseModel):
    code: str
    message: str
    severity: Literal["soft", "hard"] = "hard"
    section_id: str | None = None
    item_id: str | None = None
    bullet_id: str | None = None


class LayoutReport(BaseModel):
    profile_version: str
    profile_hash: str
    content_width_mm: float
    page_available_height_mm: float
    page_count: int
    overflow_mm: float
    minimum_page_usage_ratio: float = 0.80
    target_page_usage_ratio: float = 0.88
    maximum_page_usage_ratio: float = 0.95
    underfill_mm: float = 0.0
    pages: list[PageReport] = Field(default_factory=list)
    sections: list[SectionLayoutReport] = Field(default_factory=list)
    bullet_fits: list[BulletFitReport] = Field(default_factory=list)
    violations: list[LayoutViolation] = Field(default_factory=list)
    forced_break_block_ids: list[str] = Field(default_factory=list)
    status: LayoutStatus


class LayoutTuning(BaseModel):
    """Bounded visual expansion applied consistently by backend and browser preview."""

    body_font_scale: float = Field(default=1.0, ge=1.0, le=1.08)
    body_line_height: float = Field(default=1.18, ge=1.18, le=1.28)
    section_gap_scale: float = Field(default=1.0, ge=1.0, le=1.5)
    item_gap_scale: float = Field(default=1.0, ge=1.0, le=1.6)
    bullet_gap_scale: float = Field(default=1.0, ge=1.0, le=1.5)
