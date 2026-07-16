import hashlib
from pathlib import Path

from app.domain.resume.layout_profile import DEFAULT_RESUME_LAYOUT_PROFILE
from app.infra.layout.font_metrics import PillowFontMetrics


def test_fixed_font_checksum_and_mixed_text_metrics() -> None:
    metrics = PillowFontMetrics()
    profile = DEFAULT_RESUME_LAYOUT_PROFILE

    assert metrics.font_checksum == profile.font.checksum_sha256
    assert hashlib.sha256(Path(metrics.font_path).read_bytes()).hexdigest() == metrics.font_checksum
    assert metrics.text_width_mm("中文 English 123，。", profile.body) > 0
    assert metrics.text_width_mm("WWWW", profile.body) > metrics.text_width_mm("iiii", profile.body)
