"""
Evidence indexer.

Called after an experience revision is saved to update its embedding
and extract/store claims. This keeps the vector index fresh.
"""

from __future__ import annotations

import json
import logging

import asyncpg

from app.infra.db.helpers import column_is_vector
from app.providers.factory import get_embedding_provider
from app.rag.evidence.claim_extractor import extract_claims

logger = logging.getLogger(__name__)


async def index_experience(
    experience_id: str,
    revision_id: str,
    content: str,
    pool: asyncpg.Pool,
) -> None:
    """Embed content, extract claims, store both in DB."""
    embed_provider = get_embedding_provider()

    # 1. Embed the full content
    embeddings = await embed_provider.embed([content])
    content_emb = embeddings[0]
    # 2. Extract and persist claims so evidence matching can reuse them.
    claims_json: str | None = None
    try:
        claims = await extract_claims(content)
        claims_json = json.dumps([claim.model_dump(mode="json") for claim in claims])
    except Exception as exc:
        # A chat-model outage must not discard a successfully generated vector.
        logger.warning("Claim extraction failed for experience %s: %s", experience_id, exc)

    async with pool.acquire() as conn, conn.transaction():
        if await column_is_vector(conn, "experiences", "embedding"):
            embedding_value: str | list[float] = f"[{','.join(str(v) for v in content_emb)}]"
            update_sql = "UPDATE experiences SET embedding=$1::vector WHERE id=$2"
            revision_update_sql = "UPDATE experience_revisions SET embedding=$1::vector WHERE id=$2"
        else:
            embedding_value = content_emb
            update_sql = "UPDATE experiences SET embedding=$1 WHERE id=$2"
            revision_update_sql = "UPDATE experience_revisions SET embedding=$1 WHERE id=$2"

        # Update experience embedding
        await conn.execute(
            update_sql,
            embedding_value,
            experience_id,
        )
        # Update revision embedding
        await conn.execute(
            revision_update_sql,
            embedding_value,
            revision_id,
        )
        if claims_json is not None:
            await conn.execute(
                "UPDATE experience_revisions SET claims=$1::jsonb WHERE id=$2",
                claims_json,
                revision_id,
            )


class EvidenceExperienceIndexer:
    """Adapter injected into the domain service at the composition root."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def index(self, experience_id: str, revision_id: str, content: str) -> None:
        await index_experience(experience_id, revision_id, content, self._pool)
