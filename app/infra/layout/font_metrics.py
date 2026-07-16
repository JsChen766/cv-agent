"""Fixed-font glyph advance measurement using FreeType through Pillow."""

from __future__ import annotations

import hashlib
from functools import lru_cache
from pathlib import Path

from PIL import ImageFont

from app.domain.resume.layout_profile import TextStyle

_FONT_PATH = Path(__file__).with_name("fonts") / "NotoSansCJKsc-Regular.otf"


class PillowFontMetrics:
    def __init__(self, font_path: Path = _FONT_PATH) -> None:
        self.font_path = font_path
        self._font_checksum = hashlib.sha256(font_path.read_bytes()).hexdigest()

    @property
    def font_checksum(self) -> str:
        return self._font_checksum

    def text_width_mm(self, text: str, style: TextStyle) -> float:
        if not text:
            return 0.0
        font = self._font(str(self.font_path), style.font_size_pt)
        width_px = font.getlength(text)
        # Load at 96 CSS pixels per inch so conversion is stable and matches browsers.
        return float(width_px) * 25.4 / 96.0

    @staticmethod
    @lru_cache(maxsize=32)
    def _font(font_path: str, size_pt: float) -> ImageFont.FreeTypeFont:
        px_size = max(1, round(size_pt * 96.0 / 72.0))
        return ImageFont.truetype(font_path, size=px_size)
