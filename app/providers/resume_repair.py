from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from app.domain.resume.candidates.models import CandidateBullet
from app.domain.resume.compiler.models import CompiledResume
from app.domain.resume.quality.models import LocalRepairBatchDraft, QualityValidationReport
from app.domain.resume.retrieval.models import HybridRetrievalResult
from app.providers.base import LLMProvider, StructuredCallBudgetError, StructuredCallResult

_SYSTEM_PROMPT = """\
Repair only the supplied failing resume bullets in one structured batch. Return exactly one repair
entry for every bullet_id and no other IDs. Return at most three alternatives per bullet. Every
alternative must preserve source_fact_ids and covered_requirement_ids exactly and use only the
supplied source fact text. Never add or change numbers, technologies, organizations, dates, scope,
results, responsibilities, or requirement coverage. Fit the requested line and tail targets. Do not
return a resume, section, item, passing bullet, explanation, or prose outside the JSON object. Do
not end bullet text with an English or Chinese full stop.
"""


@dataclass(frozen=True, slots=True)
class ResumeLocalRepairWriteResult:
    draft: LocalRepairBatchDraft | None
    attempts: int
    protocol: str | None
    error_category: str | None = None


class ResumeLocalRepairWriter:
    """Provider adapter enforcing one physical local-repair request and one deadline."""

    def __init__(self, provider: LLMProvider) -> None:
        self._provider = provider

    async def write(
        self,
        quality: QualityValidationReport,
        candidates: tuple[CandidateBullet, ...],
        retrieval: HybridRetrievalResult,
        compiled: CompiledResume,
        *,
        language: str,
        deadline_seconds: float,
    ) -> ResumeLocalRepairWriteResult:
        candidate_by_id = {value.bullet_id: value for value in candidates}
        fact_by_id = {value.fact_id: value for value in retrieval.facts}
        fit_by_id = {value.bullet_id: value for value in compiled.layout_report.bullet_fits}
        issue_codes: dict[str, list[str]] = {}
        for issue in quality.issues:
            if issue.bullet_id is not None:
                issue_codes.setdefault(issue.bullet_id, []).append(issue.code)
        targets: list[dict[str, Any]] = []
        for bullet_id in quality.repairable_bullet_ids:
            candidate = candidate_by_id.get(bullet_id)
            if candidate is None:
                continue
            fit = fit_by_id.get(bullet_id)
            facts = [
                fact_by_id[fact_id]
                for fact_id in candidate.source_fact_ids
                if fact_id in fact_by_id
            ]
            targets.append(
                {
                    "bullet_id": bullet_id,
                    "current_text": candidate.text,
                    "failure_codes": sorted(set(issue_codes.get(bullet_id, ()))),
                    "experience_id": candidate.experience_id,
                    "source_fact_ids": list(candidate.source_fact_ids),
                    "covered_requirement_ids": list(candidate.covered_requirement_ids),
                    "source_facts": [
                        {
                            "fact_id": value.fact_id,
                            "source_text": value.source_text,
                            "technologies": list(value.technologies),
                        }
                        for value in facts
                    ],
                    "target": {
                        "language": language,
                        "current_line_count": fit.line_count if fit is not None else None,
                        "current_last_line_ratio": (
                            fit.last_line_ratio if fit is not None else None
                        ),
                        "minimum_last_line_ratio": (fit.gate_ratio if fit is not None else None),
                        "preferred_last_line_ratio": (
                            fit.target_ratio if fit is not None else None
                        ),
                    },
                }
            )
        if len(targets) != len(quality.repairable_bullet_ids):
            return ResumeLocalRepairWriteResult(
                draft=None,
                attempts=0,
                protocol=None,
                error_category="RepairTargetUnavailable",
            )
        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": json.dumps({"targets": targets}, ensure_ascii=False),
            },
        ]
        bounded = getattr(self._provider, "chat_structured_bounded", None)
        if callable(bounded):
            try:
                raw = await bounded(
                    messages,
                    LocalRepairBatchDraft,
                    temperature=0.1,
                    deadline_seconds=deadline_seconds,
                    max_attempts=1,
                )
            except asyncio.CancelledError:
                raise
            except StructuredCallBudgetError as exc:
                return ResumeLocalRepairWriteResult(
                    draft=None,
                    attempts=exc.attempts,
                    protocol=exc.protocol,
                    error_category=exc.error_category,
                )
            except Exception as exc:
                return ResumeLocalRepairWriteResult(
                    draft=None,
                    attempts=1,
                    protocol=None,
                    error_category=exc.__class__.__name__,
                )
            call = raw if isinstance(raw, StructuredCallResult) else StructuredCallResult(raw, 1)
            try:
                draft = LocalRepairBatchDraft.model_validate(call.value)
            except Exception as exc:
                return ResumeLocalRepairWriteResult(
                    draft=None,
                    attempts=call.attempts,
                    protocol=call.protocol,
                    error_category=exc.__class__.__name__,
                )
            return ResumeLocalRepairWriteResult(
                draft=draft,
                attempts=call.attempts,
                protocol=call.protocol,
            )

        try:
            async with asyncio.timeout(deadline_seconds):
                value = await self._provider.chat_structured(
                    messages,
                    LocalRepairBatchDraft,
                    temperature=0.1,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            return ResumeLocalRepairWriteResult(
                draft=None,
                attempts=1,
                protocol="compatibility_chat_structured",
                error_category=exc.__class__.__name__,
            )
        try:
            draft = LocalRepairBatchDraft.model_validate(value)
        except Exception as exc:
            return ResumeLocalRepairWriteResult(
                draft=None,
                attempts=1,
                protocol="compatibility_chat_structured",
                error_category=exc.__class__.__name__,
            )
        return ResumeLocalRepairWriteResult(
            draft=draft,
            attempts=1,
            protocol="compatibility_chat_structured",
        )
