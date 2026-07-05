"""
Evidence indexer.

Called after an experience revision is saved to update its embedding
and extract/store claims. This keeps the vector index fresh.
"""

from __future__ import annotations

import asyncpg

from app.providers.factory import get_embedding_provider
from app.rag.evidence.claim_extractor import extract_claims


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
    vec_str = f"[{','.join(str(v) for v in content_emb)}]"

    # 2. Extract claims so extraction failures surface during indexing.
    await extract_claims(content)

    async with pool.acquire() as conn, conn.transaction():
        # Update experience embedding
        await conn.execute(
            "UPDATE experiences SET embedding=$1::vector WHERE id=$2",
            vec_str, experience_id,
        )
        # Update revision embedding
        await conn.execute(
            "UPDATE experience_revisions SET embedding=$1::vector WHERE id=$2",
            vec_str, revision_id,
        )
