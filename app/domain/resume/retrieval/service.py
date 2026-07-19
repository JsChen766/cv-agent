from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Iterable
from datetime import date

from app.domain.resume.retrieval.models import (
    FactScoreBreakdown,
    HybridRetrievalResult,
    RankedFact,
    RetrievalDiagnostics,
    RetrievalFact,
    RetrievalRequirement,
)

RANKING_VERSION = "hybrid-fact-ranking-v1"
_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9+#./_-]*", re.IGNORECASE)
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")
_ALIASES = (
    frozenset({"js", "javascript"}),
    frozenset({"ts", "typescript"}),
    frozenset({"postgres", "postgresql", "pgsql"}),
    frozenset({"k8s", "kubernetes"}),
    frozenset({"ai", "人工智能"}),
    frozenset({"llm", "大语言模型", "大模型"}),
    frozenset({"ml", "machinelearning", "机器学习"}),
    frozenset({"dl", "deeplearning", "深度学习"}),
    frozenset({"cv", "computervision", "计算机视觉"}),
    frozenset({"nlp", "naturallanguageprocessing", "自然语言处理"}),
)


def rank_facts(
    facts: list[RetrievalFact],
    requirements: list[RetrievalRequirement],
    semantic_scores: dict[str, dict[str, float]],
    *,
    max_candidates: int,
    semantic_match_threshold: float = 0.45,
    embedding_cache_hits: int = 0,
    embedding_cache_misses: int = 0,
) -> HybridRetrievalResult:
    """Rank the complete FactBank before any experience-level projection."""
    requirement_signals = [
        (value, _expanded_tokens((*value.keywords, value.description))) for value in requirements
    ]
    prepared = [
        _prepare_fact(
            fact,
            requirement_signals,
            semantic_scores.get(fact.fact_id, {}),
            semantic_match_threshold,
        )
        for fact in facts
    ]
    warnings: list[str] = []
    if facts and all(item.semantic == 0.0 for item in prepared):
        warnings.append("semantic_similarity_all_zero")
    if facts and all(item.lexical == 0.0 for item in prepared):
        warnings.append("lexical_technology_match_all_zero")
    if facts and all(not item.matched_requirement_ids for item in prepared):
        warnings.append("uncovered_requirement_gain_all_zero")

    relevance_blind = bool(facts) and all(
        item.semantic == 0.0 and item.lexical == 0.0 for item in prepared
    )
    selected: list[_PreparedFact] = []
    selected_rows: list[RankedFact] = []
    remaining = {item.fact.fact_id: item for item in prepared}
    covered_requirements: set[str] = set()
    covered_technologies: set[str] = set()
    source_counts: dict[str, int] = {}
    max_duplication_by_fact = {item.fact.fact_id: 0.0 for item in prepared}
    requirement_weights = {item.requirement_id: item.weight for item in requirements}
    total_requirement_weight = sum(requirement_weights.values()) or 1.0
    candidate_limit = min(max(0, max_candidates), len(prepared))

    while remaining and len(selected) < candidate_limit:
        evaluated = [
            _evaluate_marginal(
                item,
                requirement_weights,
                total_requirement_weight,
                covered_requirements,
                covered_technologies,
                source_counts,
                max_duplication_by_fact[item.fact.fact_id],
                relevance_blind=relevance_blind,
            )
            for item in remaining.values()
        ]
        evaluated.sort(key=lambda value: (-value.marginal_value, value.item.fact.fact_id))
        best = evaluated[0]
        item = best.item
        selected.append(item)
        covered_requirements.update(item.matched_requirement_ids)
        covered_technologies.update(item.technology_keys)
        source_counts[item.fact.experience_id] = source_counts.get(item.fact.experience_id, 0) + 1
        rank = len(selected)
        reasons = ["highest_marginal_value"]
        if best.new_requirement_gain > 0:
            reasons.append("adds_requirement_coverage")
        if best.new_technology_gain > 0:
            reasons.append("adds_technology_coverage")
        if item.fact.factbank_status != "ready":
            reasons.append("deterministic_factbank_fallback")
        selected_rows.append(
            RankedFact(
                fact_id=item.fact.fact_id,
                experience_id=item.fact.experience_id,
                source_revision_id=item.fact.source_revision_id,
                source_text=item.fact.source_text,
                technologies=item.fact.technologies,
                selected=True,
                rank=rank,
                score=best.to_score(),
                marginal_value=round(best.marginal_value, 6),
                matched_requirement_ids=tuple(sorted(item.matched_requirement_ids)),
                selection_reasons=tuple(reasons),
                degradation_sources=_degradation_sources(item, relevance_blind),
            )
        )
        remaining.pop(item.fact.fact_id)
        for candidate in remaining.values():
            candidate_id = candidate.fact.fact_id
            max_duplication_by_fact[candidate_id] = max(
                max_duplication_by_fact[candidate_id],
                _fact_similarity(candidate, item),
            )

    rejected_rows: list[RankedFact] = []
    for item in remaining.values():
        evaluation = _evaluate_marginal(
            item,
            requirement_weights,
            total_requirement_weight,
            covered_requirements,
            covered_technologies,
            source_counts,
            max_duplication_by_fact[item.fact.fact_id],
            relevance_blind=relevance_blind,
        )
        reasons = ["candidate_limit_reached"]
        if evaluation.semantic_duplication >= 0.12:
            reasons.append("semantic_duplication")
        if evaluation.repeated_source_penalty > 0:
            reasons.append("repeated_source_penalty")
        if not item.matched_requirement_ids:
            reasons.append("no_requirement_match")
        rejected_rows.append(
            RankedFact(
                fact_id=item.fact.fact_id,
                experience_id=item.fact.experience_id,
                source_revision_id=item.fact.source_revision_id,
                source_text=item.fact.source_text,
                technologies=item.fact.technologies,
                selected=False,
                score=evaluation.to_score(),
                marginal_value=round(evaluation.marginal_value, 6),
                matched_requirement_ids=tuple(sorted(item.matched_requirement_ids)),
                rejection_reasons=tuple(reasons),
                degradation_sources=_degradation_sources(item, relevance_blind),
            )
        )
    rejected_rows.sort(key=lambda value: (-value.marginal_value, value.fact_id))
    rows = (*selected_rows, *rejected_rows)
    diagnostics = RetrievalDiagnostics(
        total_experiences=len({fact.experience_id for fact in facts}),
        total_facts=len(facts),
        selected_facts=len(selected_rows),
        ready_facts=sum(fact.factbank_status == "ready" for fact in facts),
        fallback_facts=sum(fact.factbank_status != "ready" for fact in facts),
        requirement_embedding_cache_hits=embedding_cache_hits,
        requirement_embedding_cache_misses=embedding_cache_misses,
        warnings=tuple(warnings),
        ranking_version=RANKING_VERSION,
    )
    return HybridRetrievalResult(
        requirements=tuple(requirements),
        facts=rows,
        selected_fact_ids=tuple(row.fact_id for row in selected_rows),
        diagnostics=diagnostics,
    )


class _PreparedFact:
    def __init__(
        self,
        fact: RetrievalFact,
        semantic: float,
        lexical: float,
        matched_requirement_ids: set[str],
        semantic_available: bool,
        technology_keys: set[str],
        similarity_tokens: set[str],
        recency: float,
        normalized_embedding: tuple[float, ...],
    ) -> None:
        self.fact = fact
        self.semantic = semantic
        self.lexical = lexical
        self.matched_requirement_ids = matched_requirement_ids
        self.semantic_available = semantic_available
        self.technology_keys = technology_keys
        self.similarity_tokens = similarity_tokens
        self.recency = recency
        self.normalized_embedding = normalized_embedding


class _MarginalEvaluation:
    def __init__(
        self,
        item: _PreparedFact,
        marginal_value: float,
        weighted_total: float,
        recency: float,
        new_requirement_gain: float,
        new_technology_gain: float,
        semantic_duplication: float,
        repeated_source_penalty: float,
    ) -> None:
        self.item = item
        self.marginal_value = marginal_value
        self.weighted_total = weighted_total
        self.recency = recency
        self.new_requirement_gain = new_requirement_gain
        self.new_technology_gain = new_technology_gain
        self.semantic_duplication = semantic_duplication
        self.repeated_source_penalty = repeated_source_penalty

    def to_score(self) -> FactScoreBreakdown:
        return FactScoreBreakdown(
            semantic_similarity=round(self.item.semantic, 6),
            lexical_technology_match=round(self.item.lexical, 6),
            uncovered_requirement_gain=round(self.new_requirement_gain, 6),
            evidence_strength=round(self.item.fact.strength_score, 6),
            recency=round(self.recency, 6),
            weighted_total=round(self.weighted_total, 6),
        )


def _prepare_fact(
    fact: RetrievalFact,
    requirements: list[tuple[RetrievalRequirement, set[str]]],
    semantic_by_requirement: dict[str, float],
    semantic_match_threshold: float,
) -> _PreparedFact:
    semantic = 0.0
    lexical = 0.0
    matched: set[str] = set()
    fact_tokens = _expanded_tokens((*fact.lexical_tokens, *fact.technologies, fact.source_text))
    technology_tokens = _expanded_tokens(fact.technologies)
    for requirement, requirement_tokens in requirements:
        similarity = _bounded(semantic_by_requirement.get(requirement.requirement_id, 0.0))
        weighted_similarity = similarity * (0.5 + 0.5 * requirement.weight)
        lexical_score = _lexical_requirement_match(
            fact,
            requirement,
            fact_tokens,
            technology_tokens,
            requirement_tokens,
        )
        semantic = max(semantic, weighted_similarity)
        lexical = max(lexical, lexical_score)
        if similarity >= semantic_match_threshold or lexical_score > 0:
            matched.add(requirement.requirement_id)
    return _PreparedFact(
        fact,
        semantic,
        lexical,
        matched,
        bool(semantic_by_requirement),
        technology_tokens,
        fact_tokens,
        _recency(fact.end_date, fact.start_date),
        _normalize_embedding(fact.embedding),
    )


def _evaluate_marginal(
    item: _PreparedFact,
    requirement_weights: dict[str, float],
    total_requirement_weight: float,
    covered_requirements: set[str],
    covered_technologies: set[str],
    source_counts: dict[str, int],
    max_semantic_duplication: float,
    *,
    relevance_blind: bool,
) -> _MarginalEvaluation:
    new_requirement_ids = item.matched_requirement_ids - covered_requirements
    new_requirement_gain = min(
        1.0,
        sum(requirement_weights.get(requirement_id, 0.0) for requirement_id in new_requirement_ids)
        / total_requirement_weight,
    )
    fact_technologies = item.technology_keys
    new_technologies = fact_technologies - covered_technologies
    new_technology_gain = len(new_technologies) / max(1, len(fact_technologies))
    recency = 0.0 if relevance_blind else item.recency
    weighted_total = (
        0.40 * item.semantic
        + 0.25 * item.lexical
        + 0.20 * new_requirement_gain
        + 0.10 * item.fact.strength_score
        + 0.05 * recency
    )
    semantic_duplication = 0.18 * max_semantic_duplication
    repeated_source_penalty = min(0.16, 0.04 * source_counts.get(item.fact.experience_id, 0))
    marginal_value = (
        weighted_total
        + 0.15 * new_requirement_gain
        + 0.08 * new_technology_gain
        - semantic_duplication
        - repeated_source_penalty
    )
    return _MarginalEvaluation(
        item,
        marginal_value,
        weighted_total,
        recency,
        new_requirement_gain,
        new_technology_gain,
        semantic_duplication,
        repeated_source_penalty,
    )


def _lexical_requirement_match(
    fact: RetrievalFact,
    requirement: RetrievalRequirement,
    fact_tokens: set[str],
    technology_tokens: set[str],
    required_tokens: set[str],
) -> float:
    if not required_tokens:
        return 0.0
    matches = fact_tokens & required_tokens
    technology_matches = technology_tokens & required_tokens
    coverage = len(matches) / len(required_tokens)
    technology_bonus = min(0.35, 0.15 * len(technology_matches))
    exact_phrase_bonus = (
        0.15
        if any(
            _key(keyword) and _key(keyword) in _key(fact.source_text)
            for keyword in requirement.keywords
        )
        else 0.0
    )
    return min(1.0, coverage + technology_bonus + exact_phrase_bonus)


def _expanded_tokens(values: Iterable[str]) -> set[str]:
    tokens: set[str] = set()
    for value in values:
        normalized = unicodedata.normalize("NFKC", value).casefold()
        tokens.update(match.group(0) for match in _TOKEN_RE.finditer(normalized))
        for match in _CJK_RE.finditer(normalized):
            text = match.group(0)
            tokens.add(text)
            tokens.update(text[index : index + 2] for index in range(max(0, len(text) - 1)))
    expanded = set(tokens)
    for group in _ALIASES:
        if group & tokens:
            expanded.update(group)
    return expanded


def _fact_similarity(left: _PreparedFact, right: _PreparedFact) -> float:
    if (
        left.normalized_embedding
        and right.normalized_embedding
        and len(left.normalized_embedding) == len(right.normalized_embedding)
    ):
        return max(
            0.0,
            min(1.0, math.sumprod(left.normalized_embedding, right.normalized_embedding)),
        )
    union = left.similarity_tokens | right.similarity_tokens
    return len(left.similarity_tokens & right.similarity_tokens) / len(union) if union else 0.0


def _normalize_embedding(value: tuple[float, ...]) -> tuple[float, ...]:
    if not value:
        return ()
    norm = math.sqrt(math.sumprod(value, value))
    if norm == 0:
        return ()
    return tuple(item / norm for item in value)


def _recency(end_date: date | None, start_date: date | None) -> float:
    value = end_date or start_date
    if value is None:
        return 0.3
    today = date.today()
    months_ago = max(0, (today.year - value.year) * 12 + today.month - value.month)
    return max(0.05, math.exp(-0.693 * months_ago / 36))


def _degradation_sources(item: _PreparedFact, relevance_blind: bool) -> tuple[str, ...]:
    sources: list[str] = []
    if not item.fact.embedding:
        sources.append("missing_fact_embedding")
    if not item.semantic_available:
        sources.append("semantic_signal_unavailable")
    if item.fact.factbank_status != "ready":
        sources.append("deterministic_revision_fallback")
    if relevance_blind:
        sources.append("relevance_signals_unavailable_recency_disabled")
    return tuple(sources)


def _bounded(value: float) -> float:
    return max(0.0, min(1.0, value))


def _key(value: str) -> str:
    return "".join(unicodedata.normalize("NFKC", value).casefold().split())
