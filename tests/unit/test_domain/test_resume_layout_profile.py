from app.domain.resume.layout_profile import (
    DEFAULT_RESUME_LAYOUT_PROFILE,
    FONT_CHECKSUM_SHA256,
)


def test_default_profile_is_a4_and_hash_is_stable() -> None:
    profile = DEFAULT_RESUME_LAYOUT_PROFILE

    assert profile.version == "resume-template-v1"
    assert profile.page_width_mm == 210.0
    assert profile.page_height_mm == 297.0
    assert profile.orientation == "portrait"
    assert profile.content_width_mm == 192.0
    assert profile.content_height_mm == 279.0
    assert profile.summary_rendered is False
    assert profile.font.checksum_sha256 == FONT_CHECKSUM_SHA256
    assert profile.profile_hash == profile.with_computed_hash().profile_hash


def test_profile_hash_changes_with_rendering_contract() -> None:
    profile = DEFAULT_RESUME_LAYOUT_PROFILE
    changed = profile.model_copy(update={"padding_left_mm": profile.padding_left_mm + 1})

    assert changed.with_computed_hash().profile_hash != profile.profile_hash
