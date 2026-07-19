from __future__ import annotations

import hashlib
import re

from app.domain.resume.candidates.models import CandidateBullet, LengthVariant
from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.planning.models import ResumePlan
from app.domain.resume.quality.models import LocalRepairBatchDraft, LocalRepairResult
from app.domain.resume.quality.service import (
    _technology_vocabulary,
    _unsupported_technologies,
)
from app.domain.resume.retrieval.models import HybridRetrievalResult

_NUMBER = re.compile(r"(?<!\w)\d+(?:[.,]\d+)?%?")


class ResumeLocalCandidateRepairService:
    """Validate one atomic repair batch and return transient grounded candidates."""

    def __init__(self, layout: ResumeLayoutService) -> None:
        self._layout = layout

    def apply(
        self,
        plan: ResumePlan,
        retrieval: HybridRetrievalResult,
        candidates: tuple[CandidateBullet, ...],
        selected_candidate_ids: tuple[str, ...],
        repairable_bullet_ids: tuple[str, ...],
        draft: LocalRepairBatchDraft,
        *,
        language: str,
    ) -> LocalRepairResult:
        target_ids = set(repairable_bullet_ids)
        repair_ids = [value.bullet_id for value in draft.repairs]
        if (
            not target_ids
            or len(repair_ids) != len(set(repair_ids))
            or set(repair_ids) != target_ids
        ):
            return LocalRepairResult(
                status="rejected",
                candidates=candidates,
                rejection_reasons=("repair_target_mismatch",),
            )
        candidate_by_id = {value.bullet_id: value for value in candidates}
        selected_ids = set(selected_candidate_ids)
        if not target_ids.issubset(selected_ids) or not target_ids.issubset(candidate_by_id):
            return LocalRepairResult(
                status="rejected",
                candidates=candidates,
                rejection_reasons=("repair_target_not_selected",),
            )
        fact_by_id = {value.fact_id: value for value in retrieval.facts}
        technology_vocabulary = _technology_vocabulary(plan, retrieval)
        replacements: list[CandidateBullet] = []
        rejection_reasons: list[str] = []
        for repair in draft.repairs:
            original = candidate_by_id[repair.bullet_id]
            facts = [fact_by_id.get(value) for value in original.source_fact_ids]
            if any(
                value is None or value.experience_id != original.experience_id for value in facts
            ):
                rejection_reasons.append(f"{repair.bullet_id}:invalid_source_facts")
                continue
            grounded_facts = [value for value in facts if value is not None]
            source_text = "\n".join(value.source_text for value in grounded_facts)
            allowed_numbers = set(_NUMBER.findall(source_text))
            allowed_technologies = tuple(
                technology for fact in grounded_facts for technology in fact.technologies
            )
            valid_texts: list[tuple[str, int, int]] = []
            seen_texts: set[str] = set()
            for option in repair.candidates:
                text = option.text.strip()
                if (
                    option.source_fact_ids != original.source_fact_ids
                    or option.covered_requirement_ids != original.covered_requirement_ids
                    or not text
                    or text in seen_texts
                    or text.endswith((".", "。"))
                    or not set(_NUMBER.findall(text)).issubset(allowed_numbers)
                    or _unsupported_technologies(
                        text,
                        source_text,
                        allowed_technologies,
                        technology_vocabulary,
                    )
                ):
                    continue
                fit = self._layout.measure_bullet_fit(
                    text,
                    bullet_id=repair.bullet_id,
                    item_id=original.experience_id,
                    section_type="experience",
                    language=language,
                )
                if fit.status != "pass":
                    continue
                seen_texts.add(text)
                valid_texts.append((text, fit.line_count, len(text)))
            if not valid_texts:
                rejection_reasons.append(f"{repair.bullet_id}:no_valid_repair_candidate")
                continue
            valid_texts.sort(key=lambda value: (value[1], value[2], value[0]))
            variants = _variant_labels(len(valid_texts), original.length_variant)
            for index, ((text, line_count, _length), variant) in enumerate(
                zip(valid_texts, variants, strict=True)
            ):
                bullet_id = _stable_repair_id(original, variant, index, text)
                replacements.append(
                    original.model_copy(
                        update={
                            "bullet_id": bullet_id,
                            "text": text,
                            "estimated_lines": line_count,
                            "estimated_height_mm": round(
                                line_count * self._layout.profile.body.line_height_mm,
                                3,
                            ),
                            "length_variant": variant,
                        }
                    )
                )
        if rejection_reasons or not replacements:
            return LocalRepairResult(
                status="rejected",
                candidates=candidates,
                rejection_reasons=tuple(rejection_reasons or ["repair_batch_empty"]),
            )
        retained = tuple(value for value in candidates if value.bullet_id not in target_ids)
        repaired_pool = (*retained, *replacements)
        return LocalRepairResult(
            status="applied",
            candidates=repaired_pool,
            added_candidate_ids=tuple(value.bullet_id for value in replacements),
        )


def _variant_labels(count: int, fallback: LengthVariant) -> tuple[LengthVariant, ...]:
    if count == 1:
        return (fallback,)
    if count == 2:
        return ("short", "long")
    return ("short", "medium", "long")


def _stable_repair_id(
    original: CandidateBullet,
    variant: LengthVariant,
    index: int,
    text: str,
) -> str:
    digest = hashlib.sha256(
        "\x1f".join(
            (
                "local-repair-v2",
                original.candidate_group_id,
                original.bullet_id,
                variant,
                str(index),
                text,
            )
        ).encode("utf-8")
    ).hexdigest()[:24]
    return f"candidate-repair-{digest}"
