from __future__ import annotations

import hashlib
import json
import logging
import math
from dataclasses import dataclass

import asyncpg

from app.domain.jd.models import JdRequirement
from app.domain.resume.factbank.service import (
    compute_revision_hash,
    deterministic_fallback_facts,
)
from app.domain.resume.retrieval.models import (
    ExperienceFactBundle,
    HybridRetrievalResult,
    RankedFact,
    RetrievalFact,
    RetrievalRequirement,
)
from app.domain.resume.retrieval.repository import FactRetrievalRepository
from app.domain.resume.retrieval.service import rank_facts
from app.providers.base import EmbeddingProvider
from app.rag.evidence.models import Claim, EvidenceMatch, EvidencePack, ExperienceWithClaims

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class HybridFactContext:
    retrieval_result: HybridRetrievalResult
    experiences: list[ExperienceWithClaims]
    evidence_pack: EvidencePack


class HybridFactRetrievalService:
    def __init__(
        self,
        repository: FactRetrievalRepository,
        embedding_provider: EmbeddingProvider,
        *,
        embedding_model: str,
        max_candidates: int,
        semantic_match_threshold: float,
    ) -> None:
        self._repository = repository
        self._embedding_provider = embedding_provider
        self._embedding_model = embedding_model
        self._max_candidates = max_candidates
        self._semantic_match_threshold = semantic_match_threshold

    async def retrieve(
        self,
        user_id: str,
        jd_requirements: list[JdRequirement],
    ) -> HybridFactContext:
        requirements = [_to_retrieval_requirement(value) for value in jd_requirements]
        bundles = await self._repository.load_current_experience_facts(
            user_id,
            embedding_model=self._embedding_model,
        )
        facts = _all_facts_with_fallback(bundles)
        (
            requirement_embeddings,
            cache_hits,
            cache_misses,
            embedding_warning,
        ) = await self._requirement_embeddings(user_id, requirements)
        semantic_scores = _semantic_scores(facts, requirements, requirement_embeddings)
        result = rank_facts(
            facts,
            requirements,
            semantic_scores,
            max_candidates=self._max_candidates,
            semantic_match_threshold=self._semantic_match_threshold,
            embedding_cache_hits=cache_hits,
            embedding_cache_misses=cache_misses,
        )
        if embedding_warning is not None:
            diagnostics = result.diagnostics.model_copy(
                update={
                    "warnings": tuple((*result.diagnostics.warnings, embedding_warning)),
                }
            )
            result = result.model_copy(update={"diagnostics": diagnostics})
        if result.diagnostics.warnings:
            logger.warning(
                "Hybrid fact retrieval degraded",
                extra={
                    "user_id": user_id,
                    "warnings": list(result.diagnostics.warnings),
                    "total_facts": result.diagnostics.total_facts,
                    "selected_facts": result.diagnostics.selected_facts,
                },
            )
        else:
            logger.info(
                "Hybrid fact retrieval completed",
                extra={
                    "user_id": user_id,
                    "total_experiences": result.diagnostics.total_experiences,
                    "total_facts": result.diagnostics.total_facts,
                    "selected_facts": result.diagnostics.selected_facts,
                    "embedding_cache_hits": cache_hits,
                    "embedding_cache_misses": cache_misses,
                },
            )
        return HybridFactContext(
            retrieval_result=result,
            experiences=_project_experiences(bundles, result),
            evidence_pack=_project_evidence_pack(result),
        )

    async def _requirement_embeddings(
        self,
        user_id: str,
        requirements: list[RetrievalRequirement],
    ) -> tuple[dict[str, tuple[float, ...]], int, int, str | None]:
        fingerprint = _requirements_fingerprint(requirements)
        text_by_id = {
            value.requirement_id: " | ".join(
                part for part in (value.description, ", ".join(value.keywords)) if part
            )
            for value in requirements
        }
        text_hashes = {
            requirement_id: hashlib.sha256(text.encode("utf-8")).hexdigest()
            for requirement_id, text in text_by_id.items()
        }
        cache_warning: str | None = None
        try:
            cached = await self._repository.get_requirement_embeddings(
                user_id,
                fingerprint,
                self._embedding_model,
                text_hashes,
            )
        except Exception as exc:
            logger.warning("Requirement embedding cache read failed: %s", exc)
            cached = {}
            cache_warning = "requirement_embedding_cache_unavailable"
        missing_ids = [
            value.requirement_id for value in requirements if value.requirement_id not in cached
        ]
        if not missing_ids:
            return cached, len(cached), 0, cache_warning
        try:
            vectors = await self._embedding_provider.embed(
                [text_by_id[value] for value in missing_ids]
            )
            if len(vectors) != len(missing_ids):
                raise ValueError("Embedding provider returned an unexpected vector count")
        except Exception as exc:  # retrieval must keep a deterministic lexical fallback
            logger.warning("Requirement embedding failed: %s", exc)
            return cached, len(cached), len(missing_ids), "requirement_embedding_unavailable"
        generated = {
            requirement_id: tuple(vector)
            for requirement_id, vector in zip(missing_ids, vectors, strict=True)
            if vector
        }
        try:
            await self._repository.save_requirement_embeddings(
                user_id,
                fingerprint,
                self._embedding_model,
                text_hashes,
                generated,
            )
        except Exception as exc:
            logger.warning("Requirement embedding cache write failed: %s", exc)
            cache_warning = "requirement_embedding_cache_unavailable"
        return {**cached, **generated}, len(cached), len(missing_ids), cache_warning


def build_hybrid_fact_retrieval_service(
    pool: asyncpg.Pool,
    embedding_provider: EmbeddingProvider,
    *,
    embedding_model: str,
    max_candidates: int,
    semantic_match_threshold: float,
) -> HybridFactRetrievalService:
    """Compose the hybrid retriever at the RAG/infra boundary."""
    from app.infra.db.repositories.fact_retrieval_repo import (
        PostgresFactRetrievalRepository,
    )

    return HybridFactRetrievalService(
        PostgresFactRetrievalRepository(pool),
        embedding_provider,
        embedding_model=embedding_model,
        max_candidates=max_candidates,
        semantic_match_threshold=semantic_match_threshold,
    )


def _all_facts_with_fallback(bundles: list[ExperienceFactBundle]) -> list[RetrievalFact]:
    facts: list[RetrievalFact] = []
    for bundle in bundles:
        if bundle.factbank_status == "ready" and bundle.facts:
            facts.extend(bundle.facts)
            continue
        revision_hash = bundle.revision_hash or compute_revision_hash(bundle.content)
        fallback = deterministic_fallback_facts(
            experience_id=bundle.experience_id,
            revision_id=bundle.revision_id,
            revision_hash=revision_hash,
            content=bundle.content,
        )
        facts.extend(
            RetrievalFact(
                fact_id=value.fact_id,
                experience_id=bundle.experience_id,
                source_revision_id=bundle.revision_id,
                source_revision_hash=revision_hash,
                source_text=value.source_text,
                technologies=value.technologies,
                lexical_tokens=value.lexical_tokens,
                strength_score=value.strength_score,
                experience_category=bundle.category,
                experience_title=bundle.title,
                organization=bundle.organization,
                role=bundle.role,
                start_date=bundle.start_date,
                end_date=bundle.end_date,
                factbank_status="deterministic_fallback",
            )
            for value in fallback
        )
    return facts


def _semantic_scores(
    facts: list[RetrievalFact],
    requirements: list[RetrievalRequirement],
    requirement_embeddings: dict[str, tuple[float, ...]],
) -> dict[str, dict[str, float]]:
    result: dict[str, dict[str, float]] = {}
    normalized_requirements = {
        requirement_id: _normalize_embedding(vector)
        for requirement_id, vector in requirement_embeddings.items()
    }
    for fact in facts:
        fact_vector = _normalize_embedding(fact.embedding)
        by_requirement: dict[str, float] = {}
        for requirement in requirements:
            vector = normalized_requirements.get(requirement.requirement_id, ())
            if fact_vector and vector and len(fact_vector) == len(vector):
                by_requirement[requirement.requirement_id] = max(
                    0.0,
                    min(1.0, math.sumprod(fact_vector, vector)),
                )
        result[fact.fact_id] = by_requirement
    return result


def _project_experiences(
    bundles: list[ExperienceFactBundle],
    result: HybridRetrievalResult,
) -> list[ExperienceWithClaims]:
    selected_by_experience: dict[str, list[RankedFact]] = {}
    for fact in result.facts:
        if fact.selected:
            selected_by_experience.setdefault(fact.experience_id, []).append(fact)
    projected: list[ExperienceWithClaims] = []
    for bundle in bundles:
        ranked = selected_by_experience.get(bundle.experience_id, [])
        if not ranked and bundle.category != "education":
            continue
        claims = [
            Claim(
                fact_id=value.fact_id,
                experience_id=bundle.experience_id,
                text=value.source_text,
                category="achievement",
                is_quantified=any(character.isdigit() for character in value.source_text),
            )
            for value in ranked
        ]
        projected.append(
            ExperienceWithClaims(
                experience_id=bundle.experience_id,
                revision_id=bundle.revision_id,
                title=bundle.title,
                organization=bundle.organization,
                role=bundle.role,
                category=bundle.category,
                start_date=bundle.start_date.isoformat() if bundle.start_date else None,
                end_date=bundle.end_date.isoformat() if bundle.end_date else None,
                tags=list(bundle.tags),
                content=bundle.content,
                claims=claims,
                claims_indexed=bundle.factbank_status == "ready",
                factbank_status=bundle.factbank_status,
                relevance_score=max((value.score.weighted_total for value in ranked), default=0.0),
            )
        )
    projected.sort(
        key=lambda value: (value.category == "education", value.relevance_score),
        reverse=True,
    )
    return projected


def _project_evidence_pack(result: HybridRetrievalResult) -> EvidencePack:
    matches: list[EvidenceMatch] = []
    for requirement in result.requirements:
        facts = [
            value
            for value in result.facts
            if value.selected and requirement.requirement_id in value.matched_requirement_ids
        ]
        facts.sort(
            key=lambda value: (
                -max(
                    value.score.semantic_similarity,
                    value.score.lexical_technology_match,
                ),
                value.rank or 0,
            )
        )
        if not facts:
            continue
        top = facts[:5]
        matches.append(
            EvidenceMatch(
                requirement_id=requirement.requirement_id,
                requirement_text=requirement.description,
                matched_claims=[
                    Claim(
                        fact_id=value.fact_id,
                        experience_id=value.experience_id,
                        text=value.source_text,
                        category="achievement",
                        is_quantified=any(character.isdigit() for character in value.source_text),
                    )
                    for value in top
                ],
                match_score=max(
                    max(value.score.semantic_similarity, value.score.lexical_technology_match)
                    for value in top
                ),
            )
        )
    return EvidencePack(
        matches=matches,
        coverage_ratio=len(matches) / len(result.requirements) if result.requirements else 0.0,
        total_requirements=len(result.requirements),
    )


def _to_retrieval_requirement(value: JdRequirement) -> RetrievalRequirement:
    importance = value.v2_importance
    if importance is None:
        importance = (
            "must_have"
            if value.importance == "high"
            else "optional"
            if value.importance == "low"
            else "preferred"
        )
    weight = value.weight
    if weight is None:
        weight = 1.0 if importance == "must_have" else 0.60 if importance == "preferred" else 0.30
    return RetrievalRequirement(
        requirement_id=value.id,
        description=value.text,
        category=value.v2_category or value.category,
        keywords=value.keywords,
        importance=importance,
        weight=weight,
    )


def _requirements_fingerprint(requirements: list[RetrievalRequirement]) -> str:
    payload = json.dumps(
        [value.model_dump(mode="json") for value in requirements],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _normalize_embedding(value: tuple[float, ...]) -> tuple[float, ...]:
    if not value:
        return ()
    norm = math.sqrt(math.sumprod(value, value))
    if norm == 0:
        return ()
    return tuple(item / norm for item in value)
