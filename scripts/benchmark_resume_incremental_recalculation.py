from __future__ import annotations

import argparse
import statistics
import time
from datetime import date

from app.domain.resume.candidates.service import (
    CandidatePoolService,
    plan_incremental_candidate_reuse,
)
from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.planning.models import ResumePlan
from app.domain.resume.retrieval.models import (
    FactScoreBreakdown,
    HybridRetrievalResult,
    RankedFact,
    RetrievalDiagnostics,
    RetrievalExperience,
    RetrievalRequirement,
)
from app.infra.layout import PillowFontMetrics


def _inputs(
    experience_count: int,
    facts_per_experience: int,
) -> tuple[ResumePlan, HybridRetrievalResult]:
    requirement = RetrievalRequirement(
        requirement_id="req-python",
        description="Python backend engineering",
        category="technology",
        keywords=("Python",),
        importance="must_have",
        weight=1.0,
    )
    experiences = tuple(
        RetrievalExperience(
            experience_id=f"exp-{experience_index}",
            revision_id=f"rev-{experience_index}",
            revision_hash=f"hash-{experience_index}",
            title=f"Backend Project {experience_index}",
            organization="Benchmark",
            role="Engineer",
            category="work" if experience_index == 0 else "project",
            start_date=date(2024, 1, 1),
            end_date=date(2025, 1, 1),
            tags=("Python",),
            content=f"Built grounded Python system {experience_index}",
            factbank_status="ready",
        )
        for experience_index in range(experience_count)
    )
    facts = tuple(
        RankedFact(
            fact_id=f"fact-{experience_index}-{fact_index}",
            experience_id=f"exp-{experience_index}",
            source_revision_id=f"rev-{experience_index}",
            source_text=(
                f"使用 Python 完成项目 {experience_index} 的模块 {fact_index} 设计、测试和交付"
            ),
            technologies=("Python",),
            selected=True,
            rank=experience_index * facts_per_experience + fact_index + 1,
            score=FactScoreBreakdown(
                semantic_similarity=0.9,
                lexical_technology_match=0.8,
                uncovered_requirement_gain=0.5,
                evidence_strength=0.8,
                recency=0.5,
                weighted_total=0.75,
            ),
            marginal_value=0.75,
            matched_requirement_ids=("req-python",),
        )
        for experience_index in range(experience_count)
        for fact_index in range(facts_per_experience)
    )
    fact_ids = tuple(value.fact_id for value in facts)
    retrieval = HybridRetrievalResult(
        requirements=(requirement,),
        experiences=experiences,
        facts=facts,
        selected_fact_ids=fact_ids,
        diagnostics=RetrievalDiagnostics(
            total_experiences=experience_count,
            total_facts=len(facts),
            selected_facts=len(facts),
            ready_facts=len(facts),
            fallback_facts=0,
            ranking_version="incremental-benchmark",
        ),
    )
    plan = ResumePlan(
        plan_version="incremental-benchmark-plan",
        requirements=(requirement,),
        selected_experience_ids=tuple(value.experience_id for value in experiences),
        selected_fact_ids=fact_ids,
        fact_requirement_map={value: ("req-python",) for value in fact_ids},
        section_height_budgets_mm={"work": 120.0, "project": 120.0},
        experience_height_budgets_mm={value.experience_id: 12.0 for value in experiences},
        target_candidate_lines=len(facts) * 2,
        target_final_usage_ratio=0.9,
        estimated_page_height_mm=250.0,
        estimated_usage_ratio=0.9,
        objective_score=1.0,
        selection_reasons={value: ("selected",) for value in fact_ids},
        rejection_reasons={},
    )
    return plan, retrieval


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark stage-I revision-aware candidate reuse partitioning."
    )
    parser.add_argument("--experiences", type=int, default=40)
    parser.add_argument("--facts-per-experience", type=int, default=3)
    parser.add_argument("--iterations", type=int, default=200)
    args = parser.parse_args()
    plan, retrieval = _inputs(args.experiences, args.facts_per_experience)
    pool = CandidatePoolService(ResumeLayoutService(PillowFontMetrics())).build(
        plan,
        retrieval,
        None,
        language="zh-CN",
        candidate_pool_target_ratio=1.2,
        physical_attempts=0,
        provider_protocol=None,
    )
    affected = "exp-0"
    timings: list[float] = []
    result = None
    for _ in range(args.iterations):
        started = time.perf_counter()
        result = plan_incremental_candidate_reuse(
            plan,
            retrieval,
            pool.candidates,
            plan,
            retrieval,
            invalidated_experience_ids=(affected,),
        )
        timings.append((time.perf_counter() - started) * 1000)
    if result is None:
        raise RuntimeError("Benchmark did not execute")
    expected_reused = (args.experiences - 1) * args.facts_per_experience
    if len(result.reusable_candidates) != expected_reused:
        raise RuntimeError("Unchanged candidate reuse count is incorrect")
    if result.generation_experience_ids != (affected,):
        raise RuntimeError("Incremental invalidation escaped the affected experience")
    print(
        " ".join(
            (
                f"experiences={args.experiences}",
                f"facts={len(retrieval.facts)}",
                f"candidates={len(pool.candidates)}",
                f"reused={len(result.reusable_candidates)}",
                f"regenerated_experiences={len(result.generation_experience_ids)}",
                f"regenerated_facts={len(result.generation_fact_ids)}",
                f"median_ms={statistics.median(timings):.3f}",
                f"max_ms={max(timings):.3f}",
            )
        )
    )


if __name__ == "__main__":
    main()
