from __future__ import annotations

import hashlib
import re
from typing import Literal

from app.domain.resume.candidates.models import (
    CandidateBatchDraft,
    CandidateBullet,
    CandidateGenerationDiagnostics,
    CandidateGroupDraft,
    CandidatePool,
    CandidateReusePlan,
    CandidateTextVariantDraft,
)
from app.domain.resume.grounding import (
    technology_vocabulary,
    unsupported_technologies,
)
from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.planning.models import ResumePlan
from app.domain.resume.retrieval.models import HybridRetrievalResult, RankedFact

_VARIANT_ORDER = {"short": 0, "medium": 1, "long": 2}
_NUMBER = re.compile(r"(?<!\d)\d+(?:[.,]\d+)?%?")


def plan_incremental_candidate_reuse(
    previous_plan: ResumePlan | None,
    previous_retrieval: HybridRetrievalResult | None,
    previous_candidates: tuple[CandidateBullet, ...],
    current_plan: ResumePlan,
    current_retrieval: HybridRetrievalResult,
    *,
    invalidated_experience_ids: tuple[str, ...] = (),
) -> CandidateReusePlan:
    """Partition candidates by revision, selected facts and requirement mapping."""
    current_fact_by_id = {value.fact_id: value for value in current_retrieval.facts}
    current_facts_by_experience = _selected_facts_by_experience(
        current_plan,
        current_fact_by_id,
    )
    narrative_experience_ids = tuple(
        experience_id
        for experience_id in current_plan.selected_experience_ids
        if current_facts_by_experience.get(experience_id)
    )
    if previous_plan is None or previous_retrieval is None or not previous_candidates:
        return CandidateReusePlan(
            mode="full",
            generation_experience_ids=narrative_experience_ids,
            generation_fact_ids=tuple(
                fact_id
                for fact_id in current_plan.selected_fact_ids
                if current_fact_by_id.get(fact_id) is not None
            ),
            invalidated_experience_ids=tuple(sorted(set(invalidated_experience_ids))),
            invalidation_reasons={
                experience_id: ("previous_candidate_snapshot_unavailable",)
                for experience_id in narrative_experience_ids
            },
        )

    previous_fact_by_id = {value.fact_id: value for value in previous_retrieval.facts}
    previous_facts_by_experience = _selected_facts_by_experience(
        previous_plan,
        previous_fact_by_id,
    )
    previous_revision_by_experience = {
        value.experience_id: value.revision_id for value in previous_retrieval.experiences
    }
    current_revision_by_experience = {
        value.experience_id: value.revision_id for value in current_retrieval.experiences
    }
    candidates_by_experience: dict[str, list[CandidateBullet]] = {}
    for candidate in previous_candidates:
        candidates_by_experience.setdefault(candidate.experience_id, []).append(candidate)

    explicitly_invalidated = set(invalidated_experience_ids)
    reusable: list[CandidateBullet] = []
    generation_experience_ids: list[str] = []
    generation_fact_ids: list[str] = []
    invalidation_reasons: dict[str, tuple[str, ...]] = {}
    for experience_id in narrative_experience_ids:
        current_fact_ids = current_facts_by_experience.get(experience_id, ())
        previous_fact_ids = previous_facts_by_experience.get(experience_id, ())
        reasons: list[str] = []
        if experience_id in explicitly_invalidated:
            reasons.append("experience_revision_invalidated")
        if previous_revision_by_experience.get(experience_id) != current_revision_by_experience.get(
            experience_id
        ):
            reasons.append("current_revision_changed")
        if previous_fact_ids != current_fact_ids:
            reasons.append("selected_fact_set_changed")
        if any(
            previous_plan.fact_requirement_map.get(fact_id, ())
            != current_plan.fact_requirement_map.get(fact_id, ())
            for fact_id in current_fact_ids
        ):
            reasons.append("fact_requirement_map_changed")

        experience_candidates = candidates_by_experience.get(experience_id, [])
        current_fact_set = set(current_fact_ids)
        eligible_candidates = [
            candidate
            for candidate in experience_candidates
            if candidate.source_fact_ids
            and set(candidate.source_fact_ids).issubset(current_fact_set)
            and all(
                current_fact_by_id[fact_id].source_revision_id
                == current_revision_by_experience.get(experience_id)
                for fact_id in candidate.source_fact_ids
                if fact_id in current_fact_by_id
            )
        ]
        represented_fact_ids = {
            fact_id for candidate in eligible_candidates for fact_id in candidate.source_fact_ids
        }
        if represented_fact_ids != current_fact_set:
            reasons.append("candidate_fact_coverage_changed")

        if reasons:
            generation_experience_ids.append(experience_id)
            generation_fact_ids.extend(current_fact_ids)
            invalidation_reasons[experience_id] = tuple(dict.fromkeys(reasons))
        else:
            reusable.extend(eligible_candidates)

    return CandidateReusePlan(
        mode="incremental",
        reusable_candidates=tuple(reusable),
        generation_experience_ids=tuple(generation_experience_ids),
        generation_fact_ids=tuple(generation_fact_ids),
        invalidated_experience_ids=tuple(sorted(explicitly_invalidated)),
        invalidation_reasons=invalidation_reasons,
    )


def _selected_facts_by_experience(
    plan: ResumePlan,
    fact_by_id: dict[str, RankedFact],
) -> dict[str, tuple[str, ...]]:
    result: dict[str, list[str]] = {}
    for fact_id in plan.selected_fact_ids:
        fact = fact_by_id.get(fact_id)
        if fact is not None:
            result.setdefault(fact.experience_id, []).append(fact_id)
    return {key: tuple(value) for key, value in result.items()}


class CandidatePoolService:
    """Validate, ground and measure one batch of model-written candidate bullets."""

    def __init__(self, layout: ResumeLayoutService) -> None:
        self._layout = layout

    def build(
        self,
        plan: ResumePlan,
        retrieval: HybridRetrievalResult,
        draft: CandidateBatchDraft | None,
        *,
        language: str,
        candidate_pool_target_ratio: float,
        candidate_pool_max_ratio: float = 1.35,
        physical_attempts: int,
        provider_protocol: str | None,
        provider_error_category: str | None = None,
    ) -> CandidatePool:
        fact_by_id = {value.fact_id: value for value in retrieval.facts}
        grounding_vocabulary = technology_vocabulary(plan, retrieval)
        experience_ids = set(plan.selected_experience_ids)
        selected_fact_ids = set(plan.selected_fact_ids)
        fact_order = {value: index for index, value in enumerate(plan.selected_fact_ids)}
        represented_facts: set[str] = set()
        accepted: list[CandidateGroupDraft] = []
        rejected_groups = 0
        rejected_variants = 0

        raw_groups = draft.groups if draft is not None else ()
        for group in raw_groups:
            normalized, invalid_variant_count = self._validate_group(
                group,
                fact_by_id=fact_by_id,
                selected_fact_ids=selected_fact_ids,
                selected_experience_ids=experience_ids,
                represented_facts=represented_facts,
                fact_requirement_map=plan.fact_requirement_map,
                technology_vocabulary=grounding_vocabulary,
            )
            rejected_variants += invalid_variant_count
            if normalized is None:
                rejected_groups += 1
                continue
            accepted.append(normalized)
            represented_facts.update(normalized.source_fact_ids)

        fallback_groups: list[CandidateGroupDraft] = []
        for fact_id in plan.selected_fact_ids:
            if fact_id in represented_facts:
                continue
            fact = fact_by_id.get(fact_id)
            if fact is None:
                continue
            fallback_groups.append(self._fallback_group(fact, plan))
            represented_facts.add(fact_id)

        groups = [*accepted, *fallback_groups]
        groups.sort(
            key=lambda value: (
                min(fact_order.get(fact_id, len(fact_order)) for fact_id in value.source_fact_ids),
                value.experience_id,
                value.source_fact_ids,
            )
        )
        candidates: list[CandidateBullet] = []
        logical_lines = 0
        for group in groups:
            group_id = _stable_id("candidate-group", *group.source_fact_ids)
            group_candidates: list[CandidateBullet] = []
            for variant in sorted(
                group.variants,
                key=lambda value: (_VARIANT_ORDER[value.length_variant], value.text),
            ):
                text = _clean_text(variant.text)
                if not text:
                    continue
                bullet_id = _stable_id(
                    "candidate",
                    group_id,
                    variant.length_variant,
                    text,
                )
                fit = self._layout.measure_bullet_fit(
                    text,
                    bullet_id=bullet_id,
                    item_id=group.experience_id,
                    section_type="experience",
                    language=language,
                )
                quality_score = _quality_score(group.source_fact_ids, fact_by_id)
                group_candidates.append(
                    CandidateBullet(
                        bullet_id=bullet_id,
                        candidate_group_id=group_id,
                        experience_id=group.experience_id,
                        text=text,
                        source_fact_ids=group.source_fact_ids,
                        covered_requirement_ids=group.covered_requirement_ids,
                        quality_score=quality_score,
                        estimated_lines=max(1, fit.line_count),
                        estimated_height_mm=round(
                            max(1, fit.line_count) * self._layout.profile.body.line_height_mm,
                            3,
                        ),
                        length_variant=variant.length_variant,
                    )
                )
            if not group_candidates:
                continue
            candidates.extend(group_candidates)
            logical_lines += max(value.estimated_lines for value in group_candidates)

        expected_final_lines = plan.target_candidate_lines / max(candidate_pool_target_ratio, 1.0)
        logical_pool_ratio = logical_lines / max(expected_final_lines, 1.0)
        warnings: list[str] = []
        if logical_pool_ratio + 1e-6 < 1.20:
            warnings.append("candidate_pool_under_target")
        if logical_pool_ratio - 1e-6 > candidate_pool_max_ratio:
            warnings.append("candidate_pool_over_target")
        if represented_facts != selected_fact_ids:
            warnings.append("selected_fact_missing_from_candidate_pool")
        if rejected_groups:
            warnings.append("invalid_model_candidate_groups_rejected")
        if rejected_variants:
            warnings.append("ungrounded_model_candidate_variants_rejected")

        if not accepted:
            generation_source: Literal["model", "mixed", "deterministic_fallback"] = (
                "deterministic_fallback"
            )
        elif fallback_groups:
            generation_source = "mixed"
        else:
            generation_source = "model"
        return CandidatePool(
            plan_version=plan.plan_version,
            candidates=tuple(candidates),
            diagnostics=CandidateGenerationDiagnostics(
                requested_facts=len(plan.selected_fact_ids),
                model_groups=len(raw_groups),
                accepted_model_groups=len(accepted),
                rejected_model_groups=rejected_groups,
                rejected_model_variants=rejected_variants,
                fallback_groups=len(fallback_groups),
                candidate_count=len(candidates),
                logical_candidate_lines=logical_lines,
                target_candidate_lines=plan.target_candidate_lines,
                logical_pool_ratio=round(logical_pool_ratio, 4),
                physical_attempts=physical_attempts,
                provider_protocol=provider_protocol,
                provider_error_category=provider_error_category,
                generation_source=generation_source,
                warnings=tuple(warnings),
            ),
        )

    @staticmethod
    def _validate_group(
        group: CandidateGroupDraft,
        *,
        fact_by_id: dict[str, RankedFact],
        selected_fact_ids: set[str],
        selected_experience_ids: set[str],
        represented_facts: set[str],
        fact_requirement_map: dict[str, tuple[str, ...]],
        technology_vocabulary: tuple[str, ...],
    ) -> tuple[CandidateGroupDraft | None, int]:
        fact_ids = tuple(dict.fromkeys(group.source_fact_ids))
        if (
            not fact_ids
            or group.experience_id not in selected_experience_ids
            or not set(fact_ids).issubset(selected_fact_ids)
            or set(fact_ids) & represented_facts
        ):
            return None, len(group.variants)
        facts = [fact_by_id.get(value) for value in fact_ids]
        if any(value is None or value.experience_id != group.experience_id for value in facts):
            return None, len(group.variants)
        grounded_facts = [value for value in facts if value is not None]
        allowed_numbers = {
            number for fact in grounded_facts for number in _NUMBER.findall(fact.source_text)
        }
        allowed_requirements = {
            requirement_id
            for fact_id in fact_ids
            for requirement_id in fact_requirement_map.get(fact_id, ())
        }
        source_text = "\n".join(value.source_text for value in grounded_facts)
        allowed_technologies = tuple(
            technology for fact in grounded_facts for technology in fact.technologies
        )
        covered = tuple(
            value
            for value in dict.fromkeys(group.covered_requirement_ids)
            if value in allowed_requirements
        )
        variants: list[CandidateTextVariantDraft] = []
        seen_variants: set[str] = set()
        rejected_variants = 0
        for variant in group.variants:
            text = _clean_text(variant.text)
            if (
                variant.length_variant in seen_variants
                or not text
                or not set(_NUMBER.findall(text)).issubset(allowed_numbers)
                or unsupported_technologies(
                    text,
                    source_text,
                    allowed_technologies,
                    technology_vocabulary,
                )
            ):
                rejected_variants += 1
                continue
            variants.append(variant.model_copy(update={"text": text}))
            seen_variants.add(variant.length_variant)
        if not variants:
            return None, rejected_variants
        return (
            group.model_copy(
                update={
                    "source_fact_ids": fact_ids,
                    "covered_requirement_ids": covered,
                    "variants": tuple(variants),
                }
            ),
            rejected_variants,
        )

    @staticmethod
    def _fallback_group(fact: RankedFact, plan: ResumePlan) -> CandidateGroupDraft:
        return CandidateGroupDraft(
            experience_id=fact.experience_id,
            source_fact_ids=(fact.fact_id,),
            covered_requirement_ids=plan.fact_requirement_map.get(fact.fact_id, ()),
            variants=(
                CandidateTextVariantDraft(
                    length_variant="medium",
                    text=_clean_text(fact.source_text),
                ),
            ),
        )


def _quality_score(fact_ids: tuple[str, ...], facts: dict[str, RankedFact]) -> float:
    values = [facts[value] for value in fact_ids if value in facts]
    if not values:
        return 0.0
    return round(
        sum(
            0.7 * value.score.weighted_total + 0.3 * value.score.evidence_strength
            for value in values
        )
        / len(values),
        6,
    )


def _clean_text(value: str) -> str:
    return value.strip().lstrip("- •·").rstrip("。．. ")


def _stable_id(prefix: str, *parts: str) -> str:
    digest = hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:20]
    return f"{prefix}-{digest}"
