"""Benchmark stage-F batch candidate validation and real font measurement."""

from __future__ import annotations

import argparse
import statistics
import time
from datetime import date

from app.domain.resume.candidates.models import CandidateBatchDraft
from app.domain.resume.candidates.service import CandidatePoolService
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


def benchmark(*, fact_count: int, experience_count: int, iterations: int) -> dict[str, float]:
    requirement = RetrievalRequirement(
        requirement_id="req-backend",
        description="Backend engineering",
        category="responsibility",
        keywords=("backend",),
        importance="must_have",
        weight=1.0,
    )
    experiences = tuple(
        RetrievalExperience(
            experience_id=f"exp-{index}",
            revision_id=f"rev-{index}",
            revision_hash=f"hash-{index}",
            title="Backend Engineer",
            organization=f"Example {index}",
            role="Engineer",
            category="project" if index == experience_count - 1 else "work",
            start_date=date(2020, 1, 1),
            end_date=date(2025, 1, 1),
            tags=("Python", "PostgreSQL"),
            content=f"Grounded experience {index}",
            factbank_status="ready",
        )
        for index in range(experience_count)
    )
    facts = tuple(
        RankedFact(
            fact_id=f"fact-{index}",
            experience_id=f"exp-{index % experience_count}",
            source_revision_id=f"rev-{index % experience_count}",
            source_text=(
                f"Designed grounded subsystem {index} with Python and PostgreSQL, "
                f"then verified delivery outcome {index} under production constraints"
            ),
            technologies=("Python", "PostgreSQL"),
            selected=True,
            score=FactScoreBreakdown(
                semantic_similarity=0.8,
                lexical_technology_match=0.8,
                uncovered_requirement_gain=0.5,
                evidence_strength=0.8,
                recency=0.7,
                weighted_total=0.75,
            ),
            marginal_value=0.75,
            matched_requirement_ids=("req-backend",),
        )
        for index in range(fact_count)
    )
    retrieval = HybridRetrievalResult(
        requirements=(requirement,),
        experiences=experiences,
        facts=facts,
        selected_fact_ids=tuple(value.fact_id for value in facts),
        diagnostics=RetrievalDiagnostics(
            total_experiences=experience_count,
            total_facts=fact_count,
            selected_facts=fact_count,
            ready_facts=fact_count,
            fallback_facts=0,
            ranking_version="benchmark",
        ),
    )
    plan = ResumePlan(
        plan_version="benchmark-plan",
        requirements=(requirement,),
        selected_experience_ids=tuple(value.experience_id for value in experiences),
        selected_fact_ids=tuple(value.fact_id for value in facts),
        fact_requirement_map={value.fact_id: ("req-backend",) for value in facts},
        section_height_budgets_mm={"work": 150.0, "project": 50.0},
        experience_height_budgets_mm={
            value.experience_id: 200.0 / experience_count for value in experiences
        },
        # The plan already stores the 120% candidate target, not the final
        # compiled line count. Each synthetic group measures as one logical line.
        target_candidate_lines=fact_count,
        target_final_usage_ratio=0.9,
        estimated_page_height_mm=250.0,
        estimated_usage_ratio=0.9,
        objective_score=0.8,
        selection_reasons={value.fact_id: ("selected",) for value in facts},
        rejection_reasons={},
    )
    draft = CandidateBatchDraft.model_validate(
        {
            "groups": [
                {
                    "experience_id": fact.experience_id,
                    "source_fact_ids": [fact.fact_id],
                    "covered_requirement_ids": ["req-backend"],
                    "variants": [
                        {"length_variant": "short", "text": fact.source_text},
                        {"length_variant": "medium", "text": fact.source_text},
                        {"length_variant": "long", "text": fact.source_text},
                    ],
                }
                for fact in facts
            ]
        }
    )
    service = CandidatePoolService(ResumeLayoutService(PillowFontMetrics()))
    model_durations: list[float] = []
    fallback_durations: list[float] = []
    candidate_count = 0
    pool_ratio = 0.0
    for _ in range(iterations):
        started = time.perf_counter()
        pool = service.build(
            plan,
            retrieval,
            draft,
            language="en-US",
            candidate_pool_target_ratio=1.2,
            candidate_pool_max_ratio=1.35,
            physical_attempts=1,
            provider_protocol="benchmark",
        )
        model_durations.append((time.perf_counter() - started) * 1000)
        candidate_count = len(pool.candidates)
        pool_ratio = pool.diagnostics.logical_pool_ratio

        started = time.perf_counter()
        service.build(
            plan,
            retrieval,
            None,
            language="en-US",
            candidate_pool_target_ratio=1.2,
            candidate_pool_max_ratio=1.35,
            physical_attempts=2,
            provider_protocol=None,
        )
        fallback_durations.append((time.perf_counter() - started) * 1000)
    return {
        "model_median_ms": statistics.median(model_durations),
        "model_max_ms": max(model_durations),
        "fallback_median_ms": statistics.median(fallback_durations),
        "fallback_max_ms": max(fallback_durations),
        "candidate_count": float(candidate_count),
        "pool_ratio": pool_ratio,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--facts", type=int, default=30)
    parser.add_argument("--experiences", type=int, default=5)
    parser.add_argument("--iterations", type=int, default=20)
    args = parser.parse_args()
    result = benchmark(
        fact_count=args.facts,
        experience_count=args.experiences,
        iterations=args.iterations,
    )
    print(
        f"facts={args.facts} experiences={args.experiences} iterations={args.iterations} "
        f"candidates={int(result['candidate_count'])} pool_ratio={result['pool_ratio']:.4f} "
        f"model_median_ms={result['model_median_ms']:.2f} "
        f"model_max_ms={result['model_max_ms']:.2f} "
        f"fallback_median_ms={result['fallback_median_ms']:.2f} "
        f"fallback_max_ms={result['fallback_max_ms']:.2f}"
    )


if __name__ == "__main__":
    main()
