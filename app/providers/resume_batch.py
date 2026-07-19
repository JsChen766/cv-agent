from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from app.domain.resume.candidates.models import CandidateBatchDraft
from app.domain.resume.planning.models import ResumePlan
from app.domain.resume.retrieval.models import HybridRetrievalResult
from app.providers.base import (
    LLMProvider,
    StructuredCallBudgetError,
    StructuredCallResult,
)

_SYSTEM_PROMPT = """\
You are a grounded resume bullet compiler. Return one JSON object matching the schema.

Write every requested experience in ONE batch response. Never choose experiences or facts: the
ResumePlan is authoritative. Every group must use only supplied fact IDs from exactly one
experience. covered_requirement_ids must be a subset of the fact_requirement_map for those facts.

For important grounded content, return short, medium, and long variants. All variants in one group
must express exactly the same source facts. A longer variant may add detail only when that detail is
present in the supplied source fact text; it must never add a number, technology, organization,
date, scope, result, or responsibility. Do not repeat a source fact in multiple groups. Do not end
bullet text with an English or Chinese full stop. Do not return contact details, education, skills,
section headings, summaries, or prose outside JSON.
"""


@dataclass(frozen=True, slots=True)
class ResumeBatchWriteResult:
    draft: CandidateBatchDraft | None
    attempts: int
    protocol: str | None
    error_category: str | None = None


class ResumeBatchWriter:
    """Provider adapter for the single complete resume-writing call."""

    def __init__(self, provider: LLMProvider) -> None:
        self._provider = provider

    async def write(
        self,
        plan: ResumePlan,
        retrieval: HybridRetrievalResult,
        *,
        language: str,
        tone: str,
        candidate_pool_target_ratio: float,
        candidate_pool_max_ratio: float,
        deadline_seconds: float,
        max_attempts: int,
        revision_instruction: str | None = None,
    ) -> ResumeBatchWriteResult:
        selected_fact_ids = set(plan.selected_fact_ids)
        selected_experience_ids = set(plan.selected_experience_ids)
        facts = [
            {
                "fact_id": value.fact_id,
                "experience_id": value.experience_id,
                "source_revision_id": value.source_revision_id,
                "source_text": value.source_text,
                "technologies": list(value.technologies),
                "strength_score": value.score.evidence_strength,
                "matched_requirement_ids": list(plan.fact_requirement_map.get(value.fact_id, ())),
            }
            for value in retrieval.facts
            if value.fact_id in selected_fact_ids
        ]
        experiences = [
            {
                "experience_id": value.experience_id,
                "title": value.title,
                "organization": value.organization,
                "role": value.role,
                "category": value.category,
                "start_date": value.start_date.isoformat() if value.start_date else None,
                "end_date": value.end_date.isoformat() if value.end_date else None,
                "target_height_mm": plan.experience_height_budgets_mm.get(value.experience_id),
            }
            for value in retrieval.experiences
            if value.experience_id in selected_experience_ids and value.category != "education"
        ]
        payload: dict[str, Any] = {
            "plan_version": plan.plan_version,
            "requirements": [value.model_dump(mode="json") for value in plan.requirements],
            "selected_experience_ids": list(plan.selected_experience_ids),
            "selected_fact_ids": list(plan.selected_fact_ids),
            "fact_requirement_map": plan.fact_requirement_map,
            "experience_height_budgets_mm": plan.experience_height_budgets_mm,
            "target_candidate_lines": plan.target_candidate_lines,
            "candidate_pool_ratio_band": {
                "minimum": candidate_pool_target_ratio,
                "maximum": candidate_pool_max_ratio,
            },
            "language": language,
            "tone": tone,
            "experiences": experiences,
            "facts": facts,
        }
        if revision_instruction:
            payload["revision_instruction"] = revision_instruction
        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ]
        bounded = getattr(self._provider, "chat_structured_bounded", None)
        if callable(bounded):
            try:
                # The bounded provider owns the single shared deadline. Wrapping it in
                # an equal outer timeout can win the cancellation race and erase the
                # provider's actual attempt count at the deadline boundary.
                result = await bounded(
                    messages,
                    CandidateBatchDraft,
                    temperature=0.2,
                    deadline_seconds=deadline_seconds,
                    max_attempts=max_attempts,
                )
            except asyncio.CancelledError:
                raise
            except StructuredCallBudgetError as exc:
                return ResumeBatchWriteResult(
                    draft=None,
                    attempts=exc.attempts,
                    protocol=exc.protocol,
                    error_category=exc.error_category,
                )
            except Exception as exc:  # the domain fallback must remain available
                return ResumeBatchWriteResult(
                    draft=None,
                    attempts=max_attempts,
                    protocol=None,
                    error_category=exc.__class__.__name__,
                )
            call = _coerce_bounded_result(result)
            try:
                draft = CandidateBatchDraft.model_validate(call.value)
            except Exception as exc:
                return ResumeBatchWriteResult(
                    draft=None,
                    attempts=call.attempts,
                    protocol=call.protocol,
                    error_category=exc.__class__.__name__,
                )
            return ResumeBatchWriteResult(
                draft=draft, attempts=call.attempts, protocol=call.protocol
            )

        # Compatibility for test/dummy providers. Production providers implement
        # chat_structured_bounded so their internal retry ladders cannot multiply.
        attempts = 0
        try:
            async with asyncio.timeout(deadline_seconds):
                while attempts < max_attempts:
                    attempts += 1
                    try:
                        value = await self._provider.chat_structured(
                            messages,
                            CandidateBatchDraft,
                            temperature=0.2,
                        )
                        return ResumeBatchWriteResult(
                            draft=CandidateBatchDraft.model_validate(value),
                            attempts=attempts,
                            protocol="compatibility_chat_structured",
                        )
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        if attempts >= max_attempts:
                            return ResumeBatchWriteResult(
                                draft=None,
                                attempts=attempts,
                                protocol="compatibility_chat_structured",
                                error_category=exc.__class__.__name__,
                            )
        except TimeoutError:
            return ResumeBatchWriteResult(
                draft=None,
                attempts=attempts,
                protocol="compatibility_chat_structured",
                error_category="TimeoutError",
            )
        return ResumeBatchWriteResult(
            draft=None,
            attempts=attempts,
            protocol="compatibility_chat_structured",
            error_category="attempt_budget_exhausted",
        )


def _coerce_bounded_result(value: object) -> StructuredCallResult:
    if isinstance(value, StructuredCallResult):
        return value
    return StructuredCallResult(value=value, attempts=1, protocol=None)
