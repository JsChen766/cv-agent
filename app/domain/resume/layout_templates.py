"""Versioned resume template registry and deterministic density selection."""

from __future__ import annotations

from dataclasses import dataclass

from app.domain.resume.layout_profile import (
    DEFAULT_RESUME_LAYOUT_PROFILE,
    ResumeLayoutProfile,
    ResumeSpacing,
    TextStyle,
)

STANDARD_TEMPLATE_ID = "resume-standard"
SPARSE_TEMPLATE_ID = "resume-sparse"


@dataclass(frozen=True)
class ResumeTemplateDefinition:
    template_id: str
    profile: ResumeLayoutProfile
    minimum_page_usage_ratio: float
    target_page_usage_ratio: float
    maximum_page_usage_ratio: float
    select_when_standard_usage_below: float | None = None

    def frontend_manifest(self) -> dict[str, object]:
        return {
            "template_id": self.template_id,
            "profile_version": self.profile.version,
            "profile_hash": self.profile.profile_hash,
            "page": {
                "width_mm": self.profile.page_width_mm,
                "height_mm": self.profile.page_height_mm,
                "orientation": self.profile.orientation,
            },
            "padding_mm": {
                "top": self.profile.padding_top_mm,
                "right": self.profile.padding_right_mm,
                "bottom": self.profile.padding_bottom_mm,
                "left": self.profile.padding_left_mm,
            },
            "content": {
                "width_mm": self.profile.content_width_mm,
                "height_mm": self.profile.content_height_mm,
            },
            "fonts": {
                "chinese": self.profile.chinese_font.model_dump(),
                "english": self.profile.english_font.model_dump(),
            },
            "styles": {
                "body": self.profile.body.model_dump(exclude={"font_family"}),
                "name": self.profile.name.model_dump(exclude={"font_family"}),
                "contact": self.profile.contact.model_dump(exclude={"font_family"}),
                "section_heading": self.profile.section_heading.model_dump(
                    exclude={"font_family"}
                ),
                "item_heading": self.profile.item_heading.model_dump(exclude={"font_family"}),
                "item_subheading": self.profile.item_subheading.model_dump(
                    exclude={"font_family"}
                ),
                "date": self.profile.date.model_dump(exclude={"font_family"}),
            },
            "spacing_mm": self.profile.spacing.model_dump(),
            "bullet": self.profile.bullet.model_dump(),
            "pagination": self.profile.pagination.model_dump(),
            "density": {
                "minimum": self.minimum_page_usage_ratio,
                "target": self.target_page_usage_ratio,
                "maximum": self.maximum_page_usage_ratio,
            },
        }


SPARSE_RESUME_LAYOUT_PROFILE = DEFAULT_RESUME_LAYOUT_PROFILE.model_copy(
    update={
        "version": "resume-sparse-v1",
        "padding_top_mm": 14.0,
        "padding_right_mm": 14.0,
        "padding_bottom_mm": 14.0,
        "padding_left_mm": 14.0,
        "body": TextStyle(font_size_pt=11.25, line_height=1.25),
        "name": TextStyle(font_size_pt=21.0, font_weight=700, line_height=1.15),
        "contact": TextStyle(font_size_pt=10.5, line_height=1.22),
        "section_heading": TextStyle(font_size_pt=13.5, font_weight=700, line_height=1.15),
        "item_heading": TextStyle(font_size_pt=11.25, font_weight=700, line_height=1.25),
        "item_subheading": TextStyle(font_size_pt=10.75, italic=True, line_height=1.25),
        "date": TextStyle(font_size_pt=10.75, font_weight=700, line_height=1.25),
        "spacing": ResumeSpacing(
            header_after_mm=3.0,
            section_before_mm=3.5,
            section_after_mm=1.8,
            item_after_mm=2.0,
            raw_text_before_mm=0.8,
            bullet_before_mm=0.9,
            bullet_after_mm=0.35,
            heading_border_mm=0.45,
        ),
    }
).with_computed_hash()

STANDARD_RESUME_TEMPLATE = ResumeTemplateDefinition(
    template_id=STANDARD_TEMPLATE_ID,
    profile=DEFAULT_RESUME_LAYOUT_PROFILE,
    minimum_page_usage_ratio=0.80,
    target_page_usage_ratio=0.88,
    maximum_page_usage_ratio=0.95,
)

SPARSE_RESUME_TEMPLATE = ResumeTemplateDefinition(
    template_id=SPARSE_TEMPLATE_ID,
    profile=SPARSE_RESUME_LAYOUT_PROFILE,
    minimum_page_usage_ratio=0.52,
    target_page_usage_ratio=0.68,
    maximum_page_usage_ratio=0.90,
    select_when_standard_usage_below=0.72,
)

RESUME_TEMPLATE_REGISTRY = {
    STANDARD_TEMPLATE_ID: STANDARD_RESUME_TEMPLATE,
    SPARSE_TEMPLATE_ID: SPARSE_RESUME_TEMPLATE,
}


def get_resume_template(template_id: object) -> ResumeTemplateDefinition:
    if isinstance(template_id, str):
        template = RESUME_TEMPLATE_REGISTRY.get(template_id)
        if template is not None:
            return template
    return STANDARD_RESUME_TEMPLATE


def select_resume_template(maximum_standard_usage_ratio: float) -> ResumeTemplateDefinition:
    threshold = SPARSE_RESUME_TEMPLATE.select_when_standard_usage_below
    if threshold is not None and maximum_standard_usage_ratio < threshold:
        return SPARSE_RESUME_TEMPLATE
    return STANDARD_RESUME_TEMPLATE
