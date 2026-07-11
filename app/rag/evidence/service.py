"""
Evidence RAG service.

Given a JD's requirements, retrieves relevant experiences and builds
an EvidencePack mapping requirements → supporting claims.
"""

from __future__ import annotations

import asyncio
import json

import asyncpg

from app.core.config import settings
from app.domain.jd.models import JdRequirement
from app.infra.db.helpers import column_is_vector
from app.providers.factory import get_embedding_provider
from app.rag.evidence.claim_extractor import extract_claims
from app.rag.evidence.models import Claim, EvidenceMatch, EvidencePack, ExperienceWithClaims


class EvidenceRagService:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool
        self._embed = get_embedding_provider()

    async def retrieve_for_jd(
        self,
        jd_requirements: list[JdRequirement],
        user_id: str,
        *,
        top_k: int = 8,
    ) -> list[ExperienceWithClaims]:
        """Retrieve top-k relevant experiences for the given JD requirements."""
        if not jd_requirements:
            return []

        # Embed all requirements and average them as a single query vector
        req_texts = [r.text for r in jd_requirements]
        embeddings = await self._embed.embed(req_texts)
        if not embeddings or not embeddings[0]:
            return await self.retrieve_recent(user_id, top_k=top_k)
        avg_vec = [
            sum(e[i] for e in embeddings) / len(embeddings)
            for i in range(len(embeddings[0]))
        ]
        vec_str = f"[{','.join(str(v) for v in avg_vec)}]"

        async with self._pool.acquire() as conn:
            use_vector = await column_is_vector(conn, "experiences", "embedding")
        if not use_vector:
            return await self.retrieve_recent(user_id, top_k=top_k)
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                    e.id, e.title, e.organization,
                    er.id AS revision_id, er.content, er.claims,
                    1 - (e.embedding <=> $1::vector) AS relevance_score
                FROM experiences e
                JOIN experience_revisions er ON er.id = e.current_revision_id
                WHERE e.user_id = $2
                  AND e.status = 'active'
                  AND e.embedding IS NOT NULL
                ORDER BY e.embedding <=> $1::vector
                LIMIT $3
                """,
                vec_str, user_id, top_k,
            )

        if not rows:
            return await self.retrieve_recent(user_id, top_k=top_k)
        experiences = [self._to_experience(row) for row in rows]
        await self._hydrate_missing_claims(experiences)
        return experiences

    async def retrieve_recent(
        self, user_id: str, *, top_k: int = 5
    ) -> list[ExperienceWithClaims]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT e.id, e.title, e.organization,
                       er.id AS revision_id, er.content, er.claims,
                       0.0 AS relevance_score
                FROM experiences e
                JOIN experience_revisions er ON er.id = e.current_revision_id
                WHERE e.user_id=$1 AND e.status='active'
                ORDER BY e.updated_at DESC
                LIMIT $2
                """,
                user_id,
                top_k,
            )
        experiences = [self._to_experience(row) for row in rows]
        await self._hydrate_missing_claims(experiences)
        return experiences

    @staticmethod
    def _to_experience(row: asyncpg.Record) -> ExperienceWithClaims:
        raw_claims = row["claims"]
        claims_indexed = raw_claims is not None
        if isinstance(raw_claims, str):
            raw_claims = json.loads(raw_claims)
        claims = [Claim.model_validate(claim) for claim in (raw_claims or [])]
        return ExperienceWithClaims(
            experience_id=row["id"],
            revision_id=row["revision_id"],
            title=row["title"],
            organization=row["organization"],
            content=row["content"],
            claims=claims,
            claims_indexed=claims_indexed,
            relevance_score=float(row["relevance_score"] or 0.0),
        )

    async def _hydrate_missing_claims(
        self, experiences: list[ExperienceWithClaims]
    ) -> None:
        missing = [experience for experience in experiences if not experience.claims_indexed]
        if not missing:
            return
        extracted = await asyncio.gather(
            *(extract_claims(experience.content) for experience in missing),
            return_exceptions=True,
        )
        async with self._pool.acquire() as conn:
            for experience, result in zip(missing, extracted, strict=True):
                if isinstance(result, asyncio.CancelledError):
                    raise result
                if isinstance(result, BaseException):
                    continue
                experience.claims = result
                experience.claims_indexed = True
                if experience.revision_id:
                    await conn.execute(
                        "UPDATE experience_revisions SET claims=$1::jsonb WHERE id=$2",
                        json.dumps([claim.model_dump(mode="json") for claim in result]),
                        experience.revision_id,
                    )

    async def build_evidence_pack(
        self,
        jd_requirements: list[JdRequirement],
        experiences: list[ExperienceWithClaims],
    ) -> EvidencePack:
        """
        Match requirements to experience claims.

        For each requirement, find claims whose embeddings are above the
        similarity threshold. Uses batched embedding for efficiency.
        """
        if not jd_requirements or not experiences:
            return EvidencePack(total_requirements=len(jd_requirements))

        # Gather all unique claim texts for batch embedding
        all_claims: list[tuple[ExperienceWithClaims, Claim]] = []
        for exp in experiences:
            for claim in exp.claims:
                all_claims.append((exp, claim))

        if not all_claims:
            return EvidencePack(total_requirements=len(jd_requirements))

        # Embed requirements and claims together
        req_texts = [r.text for r in jd_requirements]
        claim_texts = [c.text for _, c in all_claims]
        all_texts = req_texts + claim_texts

        all_embeddings = await self._embed.embed(all_texts)
        req_embeddings = all_embeddings[: len(req_texts)]
        claim_embeddings = all_embeddings[len(req_texts):]

        threshold = settings.evidence_similarity_threshold
        matches: list[EvidenceMatch] = []
        matched_req_count = 0

        for req, req_emb in zip(jd_requirements, req_embeddings, strict=False):
            matched_claims: list[tuple[Claim, float]] = []
            for (_, claim), claim_emb in zip(all_claims, claim_embeddings, strict=False):
                similarity = _cosine_sim(req_emb, claim_emb)
                if similarity >= threshold:
                    matched_claims.append((claim, similarity))

            if matched_claims:
                matched_req_count += 1
                matched_claims.sort(key=lambda item: item[1], reverse=True)
                top_matches = matched_claims[:5]
                top_scores = [similarity for _, similarity in top_matches[:3]]
                score = sum(top_scores) / len(top_scores)
                matches.append(
                    EvidenceMatch(
                        requirement_id=req.id,
                        requirement_text=req.text,
                        matched_claims=[claim for claim, _ in top_matches],
                        match_score=score,
                    )
                )

        coverage = matched_req_count / len(jd_requirements) if jd_requirements else 0.0
        return EvidencePack(
            matches=matches,
            coverage_ratio=coverage,
            total_requirements=len(jd_requirements),
        )


def _cosine_sim(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(dot / (norm_a * norm_b))
