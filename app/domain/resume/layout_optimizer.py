"""Deterministic selection and bounded visual fitting for resume candidates."""

from __future__ import annotations

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
            report = self._layout.measure_resume_layout(candidate, constraint)
            usage = _first_page_usage(report)
            maximum_usage = max(maximum_usage, usage)
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
            best_report = best_report.model_copy(
                update={
                    "status": "needs_revision",
                    "violations": [
                        *best_report.violations,
                        LayoutViolation(
                            code=code,
                            message=(
                                f"Resume uses {usage:.1%} of the first printable page; required "
                                f"band is {constraint.minimum_page_usage_ratio:.0%}-"
                                f"{constraint.maximum_page_usage_ratio:.0%}."
                            ),
                        ),
                    ],
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
