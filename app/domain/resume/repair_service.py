"""Deterministic validation and selection for local bullet repair candidates."""

from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from app.domain.resume.layout_models import LayoutReport
from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.repair_models import BulletRepairBatch, BulletRepairCandidate

_NUMBER = re.compile(r"(?<!\w)\d+(?:[.,]\d+)?%?")


@dataclass(frozen=True)
class _BulletLocation:
    section_type: str
    item_id: str
    source_experience_id: str
    bullet: dict[str, Any]


class ResumeBulletRepairService:
    def __init__(self, layout: ResumeLayoutService) -> None:
        self._layout = layout

    def apply_batch(
        self,
        structured: dict[str, Any],
        report: LayoutReport,
        batch: BulletRepairBatch,
        *,
        experiences: list[dict[str, Any]],
        content_budget: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        failing_ids = {
            fit.bullet_id
            for fit in report.bullet_fits
            if fit.status in {"too_short", "awkward_wrap"}
        }
        if not failing_ids:
            return None
        repair_ids = [repair.bullet_id for repair in batch.repairs]
        if len(repair_ids) != len(set(repair_ids)) or set(repair_ids) != failing_ids:
            return None

        candidate = deepcopy(structured)
        locations = _bullet_locations(candidate)
        sources = {
            str(experience.get("id")): experience
            for experience in experiences
            if experience.get("id")
        }
        allowed_facts = _allowed_fact_ids(content_budget or {})
        language = str(candidate.get("language") or "zh-CN")

        for repair in batch.repairs:
            location = locations.get(repair.bullet_id)
            if location is None:
                return None
            source = sources.get(location.source_experience_id)
            if source is None:
                return None
            current_fact_ids = {
                str(value) for value in location.bullet.get("source_fact_ids") or [] if value
            }
            source_fact_ids = allowed_facts.get(location.source_experience_id, set())
            permitted_fact_ids = current_fact_ids | source_fact_ids
            current_requirement_ids = {
                str(value)
                for value in location.bullet.get("matched_jd_requirement_ids") or []
                if value
            }
            allowed_numbers = set(_NUMBER.findall(_source_blob(source)))
            selected = self._select_candidate(
                repair.candidates,
                bullet_id=repair.bullet_id,
                location=location,
                language=language,
                permitted_fact_ids=permitted_fact_ids,
                required_requirement_ids=current_requirement_ids,
                allowed_numbers=allowed_numbers,
            )
            if selected is None:
                return None
            location.bullet["text"] = selected.text.strip().rstrip("。.")
            location.bullet["source_fact_ids"] = list(dict.fromkeys(selected.source_fact_ids))
            location.bullet["matched_jd_requirement_ids"] = list(
                dict.fromkeys(selected.matched_jd_requirement_ids)
            )
        return candidate

    def _select_candidate(
        self,
        candidates: list[BulletRepairCandidate],
        *,
        bullet_id: str,
        location: _BulletLocation,
        language: str,
        permitted_fact_ids: set[str],
        required_requirement_ids: set[str],
        allowed_numbers: set[str],
    ) -> BulletRepairCandidate | None:
        ranked: list[tuple[tuple[object, ...], BulletRepairCandidate]] = []
        original_text = str(location.bullet.get("text") or "")
        for value in candidates:
            text = value.text.strip()
            fact_ids = {str(item) for item in value.source_fact_ids if item}
            requirement_ids = {str(item) for item in value.matched_jd_requirement_ids if item}
            if not fact_ids.issubset(permitted_fact_ids):
                continue
            if permitted_fact_ids and not fact_ids:
                continue
            if requirement_ids != required_requirement_ids:
                continue
            if not set(_NUMBER.findall(text)).issubset(allowed_numbers):
                continue
            if text.endswith((".", "。")):
                continue
            fit = self._layout.measure_bullet_fit(
                text,
                bullet_id=bullet_id,
                item_id=location.item_id,
                section_type=location.section_type,
                language=language,
            )
            if fit.status != "pass":
                continue
            rank = (
                abs(fit.last_line_ratio - fit.target_ratio),
                abs(len(text) - len(original_text)),
                text,
            )
            ranked.append((rank, value))
        return min(ranked, key=lambda item: item[0])[1] if ranked else None


def _bullet_locations(structured: dict[str, Any]) -> dict[str, _BulletLocation]:
    locations: dict[str, _BulletLocation] = {}
    for section in structured.get("sections") or []:
        if not isinstance(section, dict):
            continue
        section_type = str(section.get("type") or "other")
        for item in section.get("items") or []:
            if not isinstance(item, dict):
                continue
            item_id = str(item.get("id") or "item")
            source_id = str(item.get("source_experience_id") or "")
            for bullet in item.get("bullets") or []:
                if not isinstance(bullet, dict) or not bullet.get("id"):
                    continue
                bullet_id = str(bullet["id"])
                if bullet_id in locations:
                    return {}
                locations[bullet_id] = _BulletLocation(
                    section_type=section_type,
                    item_id=item_id,
                    source_experience_id=source_id,
                    bullet=bullet,
                )
    return locations


def _allowed_fact_ids(content_budget: dict[str, Any]) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for experience in content_budget.get("experiences") or []:
        if not isinstance(experience, dict) or not experience.get("experience_id"):
            continue
        result[str(experience["experience_id"])] = {
            str(fact["id"])
            for fact in experience.get("facts") or []
            if isinstance(fact, dict) and fact.get("id")
        }
    return result


def _source_blob(source: dict[str, Any]) -> str:
    return "\n".join(
        [
            str(source.get("content") or ""),
            str(source.get("title") or ""),
            str(source.get("organization") or ""),
            str(source.get("role") or ""),
            " ".join(str(value) for value in source.get("tags") or []),
            " ".join(
                str(value.get("text") or "")
                for value in source.get("claims") or []
                if isinstance(value, dict)
            ),
        ]
    )
