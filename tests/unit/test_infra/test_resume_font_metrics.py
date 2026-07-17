import hashlib
from pathlib import Path

from app.domain.resume.layout_profile import DEFAULT_RESUME_LAYOUT_PROFILE
from app.infra.layout.font_metrics import PillowFontMetrics


def test_fixed_font_checksum_and_mixed_text_metrics() -> None:
    metrics = PillowFontMetrics()
    profile = DEFAULT_RESUME_LAYOUT_PROFILE

    assert metrics.font_checksum == profile.font.checksum_sha256
    assert hashlib.sha256(Path(metrics.font_path).read_bytes()).hexdigest() == metrics.font_checksum
    assert metrics.font_checksums[profile.chinese_font.family] == (
        profile.chinese_font.checksum_sha256
    )
    assert metrics.font_checksums[profile.english_font.family] == (
        profile.english_font.checksum_sha256
    )
    chinese_style = profile.body.model_copy(update={"font_family": profile.chinese_font.family})
    english_style = profile.body.model_copy(update={"font_family": profile.english_font.family})
    assert metrics.text_width_mm("中文简历 123，。", chinese_style) > 0
    assert metrics.text_width_mm("English resume 123", english_style) > 0
    assert metrics.text_width_mm("WWWW", english_style) > metrics.text_width_mm(
        "iiii", english_style
    )
