from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from hashlib import blake2b

from app.domain.resume.planning.models import (
    PlannerDiagnostics,
    ResumePlan,
    ResumePlanningResult,
)
from app.domain.resume.retrieval.models import (
    HybridRetrievalResult,
    RankedFact,
    RetrievalExperience,
)
from app.domain.resume.sufficiency.models import (
    FactHeightEstimate,
    MaterialSufficiencyReport,
)

PLAN_VERSION = "bounded-height-beam-v1"
_WORD_RE = re.compile(r"[a-z0-9][a-z0-9+#./_-]*", re.IGNORECASE)
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")


@dataclass(frozen=True)
class _Candidate:
    fact: RankedFact
    experience: RetrievalExperience
    estimate: FactHeightEstimate
    normalized_source: str
    similarity_fingerprint: int
    technology_keys: frozenset[str]

    @property
    def section_key(self) -> str:
        return _section_key(self.experience.category)

    @property
    def base_value(self) -> float:
        return 0.7 * self.fact.score.weighted_total + 0.3 * self.fact.score.evidence_strength


@dataclass(frozen=True)
class _BeamState:
    selected_indexes: tuple[int, ...] = ()
    experience_ids: frozenset[str] = frozenset()
    section_keys: frozenset[str] = frozenset()
    covered_requirement_ids: frozenset[str] = frozenset()
    technologies: frozenset[str] = frozenset()
    normalized_sources: frozenset[str] = frozenset()
    fact_height_mm: float = 0.0
    overhead_height_mm: float = 0.0
    relevance_total: float = 0.0
    evidence_total: float = 0.0
    duplication_penalty: float = 0.0


class ResumePlanService:
    """Build the single authoritative fact and height plan without an LLM."""

    def __init__(
        self,
        *,
        beam_width: int = 128,
        max_optimizer_facts: int = 40,
        near_duplicate_threshold: float = 0.92,
    ) -> None:
        self._beam_width = beam_width
        self._max_optimizer_facts = max_optimizer_facts
        self._near_duplicate_threshold = near_duplicate_threshold

    def build(
        self,
        retrieval: HybridRetrievalResult,
        sufficiency: MaterialSufficiencyReport,
        *,
        minimum_usage_ratio: float,
        target_usage_ratio: float,
        maximum_usage_ratio: float,
        line_height_mm: float,
        candidate_pool_target_ratio: float,
    ) -> ResumePlanningResult:
        estimates = {value.fact_id: value for value in sufficiency.fact_estimates}
        experiences = {value.experience_id: value for value in retrieval.experiences}
        all_candidates = self._candidates(retrieval, estimates, experiences)
        all_candidates.sort(
            key=lambda value: (
                -value.base_value,
                -sum(
                    requirement.weight
                    for requirement in retrieval.requirements
                    if requirement.requirement_id in value.fact.matched_requirement_ids
                ),
                value.fact.fact_id,
            )
        )

        available_height = sufficiency.page_available_height_mm
        minimum_height = available_height * minimum_usage_ratio
        target_height = available_height * target_usage_ratio
        maximum_height = available_height * maximum_usage_ratio
        fixed_height = sufficiency.fixed_height.total_height_mm
        section_overheads = sufficiency.narrative_section_overheads_mm
        experience_overheads = {
            value.experience_id: value.overhead_height_mm
            for value in sufficiency.narrative_experience_estimates
        }
        work_required = any(value.experience.category == "work" for value in all_candidates)
        project_required = any(value.experience.category == "project" for value in all_candidates)
        requirement_weights = {
            value.requirement_id: value.weight for value in retrieval.requirements
        }
        candidates = self._optimizer_frontier(
            all_candidates,
            fixed_height=fixed_height,
            maximum_height=maximum_height,
            section_overheads=section_overheads,
            experience_overheads=experience_overheads,
        )

        beam = [_BeamState()]
        expanded_states = 0
        pruned_states = 0
        for index, candidate in enumerate(candidates):
            expanded = list(beam)
            for state in beam:
                included = self._include(
                    state,
                    index,
                    candidate,
                    candidates,
                    fixed_height=fixed_height,
                    maximum_height=maximum_height,
                    section_overheads=section_overheads,
                    experience_overheads=experience_overheads,
                )
                if included is not None:
                    expanded.append(included)
                    expanded_states += 1
            beam, pruned = self._prune(
                expanded,
                candidates,
                fixed_height=fixed_height,
                minimum_height=minimum_height,
                target_height=target_height,
                requirement_weights=requirement_weights,
                line_height_mm=line_height_mm,
            )
            pruned_states += pruned

        feasible = [
            state
            for state in beam
            if self._is_feasible(
                state,
                candidates,
                fixed_height=fixed_height,
                minimum_height=minimum_height,
                maximum_height=maximum_height,
                work_required=work_required,
                project_required=project_required,
            )
        ]
        diagnostics = PlannerDiagnostics(
            considered_facts=len(retrieval.facts),
            qualified_facts=len(all_candidates),
            optimizer_facts=len(candidates),
            expanded_states=expanded_states,
            pruned_states=pruned_states,
            final_beam_size=len(beam),
            beam_width=self._beam_width,
            work_required=work_required,
            project_required=project_required,
            minimum_height_mm=round(minimum_height, 3),
            target_height_mm=round(target_height, 3),
            maximum_height_mm=round(maximum_height, 3),
            maximum_reached_height_mm=round(
                max(
                    (self._page_height(state, fixed_height) for state in beam), default=fixed_height
                ),
                3,
            ),
            warnings=(
                ("dominated_candidates_pruned",) if len(candidates) < len(all_candidates) else ()
            ),
        )
        if not feasible:
            reasons = ["no_height_feasible_fact_combination"]
            if work_required:
                reasons.append("work_experience_constraint_unsatisfied")
            if project_required:
                reasons.append("project_experience_constraint_unsatisfied")
            return ResumePlanningResult(
                status="infeasible",
                diagnostics=diagnostics,
                failure_reasons=tuple(reasons),
            )

        best = max(
            feasible,
            key=lambda state: (
                self._objective(
                    state,
                    candidates,
                    fixed_height=fixed_height,
                    target_height=target_height,
                    minimum_height=minimum_height,
                    requirement_weights=requirement_weights,
                ),
                -abs(self._page_height(state, fixed_height) - target_height),
                tuple(candidates[index].fact.fact_id for index in state.selected_indexes),
            ),
        )
        return ResumePlanningResult(
            status="ready",
            plan=self._to_plan(
                best,
                candidates,
                all_candidates,
                retrieval,
                sufficiency,
                estimates,
                experiences,
                fixed_height=fixed_height,
                target_height=target_height,
                minimum_height=minimum_height,
                requirement_weights=requirement_weights,
                line_height_mm=line_height_mm,
                candidate_pool_target_ratio=candidate_pool_target_ratio,
            ),
            diagnostics=diagnostics,
        )

    @staticmethod
    def _candidates(
        retrieval: HybridRetrievalResult,
        estimates: dict[str, FactHeightEstimate],
        experiences: dict[str, RetrievalExperience],
    ) -> list[_Candidate]:
        result: list[_Candidate] = []
        for fact in retrieval.facts:
            estimate = estimates.get(fact.fact_id)
            experience = experiences.get(fact.experience_id)
            if estimate is None or not estimate.qualified or experience is None:
                continue
            if experience.category == "education":
                continue
            result.append(
                _Candidate(
                    fact=fact,
                    experience=experience,
                    estimate=estimate,
                    normalized_source=_normalize_source(fact.source_text),
                    similarity_fingerprint=_similarity_fingerprint(fact.source_text),
                    technology_keys=frozenset(value.casefold() for value in fact.technologies),
                )
            )
        return result

    def _optimizer_frontier(
        self,
        candidates: list[_Candidate],
        *,
        fixed_height: float,
        maximum_height: float,
        section_overheads: dict[str, float],
        experience_overheads: dict[str, float],
    ) -> list[_Candidate]:
        if len(candidates) <= self._max_optimizer_facts:
            return candidates
        mandatory_fact_ids: set[str] = set()
        seen_sections: set[str] = set()
        seen_requirements: set[str] = set()
        seen_experiences: set[str] = set()
        for candidate in candidates:
            if candidate.section_key not in seen_sections:
                mandatory_fact_ids.add(candidate.fact.fact_id)
                seen_sections.add(candidate.section_key)
            if candidate.experience.experience_id not in seen_experiences:
                mandatory_fact_ids.add(candidate.fact.fact_id)
                seen_experiences.add(candidate.experience.experience_id)
            for requirement_id in candidate.fact.matched_requirement_ids:
                if requirement_id not in seen_requirements:
                    mandatory_fact_ids.add(candidate.fact.fact_id)
                    seen_requirements.add(requirement_id)

        frontier: list[_Candidate] = []
        support_candidates: list[_Candidate] = []
        support_experiences: set[str] = set()
        support_sections: set[str] = set()
        required_sections = {
            section_key
            for section_key in ("work", "project")
            if any(candidate.section_key == section_key for candidate in candidates)
        }
        supported_height = fixed_height
        for candidate in candidates:
            must_keep = candidate.fact.fact_id in mandatory_fact_ids
            has_capacity = len(frontier) < self._max_optimizer_facts
            needs_height = supported_height < maximum_height
            needs_required_section = (
                candidate.section_key in required_sections
                and candidate.section_key not in support_sections
            )
            independently_selectable = all(
                candidate.normalized_source != selected.normalized_source
                and _fact_similarity(candidate, selected) < self._near_duplicate_threshold
                for selected in support_candidates
            )
            expands_supported_plan = independently_selectable and (
                needs_height or needs_required_section
            )
            if not (must_keep or has_capacity or expands_supported_plan):
                continue
            frontier.append(candidate)
            if not expands_supported_plan:
                continue
            support_candidates.append(candidate)
            experience_id = candidate.experience.experience_id
            if experience_id not in support_experiences:
                supported_height += experience_overheads.get(experience_id, 0.0)
                support_experiences.add(experience_id)
            if candidate.section_key not in support_sections:
                supported_height += section_overheads.get(candidate.section_key, 0.0)
                support_sections.add(candidate.section_key)
            supported_height += candidate.estimate.estimated_height_mm
        return frontier

    def _include(
        self,
        state: _BeamState,
        index: int,
        candidate: _Candidate,
        candidates: list[_Candidate],
        *,
        fixed_height: float,
        maximum_height: float,
        section_overheads: dict[str, float],
        experience_overheads: dict[str, float],
    ) -> _BeamState | None:
        if candidate.normalized_source in state.normalized_sources:
            return None
        maximum_similarity = max(
            (
                _fact_similarity(candidate, candidates[selected_index])
                for selected_index in state.selected_indexes
            ),
            default=0.0,
        )
        if maximum_similarity >= self._near_duplicate_threshold:
            return None
        new_experience = candidate.experience.experience_id not in state.experience_ids
        new_section = candidate.section_key not in state.section_keys
        overhead_increment = 0.0
        if new_experience:
            overhead_increment += experience_overheads.get(candidate.experience.experience_id, 0.0)
        if new_section:
            overhead_increment += section_overheads.get(candidate.section_key, 0.0)
        page_height = (
            fixed_height
            + state.fact_height_mm
            + state.overhead_height_mm
            + candidate.estimate.estimated_height_mm
            + overhead_increment
        )
        if page_height > maximum_height + 1e-6:
            return None
        duplicate_penalty = state.duplication_penalty
        if maximum_similarity > 0.55:
            duplicate_penalty += maximum_similarity - 0.55
        return _BeamState(
            selected_indexes=(*state.selected_indexes, index),
            experience_ids=state.experience_ids | {candidate.experience.experience_id},
            section_keys=state.section_keys | {candidate.section_key},
            covered_requirement_ids=state.covered_requirement_ids
            | set(candidate.fact.matched_requirement_ids),
            technologies=state.technologies | candidate.technology_keys,
            normalized_sources=state.normalized_sources | {candidate.normalized_source},
            fact_height_mm=state.fact_height_mm + candidate.estimate.estimated_height_mm,
            overhead_height_mm=state.overhead_height_mm + overhead_increment,
            relevance_total=state.relevance_total + candidate.fact.score.weighted_total,
            evidence_total=state.evidence_total + candidate.fact.score.evidence_strength,
            duplication_penalty=duplicate_penalty,
        )

    def _prune(
        self,
        states: list[_BeamState],
        candidates: list[_Candidate],
        *,
        fixed_height: float,
        minimum_height: float,
        target_height: float,
        requirement_weights: dict[str, float],
        line_height_mm: float,
    ) -> tuple[list[_BeamState], int]:
        best_by_bucket: dict[tuple[int, bool, bool, int], _BeamState] = {}
        sort_keys: dict[_BeamState, tuple[float, float, tuple[str, ...]]] = {}
        for state in states:
            height_bucket = int(
                max(0.0, self._page_height(state, fixed_height) - fixed_height)
                / max(line_height_mm, 0.1)
            )
            key = (
                height_bucket,
                "work" in state.section_keys,
                "project" in state.section_keys,
                len(state.covered_requirement_ids),
            )
            state_sort_key = self._state_sort_key(
                state,
                candidates,
                fixed_height,
                minimum_height,
                target_height,
                requirement_weights,
            )
            sort_keys[state] = state_sort_key
            previous = best_by_bucket.get(key)
            if previous is None or state_sort_key > sort_keys[previous]:
                best_by_bucket[key] = state
        unique = list(best_by_bucket.values())
        unique.sort(key=sort_keys.__getitem__, reverse=True)
        anchors: list[_BeamState] = []
        anchor_groups = (
            unique,
            [state for state in unique if "work" in state.section_keys],
            [state for state in unique if "project" in state.section_keys],
            [state for state in unique if {"work", "project"}.issubset(state.section_keys)],
        )
        for matching in anchor_groups:
            if matching:
                anchor = max(matching, key=lambda state: self._page_height(state, fixed_height))
                if anchor not in anchors:
                    anchors.append(anchor)
        anchor_set = set(anchors)
        retained = [state for state in unique if state not in anchor_set][
            : max(0, self._beam_width - len(anchors))
        ]
        retained.extend(anchors)
        retained.sort(key=sort_keys.__getitem__, reverse=True)
        return retained, max(0, len(states) - len(retained))

    def _state_sort_key(
        self,
        state: _BeamState,
        candidates: list[_Candidate],
        fixed_height: float,
        minimum_height: float,
        target_height: float,
        requirement_weights: dict[str, float],
    ) -> tuple[float, float, tuple[str, ...]]:
        height = self._page_height(state, fixed_height)
        return (
            self._objective(
                state,
                candidates,
                fixed_height=fixed_height,
                target_height=target_height,
                minimum_height=minimum_height,
                requirement_weights=requirement_weights,
            ),
            -abs(height - target_height),
            tuple(candidates[index].fact.fact_id for index in state.selected_indexes),
        )

    @staticmethod
    def _is_feasible(
        state: _BeamState,
        candidates: list[_Candidate],
        *,
        fixed_height: float,
        minimum_height: float,
        maximum_height: float,
        work_required: bool,
        project_required: bool,
    ) -> bool:
        height = fixed_height + state.fact_height_mm + state.overhead_height_mm
        return (
            minimum_height - 1e-6 <= height <= maximum_height + 1e-6
            and (not work_required or "work" in state.section_keys)
            and (not project_required or "project" in state.section_keys)
        )

    @staticmethod
    def _page_height(state: _BeamState, fixed_height: float) -> float:
        return fixed_height + state.fact_height_mm + state.overhead_height_mm

    @staticmethod
    def _objective(
        state: _BeamState,
        candidates: list[_Candidate],
        *,
        fixed_height: float,
        target_height: float,
        minimum_height: float,
        requirement_weights: dict[str, float],
    ) -> float:
        count = len(state.selected_indexes)
        if count:
            relevance = state.relevance_total / count
            evidence = state.evidence_total / count
        else:
            relevance = evidence = 0.0
        total_requirement_weight = sum(requirement_weights.values()) or 1.0
        coverage = (
            sum(requirement_weights.get(value, 0.0) for value in state.covered_requirement_ids)
            / total_requirement_weight
        )
        diversity = min(1.0, len(state.experience_ids) / 4.0)
        height = fixed_height + state.fact_height_mm + state.overhead_height_mm
        if height <= target_height:
            fill = min(1.0, height / max(target_height, 1.0))
        else:
            fill = max(
                0.0,
                1.0 - (height - target_height) / max(target_height - minimum_height, 1.0),
            )
        fragmentation = max(0, len(state.experience_ids) - 4) * 0.04
        return round(
            0.32 * relevance
            + 0.22 * coverage
            + 0.14 * evidence
            + 0.10 * diversity
            + 0.22 * fill
            - 0.12 * state.duplication_penalty
            - fragmentation,
            8,
        )

    def _to_plan(
        self,
        state: _BeamState,
        candidates: list[_Candidate],
        all_candidates: list[_Candidate],
        retrieval: HybridRetrievalResult,
        sufficiency: MaterialSufficiencyReport,
        estimates: dict[str, FactHeightEstimate],
        experiences: dict[str, RetrievalExperience],
        *,
        fixed_height: float,
        target_height: float,
        minimum_height: float,
        requirement_weights: dict[str, float],
        line_height_mm: float,
        candidate_pool_target_ratio: float,
    ) -> ResumePlan:
        selected = [candidates[index] for index in state.selected_indexes]
        selected_fact_ids = tuple(value.fact.fact_id for value in selected)
        selected_narrative_ids = {value.experience.experience_id for value in selected}
        education_ids = {
            value.experience_id for value in retrieval.experiences if value.category == "education"
        }
        selected_experience_ids = tuple(sorted(selected_narrative_ids | education_ids))

        section_budgets: dict[str, float] = {
            "contact": sufficiency.fixed_height.contact_height_mm,
            "education": sufficiency.fixed_height.education_height_mm,
            "skills": sufficiency.fixed_height.skills_height_mm,
        }
        fixed_adjustment = sufficiency.fixed_height.total_height_mm - sum(section_budgets.values())
        if abs(fixed_adjustment) > 1e-6:
            section_budgets["contact"] += fixed_adjustment
        experience_budgets: dict[str, float] = {}
        overheads = {
            value.experience_id: value.overhead_height_mm
            for value in sufficiency.narrative_experience_estimates
        }
        for experience_id in sorted(selected_narrative_ids):
            facts = [value for value in selected if value.experience.experience_id == experience_id]
            budget = overheads.get(experience_id, 0.0) + sum(
                value.estimate.estimated_height_mm for value in facts
            )
            experience_budgets[experience_id] = round(budget, 3)
            section_key = _section_key(experiences[experience_id].category)
            section_budgets[section_key] = section_budgets.get(section_key, 0.0) + budget
        for section_key in state.section_keys:
            section_budgets[section_key] = section_budgets.get(section_key, 0.0) + (
                sufficiency.narrative_section_overheads_mm.get(section_key, 0.0)
            )

        selection_reasons: dict[str, tuple[str, ...]] = {}
        rejection_reasons: dict[str, tuple[str, ...]] = {}
        for value in selected:
            selected_reasons = ["selected_by_bounded_height_search"]
            if value.fact.matched_requirement_ids:
                selected_reasons.append("adds_requirement_coverage")
            if value.fact.score.evidence_strength >= 0.5:
                selected_reasons.append("strong_grounded_evidence")
            selection_reasons[value.fact.fact_id] = tuple(selected_reasons)
        for experience_id in selected_narrative_ids:
            selection_reasons[experience_id] = ("contains_selected_fact",)
        for experience_id in education_ids:
            selection_reasons[experience_id] = ("fixed_education_content_preserved",)

        selected_set = set(selected_fact_ids)
        selected_candidates = [
            value for value in all_candidates if value.fact.fact_id in selected_set
        ]
        for fact in retrieval.facts:
            if fact.fact_id in selected_set:
                continue
            estimate = estimates.get(fact.fact_id)
            reasons: list[str] = []
            if estimate is None or not estimate.qualified:
                reasons.extend(estimate.exclusion_reasons if estimate is not None else ())
            else:
                candidate = next(
                    (value for value in all_candidates if value.fact.fact_id == fact.fact_id), None
                )
                if candidate is not None and any(
                    _fact_similarity(candidate, chosen) >= self._near_duplicate_threshold
                    for chosen in selected_candidates
                ):
                    reasons.append("near_duplicate_of_selected_fact")
                else:
                    reasons.append("lower_marginal_plan_utility")
            rejection_reasons[fact.fact_id] = tuple(reasons or ["not_selected"])
        for experience_id in experiences:
            if experience_id in selected_experience_ids:
                continue
            if not any(value.experience.experience_id == experience_id for value in all_candidates):
                rejection_reasons[experience_id] = ("no_qualified_narrative_fact",)
            else:
                rejection_reasons[experience_id] = ("lower_marginal_plan_utility",)

        estimated_height = self._page_height(state, fixed_height)
        target_fact_height = max(
            0.0,
            target_height - fixed_height - state.overhead_height_mm,
        )
        target_candidate_lines = math.ceil(
            target_fact_height / max(line_height_mm, 0.1) * candidate_pool_target_ratio
        )
        return ResumePlan(
            plan_version=PLAN_VERSION,
            requirements=retrieval.requirements,
            selected_experience_ids=selected_experience_ids,
            selected_fact_ids=selected_fact_ids,
            fact_requirement_map={
                value.fact.fact_id: value.fact.matched_requirement_ids for value in selected
            },
            section_height_budgets_mm={
                key: round(value, 3) for key, value in sorted(section_budgets.items())
            },
            experience_height_budgets_mm=experience_budgets,
            target_candidate_lines=target_candidate_lines,
            target_final_usage_ratio=round(target_height / sufficiency.page_available_height_mm, 4),
            estimated_page_height_mm=round(estimated_height, 3),
            estimated_usage_ratio=round(estimated_height / sufficiency.page_available_height_mm, 4),
            objective_score=self._objective(
                state,
                candidates,
                fixed_height=fixed_height,
                target_height=target_height,
                minimum_height=minimum_height,
                requirement_weights=requirement_weights,
            ),
            selection_reasons=selection_reasons,
            rejection_reasons=rejection_reasons,
        )


def _section_key(category: str) -> str:
    return category if category in {"work", "project"} else "other"


def _normalize_source(value: str) -> str:
    return "".join(unicodedata.normalize("NFKC", value).casefold().split())


def _similarity_tokens(value: str) -> set[str]:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    tokens = set(_WORD_RE.findall(normalized))
    for group in _CJK_RE.findall(normalized):
        if len(group) == 1:
            tokens.add(group)
        else:
            tokens.update(group[index : index + 2] for index in range(len(group) - 1))
    return tokens


def _fact_similarity(left: _Candidate, right: _Candidate) -> float:
    if left.normalized_source == right.normalized_source:
        return 1.0
    lexical = 1.0 - (
        (left.similarity_fingerprint ^ right.similarity_fingerprint).bit_count() / 64.0
    )
    technology_union = left.technology_keys | right.technology_keys
    technology = (
        len(left.technology_keys & right.technology_keys) / len(technology_union)
        if technology_union
        else 0.0
    )
    return min(1.0, 0.85 * lexical + 0.15 * technology)


def _similarity_fingerprint(value: str) -> int:
    weights = [0] * 64
    for token in sorted(_similarity_tokens(value)):
        digest = int.from_bytes(blake2b(token.encode("utf-8"), digest_size=8).digest())
        for bit in range(64):
            weights[bit] += 1 if digest & (1 << bit) else -1
    fingerprint = 0
    for bit, weight in enumerate(weights):
        if weight >= 0:
            fingerprint |= 1 << bit
    return fingerprint
