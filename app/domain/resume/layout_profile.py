"""Versioned resume layout contract shared by generation and preview code."""

from __future__ import annotations

import hashlib
import json

from pydantic import BaseModel, Field


class FontAsset(BaseModel):
    family: str
    file_id: str
    checksum_sha256: str


class TextStyle(BaseModel):
    font_size_pt: float
    font_weight: int = 400
    line_height: float = 1.2
    italic: bool = False
    font_family: str | None = None

    @property
    def line_height_mm(self) -> float:
        return self.font_size_pt * self.line_height * 25.4 / 72.0


class ResumeSpacing(BaseModel):
    header_after_mm: float = 1.2
    section_before_mm: float = 1.2
    section_after_mm: float = 0.7
    item_after_mm: float = 0.45
    raw_text_before_mm: float = 0.25
    bullet_before_mm: float = 0.2
    bullet_after_mm: float = 0.0
    heading_border_mm: float = 0.25


class BulletLayout(BaseModel):
    marker_width_mm: float = 2.0
    indent_mm: float = 0.3
    gap_mm: float = 1.5
    target_ratio: float = 0.667
    gate_ratio: float = 0.667


class BlockPaginationRules(BaseModel):
    keep_section_heading_with_first_item: bool = True
    avoid_item_break_inside: bool = True
    orphans: int = 2
    widows: int = 2


class ResumeLayoutProfile(BaseModel):
    version: str = "resume-template-v2"
    page_width_mm: float = 210.0
    page_height_mm: float = 297.0
    orientation: str = "portrait"
    padding_top_mm: float = 9.0
    padding_right_mm: float = 9.0
    padding_bottom_mm: float = 9.0
    padding_left_mm: float = 9.0
    # Kept for legacy preview/measurement compatibility.
    font: FontAsset
    chinese_font: FontAsset
    english_font: FontAsset
    body: TextStyle = Field(default_factory=lambda: TextStyle(font_size_pt=9.75, line_height=1.18))
    name: TextStyle = Field(
        default_factory=lambda: TextStyle(font_size_pt=17.0, font_weight=700, line_height=1.12)
    )
    contact: TextStyle = Field(
        default_factory=lambda: TextStyle(font_size_pt=9.0, line_height=1.15)
    )
    section_heading: TextStyle = Field(
        default_factory=lambda: TextStyle(font_size_pt=11.5, font_weight=700, line_height=1.08)
    )
    item_heading: TextStyle = Field(
        default_factory=lambda: TextStyle(font_size_pt=9.75, font_weight=700, line_height=1.18)
    )
    item_subheading: TextStyle = Field(
        default_factory=lambda: TextStyle(font_size_pt=9.5, italic=True, line_height=1.18)
    )
    date: TextStyle = Field(default_factory=lambda: TextStyle(font_size_pt=9.5, line_height=1.18))
    spacing: ResumeSpacing = Field(default_factory=ResumeSpacing)
    bullet: BulletLayout = Field(default_factory=BulletLayout)
    pagination: BlockPaginationRules = Field(default_factory=BlockPaginationRules)
    summary_rendered: bool = False
    allowed_inline_formats: tuple[str, ...] = ("strong", "emphasis", "link")
    profile_hash: str = ""

    @property
    def content_width_mm(self) -> float:
        return self.page_width_mm - self.padding_left_mm - self.padding_right_mm

    @property
    def content_height_mm(self) -> float:
        return self.page_height_mm - self.padding_top_mm - self.padding_bottom_mm

    def font_for_language(self, language: str | None) -> FontAsset:
        normalized = (language or "zh-CN").lower()
        return self.chinese_font if normalized.startswith("zh") else self.english_font

    def with_computed_hash(self) -> ResumeLayoutProfile:
        payload = self.model_dump(exclude={"profile_hash"}, exclude_computed_fields=True)
        digest = hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        return self.model_copy(update={"profile_hash": digest})


FONT_CHECKSUM_SHA256 = "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b"
SIMSUN_CHECKSUM_SHA256 = "120a51d2b14eb588700a21e15fc301f0ea55d7c1a4e1f3ae61db83b7c8d42cd6"
TIMES_NEW_ROMAN_CHECKSUM_SHA256 = (
    "2cff2a03d8034801979dd6d16f09b9a825c3d710fcf068f2ebfbf0e1425c87cf"
)

DEFAULT_RESUME_LAYOUT_PROFILE = ResumeLayoutProfile(
    font=FontAsset(
        family="CV Noto Sans CJK SC",
        file_id="NotoSansCJKsc-Regular.otf",
        checksum_sha256=FONT_CHECKSUM_SHA256,
    ),
    chinese_font=FontAsset(
        family="SimSun",
        file_id="simsun.ttc",
        checksum_sha256=SIMSUN_CHECKSUM_SHA256,
    ),
    english_font=FontAsset(
        family="Times New Roman",
        file_id="times.ttf",
        checksum_sha256=TIMES_NEW_ROMAN_CHECKSUM_SHA256,
    ),
).with_computed_hash()
