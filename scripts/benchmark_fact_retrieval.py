"""Deterministic synthetic benchmark for the stage-C domain ranker."""

from __future__ import annotations

import argparse
import statistics
import time
from datetime import date

from app.domain.resume.retrieval.models import RetrievalFact, RetrievalRequirement
from app.domain.resume.retrieval.service import rank_facts


def benchmark(
    *,
    fact_count: int,
    requirement_count: int,
    dimensions: int,
    iterations: int,
) -> dict[str, float]:
    requirements = [
        RetrievalRequirement(
            requirement_id=f"req-{index}",
            description=f"Python technology {index}",
            category="technology",
            keywords=("Python", f"tech{index}"),
            importance="must_have" if index < 5 else "preferred",
            weight=1.0 if index < 5 else 0.6,
        )
        for index in range(requirement_count)
    ]
    facts = [
        RetrievalFact(
            fact_id=f"fact-{index}",
            experience_id=f"exp-{index % 80}",
            source_revision_id=f"rev-{index % 80}",
            source_revision_hash="hash",
            source_text=(
                f"Built Python tech{index % requirement_count} service with metric {index}"
            ),
            technologies=("Python", f"tech{index % requirement_count}"),
            lexical_tokens=("python", f"tech{index % requirement_count}"),
            strength_score=0.8,
            experience_category="work",
            experience_title="Engineer",
            end_date=date(2024, 1, 1),
            embedding=tuple(
                1.0 if position == index % dimensions else 0.0 for position in range(dimensions)
            ),
        )
        for index in range(fact_count)
    ]
    semantic = {
        fact.fact_id: {
            requirement.requirement_id: (
                0.9 if requirement_index == fact_index % requirement_count else 0.1
            )
            for requirement_index, requirement in enumerate(requirements)
        }
        for fact_index, fact in enumerate(facts)
    }
    durations: list[float] = []
    for _ in range(iterations):
        started_at = time.perf_counter()
        result = rank_facts(
            facts,
            requirements,
            semantic,
            max_candidates=40,
        )
        assert result.diagnostics.total_facts == fact_count
        durations.append((time.perf_counter() - started_at) * 1000)
    return {
        "median_ms": statistics.median(durations),
        "max_ms": max(durations),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--facts", type=int, default=1000)
    parser.add_argument("--requirements", type=int, default=20)
    parser.add_argument("--dimensions", type=int, default=512)
    parser.add_argument("--iterations", type=int, default=5)
    args = parser.parse_args()
    result = benchmark(
        fact_count=args.facts,
        requirement_count=args.requirements,
        dimensions=args.dimensions,
        iterations=args.iterations,
    )
    print(
        f"facts={args.facts} requirements={args.requirements} dimensions={args.dimensions} "
        f"iterations={args.iterations} "
        f"median_ms={result['median_ms']:.2f} max_ms={result['max_ms']:.2f}"
    )


if __name__ == "__main__":
    main()
