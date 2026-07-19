from __future__ import annotations

import hashlib
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Literal

from app.domain.resume.candidates.models import CandidateBullet
from app.domain.resume.compiler.models import (
    CandidateMeasurement,
    CompilationAction,
    CompiledResume,
    LayoutCompilationDiagnostics,
    LayoutCompilationResult,
)
from app.domain.resume.layout_models import LayoutConstraint, LayoutReport, LayoutTuning
from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.planning.models import ResumePlan

_VARIANT_RANK = {"short": 0, "medium": 1, "long": 2}
_SAFE_TUNINGS = (
    LayoutTuning(),
    LayoutTuning(
        body_font_scale=1.0,
        body_line_height=1.24,
        section_gap_scale=1.20,
        item_gap_scale=1.30,
        bullet_gap_scale=1.30,
    ),
    LayoutTuning(
        body_font_scale=1.0,
        body_line_height=1.28,
        section_gap_scale=1.50,
        item_gap_scale=1.60,
        bullet_gap_scale=1.50,
    ),
    LayoutTuning(
        body_font_scale=1.0,
        body_line_height=1.28,
        section_gap_scale=2.50,
        item_gap_scale=4.00,
        bullet_gap_scale=3.00,
    ),
    LayoutTuning(
        body_font_scale=1.015,
        body_line_height=1.20,
        section_gap_scale=1.05,
        item_gap_scale=1.05,
        bullet_gap_scale=1.05,
    ),
    LayoutTuning(
        body_font_scale=1.025,
        body_line_height=1.21,
        section_gap_scale=1.10,
        item_gap_scale=1.10,
        bullet_gap_scale=1.10,
    ),
    LayoutTuning(
        body_font_scale=1.06,
        body_line_height=1.22,
        section_gap_scale=1.12,
        item_gap_scale=1.12,
        bullet_gap_scale=1.12,
    ),
    LayoutTuning(
        body_font_scale=1.08,
        body_line_height=1.24,
        section_gap_scale=1.18,
        item_gap_scale=1.18,
        bullet_gap_scale=1.18,
    ),
)


@dataclass(frozen=True, slots=True)
class _CandidateOption:
    candidate: CandidateBullet
    measurement: CandidateMeasurement
    section_id: str
    requirement_value: float


@dataclass(frozen=True, slots=True)
class _BeamState:
    selected: tuple[_CandidateOption, ...] = ()
    group_ids: frozenset[str] = frozenset()
    fact_ids: frozenset[str] = frozenset()
    experience_ids: frozenset[str] = frozenset()
    section_ids: frozenset[str] = frozenset()
    requirement_ids: frozenset[str] = frozenset()
    text_keys: frozenset[str] = frozenset()
    estimated_height_mm: float = 0.0
    value_score: float = 0.0
    readability_score: float = 0.0


class ResumeLayoutCompiler:
    """Choose one grounded version per candidate group under an A4 height contract."""

    def __init__(
        self,
        layout: ResumeLayoutService,
        *,
        beam_width: int = 256,
        exact_candidate_limit: int = 32,
        seed_measurements: tuple[CandidateMeasurement, ...] = (),
    ) -> None:
        self._layout = layout
        self._beam_width = beam_width
        self._exact_candidate_limit = exact_candidate_limit
        self._measurement_cache = {value.cache_key: value for value in seed_measurements}

    def compile(
        self,
        plan: ResumePlan,
        candidates: tuple[CandidateBullet, ...],
        scaffold: dict[str, Any],
        constraint: LayoutConstraint,
        *,
        template_id: str,
        language: str,
        browser_scale: float = 1.0,
    ) -> LayoutCompilationResult:
        browser_scale = min(1.25, max(0.75, browser_scale))
        requirement_weights = {value.requirement_id: value.weight for value in plan.requirements}
        item_sections = _item_section_map(scaffold)
        required_sections = _required_section_ids(scaffold)
        raw_groups: dict[str, list[CandidateBullet]] = {}
        for candidate in candidates:
            if (
                candidate.experience_id not in item_sections
                or candidate.experience_id not in plan.selected_experience_ids
                or not set(candidate.source_fact_ids).issubset(plan.selected_fact_ids)
            ):
                continue
            raw_groups.setdefault(candidate.candidate_group_id, []).append(candidate)
        groups = {
            group_id: tuple(
                sorted(
                    values,
                    key=lambda value: (
                        _VARIANT_RANK[value.length_variant],
                        value.bullet_id,
                    ),
                )
            )
            for group_id, values in sorted(raw_groups.items())
        }
        input_errors: list[str] = []
        candidate_ids = [value.bullet_id for value in candidates]
        if len(candidate_ids) != len(set(candidate_ids)):
            input_errors.append("duplicate_candidate_id")
        available_fact_ids = {
            fact_id
            for values in groups.values()
            for value in values
            for fact_id in value.source_fact_ids
        }
        if not set(plan.selected_fact_ids).issubset(available_fact_ids):
            input_errors.append("planned_fact_missing_from_candidate_pool")
        for values in groups.values():
            signatures = {
                (
                    value.experience_id,
                    value.source_fact_ids,
                    value.covered_requirement_ids,
                )
                for value in values
            }
            if len(signatures) != 1:
                input_errors.append("candidate_group_grounding_mismatch")
                break
        if input_errors:
            return _input_failure(
                candidates=candidates,
                group_count=len(groups),
                beam_width=self._beam_width,
                browser_scale=browser_scale,
                reasons=tuple(dict.fromkeys(input_errors)),
            )

        cache_hits = 0
        cache_misses = 0
        measurements: list[CandidateMeasurement] = []
        options_by_group: list[tuple[str, tuple[_CandidateOption, ...]]] = []
        for group_id, group_candidates in groups.items():
            options: list[_CandidateOption] = []
            for candidate in group_candidates:
                measurement, hit = self._measure(
                    candidate,
                    section_id=item_sections[candidate.experience_id],
                    template_id=template_id,
                    language=language,
                )
                cache_hits += int(hit)
                cache_misses += int(not hit)
                measurements.append(measurement)
                if measurement.fit_status in {"too_short", "awkward_wrap"}:
                    continue
                requirement_value = sum(
                    requirement_weights.get(value, 0.0)
                    for value in candidate.covered_requirement_ids
                )
                options.append(
                    _CandidateOption(
                        candidate=candidate,
                        measurement=measurement,
                        section_id=item_sections[candidate.experience_id],
                        requirement_value=requirement_value,
                    )
                )
            if options:
                options_by_group.append((group_id, tuple(options)))

        base_structure = _base_structure(scaffold)
        base_report = self._layout.measure_resume_layout(base_structure, constraint)
        fixed_height = _first_page_height(base_report)
        section_overheads, item_overheads, overhead_calls = self._measure_overheads(
            scaffold,
            base_structure,
            constraint,
        )
        maximum_options = tuple(options[-1] for _, options in options_by_group)
        maximum_reports: list[LayoutReport] = []
        for tuning in _SAFE_TUNINGS:
            maximum_structure = _structure_for_options(
                scaffold,
                maximum_options,
                tuning=tuning,
                constraint=constraint,
            )
            maximum_reports.append(
                self._layout.measure_resume_layout(maximum_structure, constraint)
            )
        maximum_report = maximum_reports[0]
        maximum_usage = max(_total_usage_ratio(value) for value in maximum_reports)
        maximum_browser_usage = maximum_usage * browser_scale

        initial = _BeamState(estimated_height_mm=fixed_height)
        beam = [initial]
        expanded_states = 0
        pruned_states = 0
        maximum_height = (
            constraint.maximum_page_usage_ratio * self._layout.profile.content_height_mm
        )
        search_ceiling = min(
            self._layout.profile.content_height_mm,
            maximum_height + self._layout.profile.body.line_height_mm * 3,
        )
        for _group_id, group_options in options_by_group:
            expanded: list[_BeamState] = []
            for state in beam:
                expanded.append(state)
                for option in group_options:
                    candidate = option.candidate
                    if state.fact_ids.intersection(candidate.source_fact_ids):
                        continue
                    text_key = _candidate_text_key(candidate.text)
                    if text_key and text_key in state.text_keys:
                        continue
                    section_delta = (
                        section_overheads.get(option.section_id, 0.0)
                        if option.section_id not in state.section_ids
                        else 0.0
                    )
                    item_delta = (
                        item_overheads.get(candidate.experience_id, 0.0)
                        if candidate.experience_id not in state.experience_ids
                        else 0.0
                    )
                    height = (
                        state.estimated_height_mm
                        + section_delta
                        + item_delta
                        + option.measurement.height_mm
                    )
                    if height > search_ceiling + 1e-6:
                        continue
                    new_requirements = set(candidate.covered_requirement_ids).difference(
                        state.requirement_ids
                    )
                    coverage_gain = sum(
                        requirement_weights.get(value, 0.0) for value in new_requirements
                    )
                    readability = _readability(option.measurement)
                    expanded.append(
                        _BeamState(
                            selected=(*state.selected, option),
                            group_ids=state.group_ids | {candidate.candidate_group_id},
                            fact_ids=state.fact_ids | set(candidate.source_fact_ids),
                            experience_ids=state.experience_ids | {candidate.experience_id},
                            section_ids=state.section_ids | {option.section_id},
                            requirement_ids=state.requirement_ids
                            | set(candidate.covered_requirement_ids),
                            text_keys=state.text_keys | ({text_key} if text_key else set()),
                            estimated_height_mm=height,
                            value_score=(
                                state.value_score
                                + coverage_gain * 3.0
                                + option.requirement_value
                                + candidate.quality_score
                                + (
                                    0.15
                                    if candidate.experience_id not in state.experience_ids
                                    else 0
                                )
                            ),
                            readability_score=state.readability_score + readability,
                        )
                    )
                    expanded_states += 1
            before = len(expanded)
            beam = self._prune(
                expanded,
                constraint=constraint,
                browser_scale=browser_scale,
            )
            pruned_states += max(0, before - len(beam))

        eligible_states = [value for value in beam if required_sections.issubset(value.section_ids)]
        all_ranked_states = sorted(
            eligible_states,
            key=lambda value: self._final_rank(
                value,
                constraint=constraint,
                requirement_weights=requirement_weights,
                browser_scale=browser_scale,
            ),
        )
        ranked_states = _stratified_exact_states(
            all_ranked_states,
            limit=self._exact_candidate_limit,
        )
        exact_layout_calls = 1 + overhead_calls + len(maximum_reports)
        exact_results: list[
            tuple[tuple[object, ...], _BeamState, dict[str, Any], LayoutReport, LayoutTuning]
        ] = []
        exact_attempts: list[tuple[float, bool, bool, bool, int]] = []
        for state in ranked_states:
            for tuning in _SAFE_TUNINGS:
                structure = _structure_for_options(
                    scaffold,
                    state.selected,
                    tuning=tuning,
                    constraint=constraint,
                )
                # The serialized tuning is the shared backend/browser contract.
                # ResumeLayoutService applies it while reading the structure, so
                # pre-tuning the service here would apply the same values twice.
                report = self._layout.measure_resume_layout(structure, constraint)
                exact_layout_calls += 1
                usage = _first_page_usage(report)
                predicted_browser_usage = usage * browser_scale
                single_page = report.page_count == 1 and report.overflow_mm <= 1e-6
                density_in_band = (
                    constraint.minimum_page_usage_ratio
                    <= usage
                    <= constraint.maximum_page_usage_ratio
                    and constraint.minimum_page_usage_ratio
                    <= predicted_browser_usage
                    <= constraint.maximum_page_usage_ratio
                )
                tail_failures = sum(
                    value.status in {"too_short", "awkward_wrap"} for value in report.bullet_fits
                )
                exact_attempts.append(
                    (usage, single_page, density_in_band, tail_failures == 0, tail_failures)
                )
                if not _layout_is_eligible(
                    report,
                    constraint,
                    predicted_browser_usage=predicted_browser_usage,
                ):
                    continue
                exact_results.append(
                    (
                        self._exact_rank(
                            state,
                            report,
                            constraint=constraint,
                            requirement_weights=requirement_weights,
                            predicted_browser_usage=predicted_browser_usage,
                            tuning=tuning,
                        ),
                        state,
                        structure,
                        report,
                        tuning,
                    )
                )

        warnings: list[str] = []
        if not exact_results:
            if exact_attempts:
                usages = [value[0] for value in exact_attempts]
                nearest = min(
                    exact_attempts,
                    key=lambda value: abs(value[0] - constraint.target_page_usage_ratio),
                )
                warnings.extend(
                    (
                        f"exact_usage_range:{min(usages):.4f}-{max(usages):.4f}",
                        f"exact_single_page_count:{sum(value[1] for value in exact_attempts)}",
                        f"exact_density_in_band_count:{sum(value[2] for value in exact_attempts)}",
                        f"exact_tail_pass_count:{sum(value[3] for value in exact_attempts)}",
                        "nearest_exact_attempt:"
                        f"usage={nearest[0]:.4f},single_page={nearest[1]},"
                        f"density={nearest[2]},tail_failures={nearest[4]}",
                    )
                )
            maximum_pool_stays_on_one_page = all(
                value.page_count == 1 and value.overflow_mm <= 1e-6 for value in maximum_reports
            )
            status: Literal["underfilled", "infeasible"] = (
                "underfilled"
                if maximum_pool_stays_on_one_page
                and (
                    maximum_usage < constraint.minimum_page_usage_ratio
                    or maximum_browser_usage < constraint.minimum_page_usage_ratio
                )
                else "infeasible"
            )
            reason = (
                "maximum_grounded_candidate_height_below_minimum"
                if status == "underfilled"
                else "no_candidate_combination_satisfies_layout_contract"
            )
            if status == "underfilled" and groups:
                warnings.append("compiler_underfill_after_exhausting_candidate_pool")
            diagnostics = LayoutCompilationDiagnostics(
                considered_groups=len(groups),
                considered_candidates=len(candidates),
                measured_candidates=len(measurements),
                measurement_cache_hits=cache_hits,
                measurement_cache_misses=cache_misses,
                expanded_states=expanded_states,
                pruned_states=pruned_states,
                exact_layout_calls=exact_layout_calls,
                beam_width=self._beam_width,
                fixed_height_mm=round(fixed_height, 3),
                maximum_candidate_usage_ratio=round(maximum_usage, 4),
                final_usage_ratio=round(maximum_usage, 4),
                predicted_browser_usage_ratio=round(maximum_browser_usage, 4),
                browser_scale=round(browser_scale, 4),
                selected_groups=0,
                selected_candidates=0,
                unused_candidate_groups=0 if status == "underfilled" else len(groups),
                warnings=tuple(warnings),
            )
            return LayoutCompilationResult(
                status=status,
                measurements=tuple(measurements),
                diagnostics=diagnostics,
                failure_reasons=(reason,),
            )

        _rank, selected_state, structure, report, tuning = min(
            exact_results, key=lambda value: value[0]
        )
        usage = _first_page_usage(report)
        selected_ids = tuple(value.candidate.bullet_id for value in selected_state.selected)
        selected_group_ids = tuple(
            value.candidate.candidate_group_id for value in selected_state.selected
        )
        selected_fact_ids = tuple(
            dict.fromkeys(
                fact_id
                for value in selected_state.selected
                for fact_id in value.candidate.source_fact_ids
            )
        )
        actions = _actions(
            options_by_group,
            selected_state,
            maximum_report=maximum_report,
            constraint=constraint,
            tuning=tuning,
        )
        structure["layout_usage_ratio"] = usage
        structure["layout_target_band"] = {
            "minimum": constraint.minimum_page_usage_ratio,
            "target": constraint.target_page_usage_ratio,
            "maximum": constraint.maximum_page_usage_ratio,
        }
        structure["layout_compiler_version"] = "resume-layout-compiler-v2"
        structure["selected_candidate_ids"] = list(selected_ids)
        diagnostics = LayoutCompilationDiagnostics(
            considered_groups=len(groups),
            considered_candidates=len(candidates),
            measured_candidates=len(measurements),
            measurement_cache_hits=cache_hits,
            measurement_cache_misses=cache_misses,
            expanded_states=expanded_states,
            pruned_states=pruned_states,
            exact_layout_calls=exact_layout_calls,
            beam_width=self._beam_width,
            fixed_height_mm=round(fixed_height, 3),
            maximum_candidate_usage_ratio=round(maximum_usage, 4),
            final_usage_ratio=round(usage, 4),
            predicted_browser_usage_ratio=round(usage * browser_scale, 4),
            browser_scale=round(browser_scale, 4),
            selected_groups=len(selected_group_ids),
            selected_candidates=len(selected_ids),
            unused_candidate_groups=max(0, len(groups) - len(selected_group_ids)),
            warnings=tuple(warnings),
        )
        return LayoutCompilationResult(
            status="compiled",
            compiled_resume=CompiledResume(
                plan_version=plan.plan_version,
                selected_candidate_ids=selected_ids,
                selected_candidate_group_ids=selected_group_ids,
                selected_fact_ids=selected_fact_ids,
                structured_resume=structure,
                layout_report=report,
                layout_tuning=tuning,
                actions=actions,
            ),
            measurements=tuple(measurements),
            diagnostics=diagnostics,
        )

    def _measure(
        self,
        candidate: CandidateBullet,
        *,
        section_id: str,
        template_id: str,
        language: str,
    ) -> tuple[CandidateMeasurement, bool]:
        font = self._layout.profile.font_for_language(language)
        cache_key = _measurement_key(
            candidate.bullet_id,
            template_id,
            self._layout.profile.profile_hash,
            language,
            font.checksum_sha256,
        )
        cached = self._measurement_cache.get(cache_key)
        if cached is not None:
            return cached, True
        fit = self._layout.measure_bullet_fit(
            candidate.text,
            bullet_id=candidate.bullet_id,
            item_id=candidate.experience_id,
            section_type=section_id,
            language=language,
        )
        height = (
            self._layout.profile.spacing.bullet_before_mm
            + fit.line_count * self._layout.profile.body.line_height_mm
            + self._layout.profile.spacing.bullet_after_mm
        )
        measured = CandidateMeasurement(
            bullet_id=candidate.bullet_id,
            candidate_group_id=candidate.candidate_group_id,
            experience_id=candidate.experience_id,
            length_variant=candidate.length_variant,
            line_count=fit.line_count,
            height_mm=round(height, 3),
            last_line_ratio=fit.last_line_ratio,
            fit_status=fit.status,
            cache_key=cache_key,
            template_id=template_id,
            profile_hash=self._layout.profile.profile_hash,
            font_checksum=font.checksum_sha256,
        )
        self._measurement_cache[cache_key] = measured
        return measured, False

    def _measure_overheads(
        self,
        scaffold: dict[str, Any],
        base_structure: dict[str, Any],
        constraint: LayoutConstraint,
    ) -> tuple[dict[str, float], dict[str, float], int]:
        base_height = _first_page_height(
            self._layout.measure_resume_layout(base_structure, constraint)
        )
        calls = 1
        section_overheads: dict[str, float] = {}
        item_overheads: dict[str, float] = {}
        for section in _narrative_sections(scaffold):
            section_id = str(section.get("id") or section.get("type") or "other")
            empty_section = deepcopy(section)
            empty_section["items"] = []
            section_structure = deepcopy(base_structure)
            section_structure.setdefault("sections", []).append(empty_section)
            section_height = _first_page_height(
                self._layout.measure_resume_layout(section_structure, constraint)
            )
            calls += 1
            section_overheads[section_id] = max(0.0, section_height - base_height)
            for item in section.get("items") or []:
                if not isinstance(item, dict):
                    continue
                experience_id = str(item.get("source_experience_id") or "")
                if not experience_id:
                    continue
                item_section = deepcopy(section)
                item_copy = deepcopy(item)
                item_copy["bullets"] = []
                item_section["items"] = [item_copy]
                item_structure = deepcopy(base_structure)
                item_structure.setdefault("sections", []).append(item_section)
                item_height = _first_page_height(
                    self._layout.measure_resume_layout(item_structure, constraint)
                )
                calls += 1
                item_overheads[experience_id] = max(0.0, item_height - section_height)
        return section_overheads, item_overheads, calls

    def _prune(
        self,
        states: list[_BeamState],
        *,
        constraint: LayoutConstraint,
        browser_scale: float,
    ) -> list[_BeamState]:
        available = self._layout.profile.content_height_mm
        # The additive beam estimate intentionally omits several interactions
        # that exact pagination applies later and therefore runs high for dense,
        # merged candidate pools. Search near the allowed ceiling; exact layout
        # remains the authority and still rejects anything outside the contract.
        target_height = available
        best: dict[
            tuple[
                int,
                frozenset[str],
                frozenset[str],
                frozenset[str],
                frozenset[str],
                frozenset[str],
            ],
            _BeamState,
        ] = {}
        for state in states:
            bucket = int(round(state.estimated_height_mm / max(0.5, available / 500)))
            key = (
                bucket,
                state.experience_ids,
                state.requirement_ids,
                state.group_ids,
                state.fact_ids,
                state.text_keys,
            )
            current = best.get(key)
            if current is None or self._state_rank(
                state, target_height=target_height, browser_scale=browser_scale
            ) < self._state_rank(current, target_height=target_height, browser_scale=browser_scale):
                best[key] = state
        ranked = sorted(
            best.values(),
            key=lambda state: self._state_rank(
                state, target_height=target_height, browser_scale=browser_scale
            ),
        )
        return _stratified_beam_states(ranked, limit=self._beam_width)

    @staticmethod
    def _state_rank(
        state: _BeamState,
        *,
        target_height: float,
        browser_scale: float,
    ) -> tuple[object, ...]:
        predicted = state.estimated_height_mm * browser_scale
        return (
            -len(state.requirement_ids),
            -len(state.experience_ids),
            abs(predicted - target_height),
            -round(state.value_score, 6),
            -round(state.readability_score, 6),
            tuple(value.candidate.bullet_id for value in state.selected),
        )

    def _final_rank(
        self,
        state: _BeamState,
        *,
        constraint: LayoutConstraint,
        requirement_weights: dict[str, float],
        browser_scale: float,
    ) -> tuple[object, ...]:
        available = self._layout.profile.content_height_mm
        usage = state.estimated_height_mm / available if available else 0.0
        predicted = usage * browser_scale
        coverage = sum(requirement_weights.get(value, 0.0) for value in state.requirement_ids)
        in_band = (
            constraint.minimum_page_usage_ratio <= usage <= constraint.maximum_page_usage_ratio
            and constraint.minimum_page_usage_ratio
            <= predicted
            <= constraint.maximum_page_usage_ratio
        )
        return (
            not in_band,
            -round(coverage, 6),
            -round(state.value_score, 6),
            -len(state.experience_ids),
            -round(state.readability_score, 6),
            abs(predicted - constraint.target_page_usage_ratio),
            tuple(value.candidate.bullet_id for value in state.selected),
        )

    @staticmethod
    def _exact_rank(
        state: _BeamState,
        report: LayoutReport,
        *,
        constraint: LayoutConstraint,
        requirement_weights: dict[str, float],
        predicted_browser_usage: float,
        tuning: LayoutTuning,
    ) -> tuple[object, ...]:
        coverage = sum(requirement_weights.get(value, 0.0) for value in state.requirement_ids)
        tail_failures = sum(value.status != "pass" for value in report.bullet_fits)
        tuning_penalty = sum(
            (
                tuning.body_font_scale - 1.0,
                tuning.section_gap_scale - 1.0,
                tuning.item_gap_scale - 1.0,
                tuning.bullet_gap_scale - 1.0,
            )
        )
        return (
            -round(coverage, 6),
            -round(state.value_score, 6),
            -len(state.experience_ids),
            tail_failures,
            abs(predicted_browser_usage - constraint.target_page_usage_ratio),
            round(tuning_penalty, 6),
            tuple(value.candidate.bullet_id for value in state.selected),
        )


def _measurement_key(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


def _candidate_text_key(text: str) -> str:
    return "".join(text.casefold().split()).rstrip("。.！!")


def _readability(measurement: CandidateMeasurement) -> float:
    status_value = {"pass": 1.0, "awkward_wrap": 0.35, "too_short": 0.15}
    return status_value[measurement.fit_status] - abs(measurement.last_line_ratio - 0.75) * 0.1


def _narrative_sections(structure: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        value
        for value in structure.get("sections") or []
        if isinstance(value, dict) and value.get("type") in {"experience", "project", "other"}
    ]


def _item_section_map(structure: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    for section in _narrative_sections(structure):
        section_id = str(section.get("id") or section.get("type") or "other")
        for item in section.get("items") or []:
            if not isinstance(item, dict):
                continue
            experience_id = str(item.get("source_experience_id") or "")
            if experience_id:
                result[experience_id] = section_id
    return result


def _required_section_ids(structure: dict[str, Any]) -> frozenset[str]:
    return frozenset(
        str(value.get("id") or value.get("type"))
        for value in _narrative_sections(structure)
        if value.get("type") in {"experience", "project"} and value.get("items")
    )


def _base_structure(scaffold: dict[str, Any]) -> dict[str, Any]:
    structure = deepcopy(scaffold)
    structure["sections"] = [
        deepcopy(value)
        for value in scaffold.get("sections") or []
        if isinstance(value, dict) and value.get("type") not in {"experience", "project", "other"}
    ]
    structure.pop("layout_tuning", None)
    return structure


def _structure_for_options(
    scaffold: dict[str, Any],
    selected: tuple[_CandidateOption, ...],
    *,
    tuning: LayoutTuning,
    constraint: LayoutConstraint,
) -> dict[str, Any]:
    by_experience: dict[str, list[_CandidateOption]] = {}
    for option in selected:
        by_experience.setdefault(option.candidate.experience_id, []).append(option)
    structure = deepcopy(scaffold)
    sections: list[dict[str, Any]] = []
    for raw_section in structure.get("sections") or []:
        if not isinstance(raw_section, dict):
            continue
        section = deepcopy(raw_section)
        if section.get("type") not in {"experience", "project", "other"}:
            sections.append(section)
            continue
        items: list[dict[str, Any]] = []
        for raw_item in section.get("items") or []:
            if not isinstance(raw_item, dict):
                continue
            experience_id = str(raw_item.get("source_experience_id") or "")
            options = by_experience.get(experience_id, [])
            if not options:
                continue
            item = deepcopy(raw_item)
            item["bullets"] = [
                {
                    "id": option.candidate.bullet_id,
                    "text": option.candidate.text,
                    "source_fact_ids": list(option.candidate.source_fact_ids),
                    "matched_jd_requirement_ids": list(option.candidate.covered_requirement_ids),
                    "candidate_group_id": option.candidate.candidate_group_id,
                    "length_variant": option.candidate.length_variant,
                }
                for option in options
            ]
            items.append(item)
        if items:
            section["items"] = items
            sections.append(section)
    structure["sections"] = sections
    structure["layout_tuning"] = tuning.model_dump(mode="json")
    structure["layout_target_band"] = {
        "minimum": constraint.minimum_page_usage_ratio,
        "target": constraint.target_page_usage_ratio,
        "maximum": constraint.maximum_page_usage_ratio,
    }
    return structure


def _layout_is_eligible(
    report: LayoutReport,
    constraint: LayoutConstraint,
    *,
    predicted_browser_usage: float,
) -> bool:
    usage = _first_page_usage(report)
    fatal_codes = {
        value.code
        for value in report.violations
        if value.code
        in {
            "bullet_awkward_wrap",
            "bullet_too_short",
            "profile_mismatch",
            "font_checksum_mismatch",
            "page_limit_exceeded",
            "forced_block_split",
        }
    }
    return (
        not fatal_codes
        and report.page_count == 1
        and report.overflow_mm <= 1e-6
        and constraint.minimum_page_usage_ratio <= usage <= constraint.maximum_page_usage_ratio
        and constraint.minimum_page_usage_ratio
        <= predicted_browser_usage
        <= constraint.maximum_page_usage_ratio
    )


def _stratified_exact_states(
    ranked_states: list[_BeamState],
    *,
    limit: int,
) -> list[_BeamState]:
    """Keep value leaders while reserving exact checks for nearby heights.

    Estimated heights can differ from exact pagination by a few millimetres. If
    the entire exact budget is spent on equal-height states, a one-bullet-shorter
    valid solution can be missed even though it survived the beam. One leader per
    height/count stratum makes that boundary deterministic without widening the
    beam or turning exact layout into the inner search loop.
    """
    selected: list[_BeamState] = []
    selected_ids: set[int] = set()
    strata: set[tuple[int, int]] = set()
    height_reserve = min(limit, max(8, limit // 4))
    tallest_states = sorted(
        ranked_states,
        key=lambda state: (-state.estimated_height_mm, -len(state.selected)),
    )
    for state in tallest_states:
        stratum = (round(state.estimated_height_mm * 10), len(state.selected))
        if stratum in strata:
            continue
        strata.add(stratum)
        selected.append(state)
        selected_ids.add(id(state))
        if len(selected) >= height_reserve:
            break
    if len(selected) >= limit:
        return selected
    for state in ranked_states:
        if id(state) in selected_ids:
            continue
        stratum = (round(state.estimated_height_mm * 10), len(state.selected))
        if stratum in strata:
            continue
        strata.add(stratum)
        selected.append(state)
        selected_ids.add(id(state))
        if len(selected) >= limit:
            return selected
    for state in ranked_states:
        if id(state) in selected_ids:
            continue
        selected.append(state)
        if len(selected) >= limit:
            break
    return selected


def _stratified_beam_states(
    ranked_states: list[_BeamState],
    *,
    limit: int,
) -> list[_BeamState]:
    """Reserve part of the beam for distinct height/count frontiers."""
    reserve = min(limit, max(16, limit // 4))
    selected: list[_BeamState] = []
    selected_ids: set[int] = set()
    strata: set[tuple[int, int]] = set()
    for state in ranked_states:
        stratum = (round(state.estimated_height_mm * 10), len(state.selected))
        if stratum in strata:
            continue
        strata.add(stratum)
        selected.append(state)
        selected_ids.add(id(state))
        if len(selected) >= reserve:
            break
    for state in ranked_states:
        if id(state) in selected_ids:
            continue
        selected.append(state)
        if len(selected) >= limit:
            break
    return selected


def _actions(
    groups: list[tuple[str, tuple[_CandidateOption, ...]]],
    selected: _BeamState,
    *,
    maximum_report: LayoutReport,
    constraint: LayoutConstraint,
    tuning: LayoutTuning,
) -> tuple[CompilationAction, ...]:
    chosen = {value.candidate.candidate_group_id: value for value in selected.selected}
    overflow_baseline = (
        maximum_report.page_count > 1
        or _first_page_usage(maximum_report) > constraint.maximum_page_usage_ratio
    )
    actions: list[CompilationAction] = []
    for group_id, options in groups:
        value = chosen.get(group_id)
        if value is None:
            if overflow_baseline:
                actions.append(
                    CompilationAction(
                        action="remove_candidate",
                        candidate_group_id=group_id,
                        reason="maximum_grounded_pool_exceeded_page_limit",
                    )
                )
            continue
        actions.append(
            CompilationAction(
                action="add_candidate",
                candidate_group_id=group_id,
                bullet_id=value.candidate.bullet_id,
                reason="selected_by_height_constrained_compiler",
            )
        )
        shortest = options[0].candidate
        longest = options[-1].candidate
        if not overflow_baseline and value.candidate.length_variant != shortest.length_variant:
            actions.append(
                CompilationAction(
                    action="select_longer_variant",
                    candidate_group_id=group_id,
                    bullet_id=value.candidate.bullet_id,
                    reason="increase_grounded_content_height",
                )
            )
        if overflow_baseline and value.candidate.length_variant != longest.length_variant:
            actions.append(
                CompilationAction(
                    action="select_shorter_variant",
                    candidate_group_id=group_id,
                    bullet_id=value.candidate.bullet_id,
                    reason="maximum_grounded_pool_exceeded_page_limit",
                )
            )
    if tuning != LayoutTuning():
        actions.append(
            CompilationAction(
                action="tune_spacing",
                reason="bounded_visual_expansion_within_safe_profile_limits",
            )
        )
    return tuple(actions)


def _input_failure(
    *,
    candidates: tuple[CandidateBullet, ...],
    group_count: int,
    beam_width: int,
    browser_scale: float,
    reasons: tuple[str, ...],
) -> LayoutCompilationResult:
    return LayoutCompilationResult(
        status="infeasible",
        measurements=(),
        diagnostics=LayoutCompilationDiagnostics(
            considered_groups=group_count,
            considered_candidates=len(candidates),
            measured_candidates=0,
            measurement_cache_hits=0,
            measurement_cache_misses=0,
            expanded_states=0,
            pruned_states=0,
            exact_layout_calls=0,
            beam_width=beam_width,
            fixed_height_mm=0.0,
            maximum_candidate_usage_ratio=0.0,
            final_usage_ratio=0.0,
            predicted_browser_usage_ratio=0.0,
            browser_scale=round(browser_scale, 4),
            selected_groups=0,
            selected_candidates=0,
            unused_candidate_groups=group_count,
            warnings=reasons,
        ),
        failure_reasons=reasons,
    )


def _first_page_height(report: LayoutReport) -> float:
    return report.pages[0].used_height_mm if report.pages else 0.0


def _first_page_usage(report: LayoutReport) -> float:
    return report.pages[0].usage_ratio if report.pages else 0.0


def _total_usage_ratio(report: LayoutReport) -> float:
    available = report.page_available_height_mm
    if available <= 0:
        return 0.0
    return sum(value.used_height_mm for value in report.pages) / available
