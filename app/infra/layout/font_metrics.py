"""Fixed-font glyph advance measurement using FreeType through Pillow."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path

from PIL import ImageFont

from app.domain.resume.layout_profile import TextStyle

_FONT_DIR = Path(__file__).with_name("fonts")
_FONT_PATH = _FONT_DIR / "NotoSansCJKsc-Regular.otf"
_DEFAULT_FONT_PATHS = {
    "SimSun": _FONT_DIR / "simsun.ttc",
    "Times New Roman": _FONT_DIR / "times.ttf",
}


class PillowFontMetrics:
    def __init__(
        self,
        font_path: Path = _FONT_PATH,
        font_paths: Mapping[str, Path] | None = None,
    ) -> None:
        self.font_path = font_path
        self._font_checksum = hashlib.sha256(font_path.read_bytes()).hexdigest()
        configured = dict(_DEFAULT_FONT_PATHS)
        if font_paths is not None:
            configured.update(font_paths)
        self._font_paths = {
            "CV Noto Sans CJK SC": font_path,
            **configured,
        }
        missing_fonts = [
            f"{family}: {path}"
            for family, path in self._font_paths.items()
            if not path.is_file()
        ]
        if missing_fonts:
            raise FileNotFoundError(
                "Resume layout font assets are missing: " + ", ".join(missing_fonts)
            )
        self._font_checksums = {
            family: hashlib.sha256(path.read_bytes()).hexdigest()
            for family, path in self._font_paths.items()
        }

    @property
    def font_checksum(self) -> str:
        return self._font_checksum

    @property
    def font_checksums(self) -> dict[str, str]:
        return dict(self._font_checksums)

    def font_path_for_family(self, family: str) -> Path:
        return self._font_paths.get(family, self.font_path)

    def text_width_mm(self, text: str, style: TextStyle) -> float:
        if not text:
            return 0.0
        font_path = self.font_path_for_family(style.font_family or "CV Noto Sans CJK SC")
        font = self._font(str(font_path), style.font_size_pt)
        width_px = font.getlength(text)
        # Load at 96 CSS pixels per inch so conversion is stable and matches browsers.
        return float(width_px) * 25.4 / 96.0

    @staticmethod
    @lru_cache(maxsize=32)
    def _font(font_path: str, size_pt: float) -> ImageFont.FreeTypeFont:
        px_size = max(1, round(size_pt * 96.0 / 72.0))
        return ImageFont.truetype(font_path, size=px_size)
