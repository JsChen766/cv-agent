from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.domain.resume.candidates.models import CandidateBatchDraft
from app.domain.resume.planning.models import ResumePlan
from app.domain.resume.retrieval.models import HybridRetrievalResult, RankedFact
from app.providers.base import (
    LLMProvider,
    StructuredCallBudgetError,
    StructuredCallResult,
)

_SYSTEM_PROMPT = """\
You are a grounded resume writer responsible for exactly ONE resume experience. Return one compact
JSON object matching the schema. Write the complete bullet candidate pool for the supplied
experience; do not write any other experience or resume section.

The writing plan is authoritative. Return exactly one group per supplied fact, in the supplied order.
Every group must contain exactly that one fact ID and no fact may appear in another group. This is a
candidate pool: the layout compiler will choose among groups and variants. Focus on the assigned
primary JD requirements and avoid the themes owned by other experiences.

For every fact return one medium variant using the one-line character range. When the source fact
contains enough concrete detail, also return one long variant using the two-line character range.
The long variant is optional; never add padding or unsupported claims to reach it. Variants in one
group must express exactly the same fact. Preserve all numbers, technologies, organizations, dates,
scope, results, and responsibility levels from the source. Never invent or upgrade evidence. Count
visible Chinese characters including punctuation, not words. Every final rendered line must occupy
strictly more than 66.7% of the available A4 line width.
Do not end bullet text with an English or Chinese full stop. Return JSON only.
"""


@dataclass(frozen=True, slots=True)
class ResumeBatchWriteResult:
    draft: CandidateBatchDraft | None
    attempts: int
    protocol: str | None
    error_category: str | None = None


@dataclass(frozen=True, slots=True)
class _ExperienceWriteResult:
    experience_id: str
    draft: CandidateBatchDraft | None
    attempts: int
    protocol: str | None
    error_category: str | None = None


class ResumeBatchWriter:
    """Stream one complete candidate pool per experience with bounded concurrency."""

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
        max_concurrency: int = 3,
        first_token_timeout_seconds: float = 65.0,
        idle_timeout_seconds: float = 30.0,
        max_tokens_per_experience: int = 2600,
        on_experience_event: Callable[[str, str], None] | None = None,
        generation_experience_ids: tuple[str, ...] | None = None,
        revision_instructions: dict[str, str] | None = None,
    ) -> ResumeBatchWriteResult:
        selected_fact_ids = set(plan.selected_fact_ids)
        facts_by_experience: dict[str, list[RankedFact]] = {}
        for fact in retrieval.facts:
            if fact.fact_id in selected_fact_ids:
                facts_by_experience.setdefault(fact.experience_id, []).append(fact)
        for facts in facts_by_experience.values():
            facts.sort(key=lambda value: plan.selected_fact_ids.index(value.fact_id))

        experience_by_id = {
            value.experience_id: value
            for value in retrieval.experiences
            if value.category != "education"
        }
        experience_ids = tuple(
            value
            for value in plan.selected_experience_ids
            if value in experience_by_id
            and facts_by_experience.get(value)
            and (generation_experience_ids is None or value in generation_experience_ids)
        )
        if not experience_ids:
            return ResumeBatchWriteResult(
                draft=CandidateBatchDraft(groups=()),
                attempts=0,
                protocol=None,
            )

        requirement_owner = _assign_requirement_owners(plan, facts_by_experience)
        requirement_by_id = {value.requirement_id: value for value in plan.requirements}
        assignments = {
            experience_id: tuple(
                requirement_id
                for requirement_id, owner_id in requirement_owner.items()
                if owner_id == experience_id
            )
            for experience_id in experience_ids
        }
        semaphore = asyncio.Semaphore(max(1, max_concurrency))

        async def generate_one(experience_id: str) -> _ExperienceWriteResult:
            experience = experience_by_id[experience_id]
            facts = facts_by_experience[experience_id]
            relevant_requirement_ids = tuple(
                dict.fromkeys(
                    requirement_id
                    for fact in facts
                    for requirement_id in plan.fact_requirement_map.get(fact.fact_id, ())
                )
            )
            relevant_requirements = [
                requirement_by_id[value].model_dump(mode="json")
                for value in relevant_requirement_ids
                if value in requirement_by_id
            ]
            target_groups = len(facts)
            payload: dict[str, Any] = {
                "plan_version": plan.plan_version,
                "selected_experience_ids": [experience_id],
                "selected_fact_ids": [value.fact_id for value in facts],
                "experience": {
                    "experience_id": experience.experience_id,
                    "title": experience.title,
                    "organization": experience.organization,
                    "role": experience.role,
                    "category": experience.category,
                    "start_date": (
                        experience.start_date.isoformat() if experience.start_date else None
                    ),
                    "end_date": experience.end_date.isoformat() if experience.end_date else None,
                    "target_height_mm": plan.experience_height_budgets_mm.get(experience_id),
                },
                "facts": [
                    {
                        "fact_id": value.fact_id,
                        "experience_id": value.experience_id,
                        "source_revision_id": value.source_revision_id,
                        "source_text": value.source_text,
                        "technologies": list(value.technologies),
                        "strength_score": value.score.evidence_strength,
                        "matched_requirement_ids": list(
                            plan.fact_requirement_map.get(value.fact_id, ())
                        ),
                    }
                    for value in facts
                ],
                "requirements": relevant_requirements,
                "primary_requirement_ids": list(assignments.get(experience_id, ())),
                "other_experience_assignments": {
                    other_id: list(requirement_ids)
                    for other_id, requirement_ids in assignments.items()
                    if other_id != experience_id and requirement_ids
                },
                "fact_requirement_map": {
                    value.fact_id: list(plan.fact_requirement_map.get(value.fact_id, ()))
                    for value in facts
                },
                "target_bullet_groups": target_groups,
                "layout_contract": {
                    "page": "A4 portrait, exactly one page",
                    "minimum_page_usage_ratio": 0.85,
                    "minimum_last_line_ratio": 0.667,
                    "zh_one_line_visible_characters": [70, 100],
                    "zh_two_line_visible_characters": [170, 202],
                    "en_one_line_visible_characters": [110, 145],
                    "en_two_line_visible_characters": [250, 300],
                },
                "candidate_pool_ratio_band": {
                    "minimum": candidate_pool_target_ratio,
                    "maximum": candidate_pool_max_ratio,
                },
                "language": language,
                "tone": tone,
            }
            if revision_instruction:
                payload["revision_instruction"] = revision_instruction
            if revision_instructions and revision_instructions.get(experience_id):
                payload["measured_revision_instruction"] = revision_instructions[experience_id]
            messages = [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ]
            if on_experience_event is not None:
                on_experience_event(experience_id, "started")

            token_seen = False

            def on_token(_text: str) -> None:
                nonlocal token_seen
                if token_seen:
                    return
                token_seen = True
                if on_experience_event is not None:
                    on_experience_event(experience_id, "streaming")

            async with semaphore:
                result = await self._call_provider(
                    messages,
                    deadline_seconds=deadline_seconds,
                    max_attempts=max_attempts,
                    first_token_timeout_seconds=first_token_timeout_seconds,
                    idle_timeout_seconds=idle_timeout_seconds,
                    max_tokens=max_tokens_per_experience,
                    on_token=on_token,
                )
            if result.draft is None:
                if on_experience_event is not None:
                    on_experience_event(experience_id, "failed")
                return _ExperienceWriteResult(
                    experience_id=experience_id,
                    draft=None,
                    attempts=result.attempts,
                    protocol=result.protocol,
                    error_category=result.error_category,
                )

            allowed_fact_ids = {value.fact_id for value in facts}
            normalized_groups = tuple(
                group.model_copy(update={"experience_id": experience_id})
                for group in result.draft.groups
                if set(group.source_fact_ids).issubset(allowed_fact_ids)
            )
            if on_experience_event is not None:
                on_experience_event(experience_id, "completed")
            return _ExperienceWriteResult(
                experience_id=experience_id,
                draft=CandidateBatchDraft(groups=normalized_groups),
                attempts=result.attempts,
                protocol=result.protocol,
                error_category=result.error_category,
            )

        results = await asyncio.gather(*(generate_one(value) for value in experience_ids))
        groups = tuple(
            group for result in results if result.draft is not None for group in result.draft.groups
        )
        protocols = tuple(dict.fromkeys(value.protocol for value in results if value.protocol))
        failures = {
            value.experience_id: value.error_category for value in results if value.error_category
        }
        return ResumeBatchWriteResult(
            draft=CandidateBatchDraft(groups=groups),
            attempts=sum(value.attempts for value in results),
            protocol="+".join(protocols) or None,
            error_category=(
                ";".join(f"{key}:{value}" for key, value in sorted(failures.items()))
                if failures
                else None
            ),
        )

    async def _call_provider(
        self,
        messages: list[dict[str, str]],
        *,
        deadline_seconds: float,
        max_attempts: int,
        first_token_timeout_seconds: float,
        idle_timeout_seconds: float,
        max_tokens: int,
        on_token: Callable[[str], None],
    ) -> ResumeBatchWriteResult:
        streaming = getattr(self._provider, "chat_structured_stream_bounded", None)
        bounded = getattr(self._provider, "chat_structured_bounded", None)
        try:
            if callable(streaming):
                raw = await streaming(
                    messages,
                    CandidateBatchDraft,
                    temperature=0.2,
                    first_token_timeout_seconds=first_token_timeout_seconds,
                    idle_timeout_seconds=idle_timeout_seconds,
                    deadline_seconds=deadline_seconds,
                    max_attempts=max_attempts,
                    max_tokens=max_tokens,
                    on_token=on_token,
                )
            elif callable(bounded):
                raw = await bounded(
                    messages,
                    CandidateBatchDraft,
                    temperature=0.2,
                    deadline_seconds=deadline_seconds,
                    max_attempts=max_attempts,
                )
            else:
                async with asyncio.timeout(deadline_seconds):
                    value = await self._provider.chat_structured(
                        messages,
                        CandidateBatchDraft,
                        temperature=0.2,
                    )
                raw = StructuredCallResult(
                    value=value,
                    attempts=1,
                    protocol="compatibility_chat_structured",
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
        except Exception as exc:
            return ResumeBatchWriteResult(
                draft=None,
                attempts=1,
                protocol=None,
                error_category=exc.__class__.__name__,
            )
        call = raw if isinstance(raw, StructuredCallResult) else StructuredCallResult(raw, 1)
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
            draft=draft,
            attempts=call.attempts,
            protocol=call.protocol,
        )


def _assign_requirement_owners(
    plan: ResumePlan,
    facts_by_experience: dict[str, list[RankedFact]],
) -> dict[str, str]:
    """Give each requirement one primary experience before parallel writing starts."""
    experience_order = {
        experience_id: index for index, experience_id in enumerate(plan.selected_experience_ids)
    }
    owner_by_requirement: dict[str, str] = {}
    for requirement in plan.requirements:
        scores: list[tuple[float, int, str]] = []
        for experience_id, facts in facts_by_experience.items():
            score = sum(
                fact.score.weighted_total
                for fact in facts
                if requirement.requirement_id in plan.fact_requirement_map.get(fact.fact_id, ())
            )
            if score > 0:
                scores.append(
                    (
                        -score,
                        experience_order.get(experience_id, len(experience_order)),
                        experience_id,
                    )
                )
        if scores:
            owner_by_requirement[requirement.requirement_id] = min(scores)[2]
    return owner_by_requirement
