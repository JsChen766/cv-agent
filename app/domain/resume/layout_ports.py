"""Ports required by deterministic resume layout measurement."""

from __future__ import annotations

from typing import Protocol

from app.domain.resume.layout_profile import TextStyle


class TextMetricsPort(Protocol):
    """Measure rendered glyph advances for the fixed profile font."""

    @property
    def font_checksum(self) -> str: ...

    def text_width_mm(self, text: str, style: TextStyle) -> float: ...
