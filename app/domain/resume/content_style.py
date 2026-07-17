"""Deterministic prose-style rules for structured resumes."""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from typing import Any

_TRAILING_SENTENCE_PERIOD = re.compile(r"[。．.]+(?P<closers>[\"'”’」』】）》)]*)\s*$")


@dataclass(frozen=True)
class TerminalPeriodViolation:
    field: str
    item_id: str
    bullet_id: str | None = None


def strip_terminal_sentence_period(text: str) -> str:
    """Remove sentence-ending full stops while preserving internal dots.

    Email addresses, URLs, decimal values, and version numbers are unaffected
    unless the prose adds a separate full stop after them.
    """
    stripped = text.rstrip()
    return _TRAILING_SENTENCE_PERIOD.sub(lambda match: match.group("closers"), stripped)


def normalize_resume_narrative_punctuation(
    structured: dict[str, Any],
) -> dict[str, Any]:
    """Return a copy whose narrative fields do not end in sentence periods."""
    result = copy.deepcopy(structured)
    for section in result.get("sections") or []:
        if not isinstance(section, dict):
            continue
        for item in section.get("items") or []:
            if not isinstance(item, dict):
                continue
            raw_text = item.get("raw_text")
            if isinstance(raw_text, str):
                item["raw_text"] = strip_terminal_sentence_period(raw_text)
            for bullet in item.get("bullets") or []:
                if not isinstance(bullet, dict):
                    continue
                text = bullet.get("text")
                if isinstance(text, str):
                    bullet["text"] = strip_terminal_sentence_period(text)
    return result


def find_terminal_period_violations(
    structured: dict[str, Any],
) -> list[TerminalPeriodViolation]:
    """Find narrative fields that still end in a sentence full stop."""
    violations: list[TerminalPeriodViolation] = []
    for section_index, section in enumerate(structured.get("sections") or []):
        if not isinstance(section, dict):
            continue
        section_id = str(section.get("id") or f"section-{section_index}")
        for item_index, item in enumerate(section.get("items") or []):
            if not isinstance(item, dict):
                continue
            item_id = str(item.get("id") or f"{section_id}:item-{item_index}")
            raw_text = item.get("raw_text")
            if isinstance(raw_text, str) and strip_terminal_sentence_period(raw_text) != raw_text:
                violations.append(TerminalPeriodViolation(field="raw_text", item_id=item_id))
            for bullet_index, bullet in enumerate(item.get("bullets") or []):
                if not isinstance(bullet, dict):
                    continue
                text = bullet.get("text")
                if isinstance(text, str) and strip_terminal_sentence_period(text) != text:
                    violations.append(
                        TerminalPeriodViolation(
                            field="bullet",
                            item_id=item_id,
                            bullet_id=str(bullet.get("id") or f"{item_id}:bullet-{bullet_index}"),
                        )
                    )
    return violations
