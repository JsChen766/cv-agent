"""Benchmark the stage-E ResumePlan search with real font measurements."""

from __future__ import annotations

import argparse
import statistics
import time
from datetime import date

from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.planning.service import ResumePlanService
from app.domain.resume.retrieval.models import (
    FactScoreBreakdown,
    HybridRetrievalResult,
    RankedFact,
    RetrievalDiagnostics,
    RetrievalExperience,
    RetrievalRequirement,
)
from app.domain.resume.sufficiency.service import MaterialSufficiencyService
from app.infra.layout import PillowFontMetrics

_FACT_TEMPLATES = (
    "Designed API gateway {index} with Python and reduced p95 latency by {metric}%.",
    "Migrated ledger shard {index} to PostgreSQL while preserving audit history {domain}.",
    "Automated release pipeline {index}; cut rollback recovery time by {metric}%.",
    "Profiled worker queue {domain} and removed contention across {metric} concurrent jobs.",
    "Built access-control service {index} with tenant isolation and traceable approvals.",
    "Reworked cache policy {domain}, lowering database load by {metric}% during peak traffic.",
    "Led incident review {index} and introduced safeguards for failure mode {domain}.",
    "Implemented event contract {domain} and verified replay correctness over batch {index}.",
    "Consolidated observability signals {index} into actionable SLO alerts for domain {domain}.",
    "Hardened payment workflow {domain} with idempotency checks covering scenario {index}.",
    "Created data reconciliation job {index} and resolved {metric}% of unmatched records.",
    "Optimized search index {domain} to sustain benchmark tier {index} without stale reads.",
    "Delivered partner integration {index} using signed callbacks and bounded retry policy.",
    "Modeled capacity for region {domain} and deferred {metric}% of planned infrastructure cost.",
    "Simplified onboarding flow {index} through reusable validation rules for cohort {domain}.",
    "Documented service boundary {domain} and enabled team {index} to ship independently.",
)


def _fact_source(index: int) -> str:
    return _FACT_TEMPLATES[index % len(_FACT_TEMPLATES)].format(
        index=index,
        metric=20 + index % 61,
        domain=index % 37,
    )


def benchmark(
    *, fact_count: int, experience_count: int, iterations: int, beam_width: int
) -> dict[str, float]:
    experiences = tuple(
        RetrievalExperience(
            experience_id=f"exp-{index}",
            revision_id=f"rev-{index}",
            revision_hash="hash",
            title="Backend Engineer" if index % 3 else "Platform Project",
            organization=f"Example {index}",
            role="Engineer",
            category="project" if index % 3 == 0 else "work",
            start_date=date(2020, 1, 1),
            end_date=date(2025, 1, 1),
            tags=("Python", "PostgreSQL"),
            content=f"Delivered system {index}.",
            factbank_status="ready",
        )
        for index in range(experience_count)
    )
    requirements = tuple(
        RetrievalRequirement(
            requirement_id=f"req-{index}",
            description=f"Backend capability {index}",
            category="technology",
            keywords=("Python", f"Capability-{index}"),
            importance="must_have" if index < 3 else "preferred",
            weight=1.0 if index < 3 else 0.6,
        )
        for index in range(8)
    )
    facts = tuple(
        RankedFact(
            fact_id=f"fact-{index}",
            experience_id=f"exp-{index % experience_count}",
            source_revision_id=f"rev-{index % experience_count}",
            source_text=_fact_source(index),
            technologies=("Python", f"Module-{index % 20}"),
            selected=index < 40,
            score=FactScoreBreakdown(
                semantic_similarity=0.55 + (index % 5) * 0.08,
                lexical_technology_match=0.7,
                uncovered_requirement_gain=0.5,
                evidence_strength=0.65 + (index % 3) * 0.1,
                recency=0.8,
                weighted_total=0.55 + (index % 5) * 0.07,
            ),
            marginal_value=0.7,
            matched_requirement_ids=(f"req-{index % len(requirements)}",),
        )
        for index in range(fact_count)
    )
    retrieval = HybridRetrievalResult(
        requirements=requirements,
        experiences=experiences,
        facts=facts,
        selected_fact_ids=tuple(value.fact_id for value in facts if value.selected),
        diagnostics=RetrievalDiagnostics(
            total_experiences=experience_count,
            total_facts=fact_count,
            selected_facts=min(40, fact_count),
            ready_facts=fact_count,
            fallback_facts=0,
            ranking_version="benchmark",
        ),
    )
    layout = ResumeLayoutService(PillowFontMetrics())
    sufficiency_service = MaterialSufficiencyService(layout)
    planner = ResumePlanService(beam_width=beam_width)

    planner_durations: list[float] = []
    combined_durations: list[float] = []
    selected_facts = 0
    usage_ratio = 0.0
    for _ in range(iterations):
        combined_started = time.perf_counter()
        sufficiency = sufficiency_service.assess(
            retrieval,
            user_profile={"full_name": "Benchmark User", "email": "user@example.com"},
            minimum_usage_ratio=0.85,
            language="en-US",
        )
        planner_started = time.perf_counter()
        result = planner.build(
            retrieval,
            sufficiency,
            minimum_usage_ratio=0.85,
            target_usage_ratio=0.90,
            maximum_usage_ratio=0.98,
            line_height_mm=layout.profile.body.line_height_mm,
            candidate_pool_target_ratio=1.2,
        )
        planner_durations.append((time.perf_counter() - planner_started) * 1000)
        combined_durations.append((time.perf_counter() - combined_started) * 1000)
        if result.plan is None:
            raise RuntimeError(
                "Planner benchmark was infeasible: "
                f"reasons={result.failure_reasons} "
                f"fixed_height={sufficiency.fixed_height.total_height_mm} "
                f"global_height={sufficiency.global_supported_height_mm} "
                f"diagnostics={result.diagnostics.model_dump()}"
            )
        selected_facts = len(result.plan.selected_fact_ids)
        usage_ratio = result.plan.estimated_usage_ratio
    return {
        "planner_median_ms": statistics.median(planner_durations),
        "planner_max_ms": max(planner_durations),
        "combined_median_ms": statistics.median(combined_durations),
        "combined_max_ms": max(combined_durations),
        "selected_facts": float(selected_facts),
        "usage_ratio": usage_ratio,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--facts", type=int, default=250)
    parser.add_argument("--experiences", type=int, default=30)
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--beam-width", type=int, default=128)
    args = parser.parse_args()
    result = benchmark(
        fact_count=args.facts,
        experience_count=args.experiences,
        iterations=args.iterations,
        beam_width=args.beam_width,
    )
    print(
        f"facts={args.facts} experiences={args.experiences} iterations={args.iterations} "
        f"beam_width={args.beam_width} "
        f"planner_median_ms={result['planner_median_ms']:.2f} "
        f"planner_max_ms={result['planner_max_ms']:.2f} "
        f"combined_median_ms={result['combined_median_ms']:.2f} "
        f"combined_max_ms={result['combined_max_ms']:.2f} "
        f"selected_facts={int(result['selected_facts'])} "
        f"usage_ratio={result['usage_ratio']:.4f}"
    )


if __name__ == "__main__":
    main()
