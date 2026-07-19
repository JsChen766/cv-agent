"""Deterministic benchmark for the stage-D full-FactBank sufficiency gate."""

from __future__ import annotations

import argparse
import statistics
import time
from datetime import date

from app.domain.resume.layout_service import ResumeLayoutService
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


def benchmark(*, fact_count: int, experience_count: int, iterations: int) -> dict[str, float]:
    experiences = tuple(
        RetrievalExperience(
            experience_id=f"exp-{index}",
            revision_id=f"rev-{index}",
            revision_hash="hash",
            title="Backend Engineer",
            organization=f"Example {index}",
            role="Engineer",
            category="work" if index % 3 else "project",
            start_date=date(2020, 1, 1),
            end_date=date(2025, 1, 1),
            tags=("Python", "PostgreSQL"),
            content="Built backend services and data pipelines.",
            factbank_status="ready",
        )
        for index in range(experience_count)
    )
    requirement = RetrievalRequirement(
        requirement_id="req-python",
        description="Python backend",
        category="technology",
        keywords=("Python",),
        importance="must_have",
        weight=1.0,
    )
    facts = tuple(
        RankedFact(
            fact_id=f"fact-{index}",
            experience_id=f"exp-{index % experience_count}",
            source_revision_id=f"rev-{index % experience_count}",
            source_text=(
                f"Built Python service module {index} with PostgreSQL and verified delivery"
            ),
            technologies=("Python", "PostgreSQL"),
            selected=index < 40,
            score=FactScoreBreakdown(
                semantic_similarity=0.8,
                lexical_technology_match=0.8,
                uncovered_requirement_gain=0.5,
                evidence_strength=0.8,
                recency=0.8,
                weighted_total=0.7,
            ),
            marginal_value=0.7,
            matched_requirement_ids=(requirement.requirement_id,),
        )
        for index in range(fact_count)
    )
    retrieval = HybridRetrievalResult(
        requirements=(requirement,),
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
    durations: list[float] = []
    for _ in range(iterations):
        service = MaterialSufficiencyService(ResumeLayoutService(PillowFontMetrics()))
        started_at = time.perf_counter()
        report = service.assess(
            retrieval,
            user_profile={"full_name": "Benchmark User", "email": "user@example.com"},
            minimum_usage_ratio=0.85,
            language="en-US",
        )
        assert report.total_facts == fact_count
        durations.append((time.perf_counter() - started_at) * 1000)
    return {"median_ms": statistics.median(durations), "max_ms": max(durations)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--facts", type=int, default=250)
    parser.add_argument("--experiences", type=int, default=30)
    parser.add_argument("--iterations", type=int, default=5)
    args = parser.parse_args()
    result = benchmark(
        fact_count=args.facts,
        experience_count=args.experiences,
        iterations=args.iterations,
    )
    print(
        f"facts={args.facts} experiences={args.experiences} "
        f"iterations={args.iterations} median_ms={result['median_ms']:.2f} "
        f"max_ms={result['max_ms']:.2f}"
    )


if __name__ == "__main__":
    main()
