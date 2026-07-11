"""
Guideline RAG service.

Retrieves writing guidelines relevant to the current generation intent.
Guidelines are stored as vector chunks in the guideline_chunks table.
"""

from __future__ import annotations

import asyncpg

from app.infra.db.helpers import column_is_vector
from app.providers.factory import get_embedding_provider


class GuidelineRagService:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool
        self._embed = get_embedding_provider()

    async def retrieve(
        self,
        query: str,
        *,
        top_k: int = 5,
    ) -> list[str]:
        """Return top-k guideline instruction strings for the given query."""
        async with self._pool.acquire() as conn:
            use_vector = await column_is_vector(conn, "guideline_chunks", "embedding")
        if not use_vector:
            return await self.retrieve_fallback(query, top_k=top_k)
        embeddings = await self._embed.embed([query])
        if not embeddings or not embeddings[0]:
            return await self.retrieve_fallback(query, top_k=top_k)
        query_vec = embeddings[0]
        vec_str = f"[{','.join(str(v) for v in query_vec)}]"

        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT content, 1 - (embedding <=> $1::vector) AS similarity
                FROM guideline_chunks
                WHERE embedding IS NOT NULL
                ORDER BY embedding <=> $1::vector
                LIMIT $2
                """,
                vec_str, top_k,
            )
        if rows:
            return [r["content"] for r in rows]
        return await self.retrieve_fallback(query, top_k=top_k)

    async def retrieve_fallback(self, query: str, *, top_k: int = 5) -> list[str]:
        """Return guidelines by full-text search when no embeddings exist."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT content FROM guideline_chunks
                WHERE to_tsvector('simple', content) @@ plainto_tsquery('simple', $1)
                LIMIT $2
                """,
                query, top_k,
            )
        return [r["content"] for r in rows]
