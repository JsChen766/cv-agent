from datetime import date

from app.domain.resume.retrieval.models import RetrievalFact, RetrievalRequirement
from app.domain.resume.retrieval.service import rank_facts


def _requirement(
    requirement_id: str,
    description: str,
    keyword: str,
    *,
    weight: float = 1.0,
) -> RetrievalRequirement:
    return RetrievalRequirement(
        requirement_id=requirement_id,
        description=description,
        category="technology",
        keywords=(keyword,),
        importance="must_have",
        weight=weight,
    )


def _fact(
    fact_id: str,
    experience_id: str,
    text: str,
    *,
    technologies: tuple[str, ...] = (),
    strength: float = 0.5,
    end_year: int = 2020,
    embedding: tuple[float, ...] = (),
) -> RetrievalFact:
    return RetrievalFact(
        fact_id=fact_id,
        experience_id=experience_id,
        source_revision_id=f"rev-{experience_id}",
        source_revision_hash="hash",
        source_text=text,
        technologies=technologies,
        lexical_tokens=technologies,
        strength_score=strength,
        experience_category="work",
        experience_title=experience_id,
        end_date=date(end_year, 1, 1),
        embedding=embedding,
    )


def test_old_high_match_fact_beats_recent_low_match_fact() -> None:
    requirement = _requirement("req-python", "Python backend", "Python")
    old = _fact("fact-old", "exp-old", "Built Python APIs", technologies=("Python",), end_year=2018)
    recent = _fact("fact-new", "exp-new", "Coordinated weekly meetings", end_year=2026)

    result = rank_facts(
        [recent, old],
        [requirement],
        {
            old.fact_id: {requirement.requirement_id: 0.92},
            recent.fact_id: {requirement.requirement_id: 0.08},
        },
        max_candidates=2,
    )

    assert result.selected_fact_ids[0] == old.fact_id
    assert result.facts[0].score.recency < result.facts[1].score.recency


def test_marginal_coverage_prefers_complementary_fact_over_duplicate() -> None:
    python = _requirement("req-python", "Python backend", "Python")
    postgres = _requirement("req-postgres", "PostgreSQL", "PostgreSQL")
    first = _fact(
        "fact-python-1",
        "exp-a",
        "Built Python APIs",
        technologies=("Python",),
        embedding=(1.0, 0.0),
    )
    duplicate = _fact(
        "fact-python-2",
        "exp-a",
        "Developed Python services",
        technologies=("Python",),
        embedding=(0.99, 0.01),
    )
    complement = _fact(
        "fact-postgres",
        "exp-b",
        "Optimized PostgreSQL queries",
        technologies=("PostgreSQL",),
        embedding=(0.0, 1.0),
    )
    scores = {
        first.fact_id: {python.requirement_id: 0.95, postgres.requirement_id: 0.05},
        duplicate.fact_id: {python.requirement_id: 0.92, postgres.requirement_id: 0.05},
        complement.fact_id: {python.requirement_id: 0.05, postgres.requirement_id: 0.88},
    }

    result = rank_facts(
        [first, duplicate, complement],
        [python, postgres],
        scores,
        max_candidates=2,
    )

    assert set(result.selected_fact_ids) == {first.fact_id, complement.fact_id}
    rejected = next(value for value in result.facts if value.fact_id == duplicate.fact_id)
    assert "semantic_duplication" in rejected.rejection_reasons
    assert "repeated_source_penalty" in rejected.rejection_reasons


def test_all_zero_relevance_warns_and_disables_recency_signal() -> None:
    requirement = _requirement("req-rust", "Rust", "Rust")
    strong_old = _fact("fact-strong", "exp-old", "Led delivery", strength=0.9, end_year=2010)
    weak_new = _fact("fact-weak", "exp-new", "Helped team", strength=0.1, end_year=2026)

    result = rank_facts(
        [weak_new, strong_old],
        [requirement],
        {},
        max_candidates=2,
    )

    assert result.selected_fact_ids[0] == strong_old.fact_id
    assert set(result.diagnostics.warnings) == {
        "semantic_similarity_all_zero",
        "lexical_technology_match_all_zero",
        "uncovered_requirement_gain_all_zero",
    }
    assert all(value.score.recency == 0.0 for value in result.facts)
    assert all(
        "relevance_signals_unavailable_recency_disabled" in value.degradation_sources
        for value in result.facts
    )


def test_each_fact_keeps_score_breakdown_and_selection_reason() -> None:
    requirement = _requirement("req-k8s", "Kubernetes", "Kubernetes")
    facts = [
        _fact(f"fact-{index}", f"exp-{index}", "Operated k8s", technologies=("k8s",))
        for index in range(3)
    ]

    result = rank_facts(facts, [requirement], {}, max_candidates=1)

    assert len(result.facts) == 3
    assert result.facts[0].selection_reasons
    assert all(value.score.weighted_total >= 0 for value in result.facts)
    assert all(value.selection_reasons or value.rejection_reasons for value in result.facts)


def test_previously_dropped_older_experiences_enter_full_fact_evaluation() -> None:
    requirements = [
        _requirement("req-llm", "LLM model compliance", "LLM"),
        _requirement("req-cv", "3D computer vision tracking", "computer vision"),
        _requirement("req-dl", "Deep learning traffic analysis", "deep learning"),
    ]
    facts = [
        _fact("fact-recent-1", "exp-recent-1", "Coordinated delivery", end_year=2026),
        _fact("fact-recent-2", "exp-recent-2", "Prepared reports", end_year=2025),
        _fact(
            "fact-llm",
            "exp-old-llm",
            "Delivered LLM model compliance",
            technologies=("LLM",),
            end_year=2021,
        ),
        _fact(
            "fact-cv",
            "exp-old-cv",
            "Built 3D computer vision tracking",
            technologies=("computer vision",),
            end_year=2020,
        ),
        _fact(
            "fact-dl",
            "exp-old-dl",
            "Built deep learning traffic analysis",
            technologies=("deep learning",),
            end_year=2019,
        ),
    ]
    semantic = {
        "fact-llm": {"req-llm": 0.94},
        "fact-cv": {"req-cv": 0.91},
        "fact-dl": {"req-dl": 0.89},
    }

    result = rank_facts(facts, requirements, semantic, max_candidates=5)

    assert result.diagnostics.total_experiences == 5
    assert {"fact-llm", "fact-cv", "fact-dl"}.issubset(result.selected_fact_ids)
    assert {value.fact_id for value in result.facts} == {value.fact_id for value in facts}
