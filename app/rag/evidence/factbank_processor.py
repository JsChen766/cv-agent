from __future__ import annotations

import asyncio

from app.domain.resume.factbank.models import (
    FactBankMode,
    FactBankRevisionTask,
    FactRecord,
)
from app.domain.resume.factbank.repository import FactBankRepository
from app.domain.resume.factbank.service import (
    build_fact_records,
    clone_fact_records,
    deterministic_fallback_facts,
)
from app.providers.base import EmbeddingProvider
from app.rag.evidence.fact_extractor import FactExtractor


class FactBankProcessor:
    def __init__(
        self,
        repository: FactBankRepository,
        extractor: FactExtractor,
        embedding_provider: EmbeddingProvider,
        *,
        schema_version: str,
        extractor_version: str,
        embedding_model: str,
        extraction_deadline_seconds: float,
    ) -> None:
        self._repository = repository
        self._extractor = extractor
        self._embedding_provider = embedding_provider
        self._schema_version = schema_version
        self._extractor_version = extractor_version
        self._embedding_model = embedding_model
        self._extraction_deadline_seconds = extraction_deadline_seconds

    async def process(self, task: FactBankRevisionTask) -> FactBankMode:
        reusable = await self._repository.find_reusable(
            task,
            schema_version=self._schema_version,
            extractor_version=self._extractor_version,
            embedding_model=self._embedding_model,
        )
        if reusable is not None:
            facts = clone_fact_records(
                reusable.facts,
                experience_id=task.experience_id,
                revision_id=task.revision_id,
                revision_hash=task.revision_hash,
                content=task.content,
            )
            if len(facts) == len(reusable.fact_embeddings):
                await self._repository.replace_facts(
                    task,
                    facts,
                    mode="reused",
                    schema_version=self._schema_version,
                    extractor_version=self._extractor_version,
                )
                await self._repository.complete(
                    task,
                    facts,
                    [list(vector) for vector in reusable.fact_embeddings],
                    list(reusable.content_embedding),
                    mode="reused",
                    schema_version=self._schema_version,
                    extractor_version=self._extractor_version,
                    embedding_model=self._embedding_model,
                )
                return "reused"

        facts = []
        if task.built_schema_version in {
            None,
            self._schema_version,
        } and task.built_extractor_version in {None, self._extractor_version}:
            facts = await self._repository.load_facts(task.revision_id)
        mode = task.mode or "extracted"
        if not facts:
            facts, mode = await self._extract(task)
            await self._repository.replace_facts(
                task,
                facts,
                mode=mode,
                schema_version=self._schema_version,
                extractor_version=self._extractor_version,
            )

        fact_embeddings, content_embedding = await self._embed(task, facts)
        await self._repository.complete(
            task,
            facts,
            fact_embeddings,
            content_embedding,
            mode=mode,
            schema_version=self._schema_version,
            extractor_version=self._extractor_version,
            embedding_model=self._embedding_model,
        )
        return mode

    async def _extract(self, task: FactBankRevisionTask) -> tuple[list[FactRecord], FactBankMode]:
        async with asyncio.timeout(self._extraction_deadline_seconds):
            drafts = await self._extractor.extract(task.content)
        facts = build_fact_records(
            experience_id=task.experience_id,
            revision_id=task.revision_id,
            revision_hash=task.revision_hash,
            content=task.content,
            drafts=drafts,
        )
        if facts:
            return facts, "extracted"
        return (
            deterministic_fallback_facts(
                experience_id=task.experience_id,
                revision_id=task.revision_id,
                revision_hash=task.revision_hash,
                content=task.content,
            ),
            "deterministic_fallback",
        )

    async def _embed(
        self,
        task: FactBankRevisionTask,
        facts: list[FactRecord],
    ) -> tuple[list[list[float]], list[float]]:
        texts = [fact.source_text for fact in facts]
        embeddings = await self._embedding_provider.embed([*texts, task.content])
        if len(embeddings) != len(texts) + 1:
            raise ValueError("Embedding provider returned an unexpected vector count")
        return embeddings[:-1], embeddings[-1]
