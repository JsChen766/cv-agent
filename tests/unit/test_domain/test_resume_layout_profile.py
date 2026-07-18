from app.domain.resume.layout_profile import (
    DEFAULT_RESUME_LAYOUT_PROFILE,
    FONT_CHECKSUM_SHA256,
    SIMSUN_CHECKSUM_SHA256,
    TIMES_NEW_ROMAN_CHECKSUM_SHA256,
)
from app.domain.resume.layout_templates import (
    SPARSE_RESUME_LAYOUT_PROFILE,
    SPARSE_RESUME_TEMPLATE,
    SPARSE_TEMPLATE_ID,
    STANDARD_TEMPLATE_ID,
    get_resume_template,
    select_resume_template,
)


def test_default_profile_is_a4_and_hash_is_stable() -> None:
    profile = DEFAULT_RESUME_LAYOUT_PROFILE

    assert profile.version == "resume-template-v2"
    assert profile.page_width_mm == 210.0
    assert profile.page_height_mm == 297.0
    assert profile.orientation == "portrait"
    assert profile.content_width_mm == 192.0
    assert profile.content_height_mm == 279.0
    assert profile.summary_rendered is False
    assert profile.font.checksum_sha256 == FONT_CHECKSUM_SHA256
    assert profile.chinese_font.family == "SimSun"
    assert profile.chinese_font.checksum_sha256 == SIMSUN_CHECKSUM_SHA256
    assert profile.english_font.family == "Times New Roman"
    assert profile.english_font.checksum_sha256 == TIMES_NEW_ROMAN_CHECKSUM_SHA256
    assert profile.font_for_language("zh-CN") == profile.chinese_font
    assert profile.font_for_language("en-US") == profile.english_font
    assert profile.profile_hash == profile.with_computed_hash().profile_hash


def test_profile_hash_changes_with_rendering_contract() -> None:
    profile = DEFAULT_RESUME_LAYOUT_PROFILE
    changed = profile.model_copy(update={"padding_left_mm": profile.padding_left_mm + 1})

    assert changed.with_computed_hash().profile_hash != profile.profile_hash


def test_sparse_template_has_a_distinct_readable_profile_and_density_band() -> None:
    profile = SPARSE_RESUME_LAYOUT_PROFILE

    assert profile.version == "resume-sparse-v1"
    assert profile.profile_hash != DEFAULT_RESUME_LAYOUT_PROFILE.profile_hash
    assert profile.body.font_size_pt > DEFAULT_RESUME_LAYOUT_PROFILE.body.font_size_pt
    assert profile.section_heading.font_size_pt > (
        DEFAULT_RESUME_LAYOUT_PROFILE.section_heading.font_size_pt
    )
    assert SPARSE_RESUME_TEMPLATE.minimum_page_usage_ratio == 0.52
    assert get_resume_template(SPARSE_TEMPLATE_ID) is SPARSE_RESUME_TEMPLATE
    assert get_resume_template("unknown").template_id == STANDARD_TEMPLATE_ID


def test_sparse_template_selection_is_deterministic_and_manifest_is_frontend_ready() -> None:
    assert select_resume_template(0.719).template_id == SPARSE_TEMPLATE_ID
    assert select_resume_template(0.72).template_id == STANDARD_TEMPLATE_ID

    manifest = SPARSE_RESUME_TEMPLATE.frontend_manifest()
    assert manifest["profile_hash"] == SPARSE_RESUME_LAYOUT_PROFILE.profile_hash
    assert manifest["page"] == {
        "width_mm": 210.0,
        "height_mm": 297.0,
        "orientation": "portrait",
    }
    assert manifest["density"] == {"minimum": 0.52, "target": 0.68, "maximum": 0.9}
