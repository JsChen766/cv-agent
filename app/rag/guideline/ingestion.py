"""
Guideline ingestion CLI.

Usage:
    python -m app.rag.guideline.ingestion --file guidelines.md
"""

from __future__ import annotations

import argparse
import asyncio
import re
import uuid
from pathlib import Path


async def ingest_file(file_path: str, pool) -> int:
    """Chunk a markdown file and upsert into guideline_chunks. Returns chunk count."""
    from app.providers.factory import get_embedding_provider

    text = Path(file_path).read_text(encoding="utf-8")
    chunks = _split_markdown(text)

    embed_provider = get_embedding_provider()
    embeddings = await embed_provider.embed(chunks)

    async with pool.acquire() as conn, conn.transaction():
        count = 0
        for i, (chunk, emb) in enumerate(zip(chunks, embeddings, strict=False)):
            chunk_id = str(uuid.uuid4())
            vec_str = f"[{','.join(str(v) for v in emb)}]"
            await conn.execute(
                """
                    INSERT INTO guideline_chunks (id, content, source_file, chunk_index, embedding)
                    VALUES ($1, $2, $3, $4, $5::vector)
                    ON CONFLICT DO NOTHING
                    """,
                chunk_id, chunk, file_path, i, vec_str,
            )
            count += 1
    return count


def _split_markdown(text: str, max_chars: int = 500) -> list[str]:
    """Split markdown into chunks by heading or paragraph."""
    sections = re.split(r"\n#{1,3} ", text)
    chunks = []
    for section in sections:
        section = section.strip()
        if not section:
            continue
        # Further split long sections by paragraph
        if len(section) > max_chars:
            paras = [p.strip() for p in section.split("\n\n") if p.strip()]
            current = ""
            for para in paras:
                if len(current) + len(para) < max_chars:
                    current += "\n\n" + para
                else:
                    if current:
                        chunks.append(current.strip())
                    current = para
            if current:
                chunks.append(current.strip())
        else:
            chunks.append(section)
    return [c for c in chunks if len(c) > 20]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, help="Path to guidelines markdown file")
    args = parser.parse_args()

    async def main():
        from app.infra.db.connection import close_pool, create_pool
        pool = await create_pool()
        count = await ingest_file(args.file, pool)
        print(f"Ingested {count} chunks from {args.file}")
        await close_pool()

    asyncio.run(main())
