"""Deterministic selection and bounded visual fitting for resume candidates."""

from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from app.domain.resume.layout_models import (
    LayoutConstraint,
    LayoutReport,
    LayoutTuning,
    LayoutViolation,
)
from app.domain.resume.layout_service import ResumeLayoutService


@dataclass(frozen=True)
class LayoutOptimizationResult:
    structure: dict[str, Any]
    report: LayoutReport
    fits_target_band: bool
    maximum_usage_ratio: float


class ResumeLayoutOptimizer:
    """Fit a candidate pool into the configured page-usage band without LLM calls."""

    _TUNINGS = (
        LayoutTuning(),
        LayoutTuning(
            body_font_scale=1.025,
            body_line_height=1.21,
            section_gap_scale=1.10,
            item_gap_scale=1.15,
            bullet_gap_scale=1.10,
        ),
        LayoutTuning(
            body_font_scale=1.05,
            body_line_height=1.24,
            section_gap_scale=1.25,
            item_gap_scale=1.30,
            bullet_gap_scale=1.20,
        ),
        LayoutTuning(
            body_font_scale=1.08,
            body_line_height=1.28,
            section_gap_scale=1.50,
            item_gap_scale=1.60,
            bullet_gap_scale=1.50,
        ),
    )

    def __init__(self, layout: ResumeLayoutService) -> None:
        self._layout = layout

    def optimize(
        self,
        structure: dict[str, Any],
        constraint: LayoutConstraint,
        experience_scores: dict[str, float] | None = None,
    ) -> LayoutOptimizationResult:
        scores = experience_scores or {}
        full = deepcopy(structure)
        full.pop("layout_tuning", None)
        full = _repair_bullet_widths(full, self._layout)
        full_report = self._layout.measure_resume_layout(full, constraint)
        full_usage = _first_page_usage(full_report)

        if full_report.page_count > 1 or full_usage > constraint.maximum_page_usage_ratio:
            fitted = self._trim_to_band(full, constraint, scores)
            if fitted is not None:
                return fitted

        best_structure = full
        best_report = full_report
        best_distance = abs(full_usage - constraint.target_page_usage_ratio)
        maximum_usage = full_usage
        for tuning in self._TUNINGS:
            candidate = deepcopy(full)
            candidate["layout_tuning"] = tuning.model_dump()
            candidate = _repair_bullet_widths(
                candidate,
                self._layout.with_tuning(tuning),
            )
            report = self._layout.measure_resume_layout(candidate, constraint)
            usage = _first_page_usage(report)
            maximum_usage = max(maximum_usage, usage)
            if _has_non_page_hard_violation(report):
                continue
            if _in_band(report, constraint):
                distance = abs(usage - constraint.target_page_usage_ratio)
                if distance < best_distance or not _in_band(best_report, constraint):
                    best_structure, best_report, best_distance = candidate, report, distance
            elif usage <= constraint.maximum_page_usage_ratio and usage > _first_page_usage(
                best_report
            ):
                best_structure, best_report = candidate, report

        if not _in_band(best_report, constraint):
            usage = _first_page_usage(best_report)
            code = (
                "page_underfilled"
                if usage < constraint.minimum_page_usage_ratio
                else "page_overfilled"
            )
            violations = list(best_report.violations)
            if not any(violation.code == code for violation in violations):
                violations.append(
                    LayoutViolation(
                        code=code,
                        message=(
                            f"Resume uses {usage:.1%} of the first printable page; required "
                            f"band is {constraint.minimum_page_usage_ratio:.0%}-"
                            f"{constraint.maximum_page_usage_ratio:.0%}."
                        ),
                    )
                )
            best_report = best_report.model_copy(
                update={
                    "status": "needs_revision",
                    "violations": violations,
                }
            )
        return LayoutOptimizationResult(
            structure=best_structure,
            report=best_report,
            fits_target_band=_in_band(best_report, constraint),
            maximum_usage_ratio=maximum_usage,
        )

    def _trim_to_band(
        self,
        structure: dict[str, Any],
        constraint: LayoutConstraint,
        experience_scores: dict[str, float],
    ) -> LayoutOptimizationResult | None:
        candidate = deepcopy(structure)
        removals = _removable_bullets(candidate, experience_scores)
        best: LayoutOptimizationResult | None = None
        for _section, item, bullet in removals:
            bullets = item.get("bullets")
            if not isinstance(bullets, list) or bullet not in bullets:
                continue
            bullets.remove(bullet)
            report = self._layout.measure_resume_layout(candidate, constraint)
            usage = _first_page_usage(report)
            if _in_band(report, constraint):
                current = LayoutOptimizationResult(
                    structure=deepcopy(candidate),
                    report=report,
                    fits_target_band=True,
                    maximum_usage_ratio=usage,
                )
                if best is None or abs(usage - constraint.target_page_usage_ratio) < abs(
                    _first_page_usage(best.report) - constraint.target_page_usage_ratio
                ):
                    best = current
            if report.page_count == 1 and usage < constraint.minimum_page_usage_ratio:
                break
        return best


def _repair_bullet_widths(structure: dict[str, Any], layout: ResumeLayoutService) -> dict[str, Any]:
    """Repartition sourced clauses within each item without any model call."""
    candidate = deepcopy(structure)
    language = str(candidate.get("language") or "zh-CN")
    for section in candidate.get("sections") or []:
        if not isinstance(section, dict) or section.get("type") not in {
            "experience",
            "project",
        }:
            continue
        for item in section.get("items") or []:
            if not isinstance(item, dict):
                continue
            raw_bullets = item.get("bullets")
            if not isinstance(raw_bullets, list):
                continue
            bullets = [value for value in raw_bullets if isinstance(value, dict)]
            repaired = _resegment_item_bullets(
                bullets,
                layout,
                item_id=str(item.get("id") or "item"),
                section_type=str(section.get("type") or "other"),
                language=language,
            )
            if repaired is not None:
                item["bullets"] = repaired
    return candidate


def _resegment_item_bullets(
    bullets: list[dict[str, Any]],
    layout: ResumeLayoutService,
    *,
    item_id: str,
    section_type: str,
    language: str,
) -> list[dict[str, Any]] | None:
    if not bullets:
        return bullets
    original_fits = [
        layout.measure_bullet_fit(
            str(bullet.get("text") or ""),
            bullet_id=str(bullet.get("id") or f"bullet-{index}"),
            item_id=item_id,
            section_type=section_type,
            language=language,
        )
        for index, bullet in enumerate(bullets)
    ]
    if all(fit.status == "pass" for fit in original_fits):
        return bullets

    atoms: list[tuple[str, int, dict[str, Any]]] = []
    for bullet_index, bullet in enumerate(bullets):
        text = str(bullet.get("text") or "").strip().rstrip("；;，, ")
        pieces = [
            value.strip().rstrip("；;，, ")
            for value in re.split(r"(?<=[，,；;])", text)
            if value.strip().rstrip("；;，, ")
        ]
        atoms.extend((piece, bullet_index, bullet) for piece in (pieces or [text]) if piece)
    if not atoms:
        return None

    # end_position -> segment_count -> (total rendered lines, segments)
    paths: dict[int, dict[int, tuple[int, list[dict[str, Any]]]]] = {0: {0: (0, [])}}
    for start in range(len(atoms)):
        if start not in paths:
            continue
        for end in range(start + 1, len(atoms) + 1):
            segment = _bullet_segment(atoms[start:end], segment_index=end)
            fit = layout.measure_bullet_fit(
                str(segment["text"]),
                bullet_id=str(segment["id"]),
                item_id=item_id,
                section_type=section_type,
                language=language,
            )
            if fit.status != "pass":
                continue
            for count, (total_lines, existing) in paths[start].items():
                next_count = count + 1
                candidate_value = (total_lines + fit.line_count, [*existing, segment])
                current = paths.setdefault(end, {}).get(next_count)
                if current is None or candidate_value[0] > current[0]:
                    paths[end][next_count] = candidate_value

    completed = paths.get(len(atoms), {})
    if not completed:
        return None
    chosen_count = min(
        completed,
        key=lambda count: (abs(count - len(bullets)), -count),
    )
    return completed[chosen_count][1]


def _bullet_segment(
    atoms: list[tuple[str, int, dict[str, Any]]], *, segment_index: int
) -> dict[str, Any]:
    first = atoms[0][2]
    segment = dict(first)
    parts: list[str] = []
    previous_bullet_index: int | None = None
    for text, bullet_index, _bullet in atoms:
        if parts:
            parts.append("；" if bullet_index != previous_bullet_index else "，")
        parts.append(text)
        previous_bullet_index = bullet_index
    base_id = str(first.get("id") or "bullet")
    segment["id"] = f"{base_id}-layout-{segment_index}"
    segment["text"] = "".join(parts)
    segment["matched_jd_requirement_ids"] = _ordered_union(
        value for _, _, bullet in atoms for value in bullet.get("matched_jd_requirement_ids") or []
    )
    segment["source_fact_ids"] = _ordered_union(
        value for _, _, bullet in atoms for value in bullet.get("source_fact_ids") or []
    )
    segment["layout_exception"] = None
    return segment


def _ordered_union(values: Any) -> list[str]:
    return list(dict.fromkeys(str(value) for value in values if value))


def _removable_bullets(
    structure: dict[str, Any], experience_scores: dict[str, float]
) -> list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]:
    values: list[tuple[float, dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    for section in structure.get("sections") or []:
        if not isinstance(section, dict) or section.get("type") not in {"experience", "project"}:
            continue
        for item in section.get("items") or []:
            if not isinstance(item, dict):
                continue
            bullets = item.get("bullets") or []
            if not isinstance(bullets, list) or len(bullets) <= 2:
                continue
            source_id = str(item.get("source_experience_id") or "")
            experience_score = experience_scores.get(source_id, 0.0)
            for index, bullet in enumerate(bullets[2:], start=2):
                if not isinstance(bullet, dict):
                    continue
                jd_gain = len(bullet.get("matched_jd_requirement_ids") or [])
                score = experience_score * 10.0 + jd_gain * 5.0 - index * 0.01
                values.append((score, section, item, bullet))
    values.sort(key=lambda value: value[0])
    return [(section, item, bullet) for _, section, item, bullet in values]


def _first_page_usage(report: LayoutReport) -> float:
    return report.pages[0].usage_ratio if report.pages else 0.0


def _in_band(report: LayoutReport, constraint: LayoutConstraint) -> bool:
    usage = _first_page_usage(report)
    return (
        report.page_count == 1
        and constraint.minimum_page_usage_ratio <= usage <= constraint.maximum_page_usage_ratio
    )


def _has_non_page_hard_violation(report: LayoutReport) -> bool:
    return any(
        violation.severity == "hard" and violation.code != "page_underfilled"
        for violation in report.violations
    )
