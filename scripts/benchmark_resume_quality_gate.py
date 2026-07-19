from __future__ import annotations

import argparse
import statistics
import time
from collections import Counter
from datetime import date

from app.domain.resume.candidates.models import CandidateBullet
from app.domain.resume.compiler.service import ResumeLayoutCompiler
from app.domain.resume.layout_models import LayoutConstraint
from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.quality.service import ResumeQualityGateService
from app.domain.resume.retrieval.models import (
    FactScoreBreakdown,
    HybridRetrievalResult,
    RankedFact,
    RetrievalDiagnostics,
    RetrievalExperience,
    RetrievalRequirement,
)
from app.infra.layout import PillowFontMetrics
from scripts.benchmark_resume_layout_compiler import _inputs


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark stage-H deterministic validation after real-font compilation."
    )
    parser.add_argument("--groups", type=int, default=30)
    parser.add_argument("--experiences", type=int, default=5)
    parser.add_argument("--iterations", type=int, default=100)
    parser.add_argument("--max-repair-bullets", type=int, default=3)
    args = parser.parse_args()
    plan, candidates, scaffold = _inputs(args.groups, args.experiences)
    constraint = LayoutConstraint(
        max_pages=1,
        requested_pages=1,
        minimum_page_usage_ratio=0.85,
        target_page_usage_ratio=0.90,
        maximum_page_usage_ratio=0.98,
    )
    layout = ResumeLayoutService(PillowFontMetrics())
    compiled_result = ResumeLayoutCompiler(
        layout,
        beam_width=256,
        exact_candidate_limit=48,
    ).compile(
        plan,
        candidates,
        scaffold,
        constraint,
        template_id="resume-standard",
        language="zh-CN",
    )
    if compiled_result.compiled_resume is None:
        raise RuntimeError(f"compiler did not produce a resume: {compiled_result}")
    retrieval = _retrieval(plan.requirements, candidates, scaffold)
    gate = ResumeQualityGateService()
    durations: list[float] = []
    report = None
    for _ in range(args.iterations):
        started = time.perf_counter()
        report = gate.validate(
            plan,
            retrieval,
            candidates,
            compiled_result.compiled_resume,
            constraint,
            max_repair_bullets=args.max_repair_bullets,
        )
        durations.append((time.perf_counter() - started) * 1000)
    if report is None:
        raise RuntimeError("quality gate did not run")
    print(
        " ".join(
            (
                f"groups={args.groups}",
                f"candidates={len(candidates)}",
                f"selected={len(report.selected_candidate_ids)}",
                f"iterations={args.iterations}",
                f"status={report.status}",
                f"issues={len(report.issues)}",
                f"issue_codes={dict(Counter(value.code for value in report.issues))}",
                f"grounded={report.grounding.grounded_bullets}",
                f"must_have_coverage={report.coverage.must_have_coverage_ratio:.4f}",
                f"usage={report.page_usage_ratio:.4f}",
                f"median_ms={statistics.median(durations):.3f}",
                f"max_ms={max(durations):.3f}",
            )
        )
    )


def _retrieval(
    requirements: tuple[RetrievalRequirement, ...],
    candidates: tuple[CandidateBullet, ...],
    scaffold: dict[str, object],
) -> HybridRetrievalResult:
    candidate_by_fact = {
        fact_id: candidate for candidate in candidates for fact_id in candidate.source_fact_ids
    }
    source_by_fact = {
        fact_id: max(
            (candidate.text for candidate in candidates if fact_id in candidate.source_fact_ids),
            key=len,
        )
        for fact_id in candidate_by_fact
    }
    score = FactScoreBreakdown(
        semantic_similarity=0.9,
        lexical_technology_match=1.0,
        uncovered_requirement_gain=0.8,
        evidence_strength=0.9,
        recency=0.5,
        weighted_total=0.9,
    )
    facts = tuple(
        RankedFact(
            fact_id=fact_id,
            experience_id=candidate_by_fact[fact_id].experience_id,
            source_revision_id=f"rev-{candidate_by_fact[fact_id].experience_id}",
            source_text=source_by_fact[fact_id],
            technologies=("Python",),
            selected=True,
            rank=index + 1,
            score=score,
            marginal_value=1.0,
            matched_requirement_ids=candidate_by_fact[fact_id].covered_requirement_ids,
        )
        for index, fact_id in enumerate(sorted(candidate_by_fact))
    )
    experiences: list[RetrievalExperience] = []
    raw_sections = scaffold.get("sections")
    sections = raw_sections if isinstance(raw_sections, list) else []
    for section in sections:
        if not isinstance(section, dict):
            continue
        category = str(section.get("type") or "other")
        for item in section.get("items") or []:
            if not isinstance(item, dict):
                continue
            experience_id = str(item.get("source_experience_id") or "")
            if not experience_id:
                continue
            experiences.append(
                RetrievalExperience(
                    experience_id=experience_id,
                    revision_id=f"rev-{experience_id}",
                    revision_hash=f"hash-{experience_id}",
                    title=str(item.get("title") or ""),
                    organization=(str(item["organization"]) if item.get("organization") else None),
                    role=str(item["role"]) if item.get("role") else None,
                    category=category,
                    start_date=_date(item.get("start_date")),
                    end_date=_date(item.get("end_date")),
                    content="\n".join(
                        value.source_text for value in facts if value.experience_id == experience_id
                    ),
                    factbank_status="ready",
                )
            )
    return HybridRetrievalResult(
        requirements=requirements,
        experiences=tuple(experiences),
        facts=facts,
        selected_fact_ids=tuple(value.fact_id for value in facts),
        diagnostics=RetrievalDiagnostics(
            total_experiences=len(experiences),
            total_facts=len(facts),
            selected_facts=len(facts),
            ready_facts=len(facts),
            fallback_facts=0,
            ranking_version="stage-h-benchmark",
        ),
    )


def _date(value: object) -> date | None:
    if not isinstance(value, str) or not value:
        return None
    if len(value) == 7:
        value = f"{value}-01"
    return date.fromisoformat(value)


if __name__ == "__main__":
    main()
