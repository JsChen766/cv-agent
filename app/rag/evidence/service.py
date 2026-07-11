"""
Evidence RAG service.

Given a JD's requirements, retrieves relevant experiences and builds
an EvidencePack mapping requirements → supporting claims.
"""

from __future__ import annotations

import asyncpg

from app.core.config import settings
from app.domain.jd.models import JdRequirement
from app.infra.db.helpers import column_is_vector
from app.providers.factory import get_embedding_provider
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
        avg_vec = [
            sum(e[i] for e in embeddings) / len(embeddings)
            for i in range(len(embeddings[0]))
        ]
        vec_str = f"[{','.join(str(v) for v in avg_vec)}]"

        async with self._pool.acquire() as conn:
            if not await column_is_vector(conn, "experiences", "embedding"):
                return []
            rows = await conn.fetch(
                """
                SELECT
                    e.id, e.title, e.organization,
                    er.content,
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

        return [
            ExperienceWithClaims(
                experience_id=r["id"],
                title=r["title"],
                organization=r["organization"],
                content=r["content"],
                relevance_score=float(r["relevance_score"]),
            )
            for r in rows
        ]

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
            matched_claims = []
            for (_, claim), claim_emb in zip(all_claims, claim_embeddings, strict=False):
                similarity = _cosine_sim(req_emb, claim_emb)
                if similarity >= threshold:
                    matched_claims.append(claim)

            if matched_claims:
                matched_req_count += 1
                # Score = average similarity of top-3 matches
                score = min(1.0, len(matched_claims) / 3)
                matches.append(
                    EvidenceMatch(
                        requirement_id=req.id,
                        requirement_text=req.text,
                        matched_claims=matched_claims[:5],  # cap at 5
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
