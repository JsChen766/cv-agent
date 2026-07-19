from __future__ import annotations

from unittest.mock import AsyncMock

from app.domain.resume.factbank.models import (
    FactBankRevisionTask,
    FactDraft,
    FactRecord,
    ReusableFactBank,
)
from app.domain.resume.factbank.service import build_fact_records, compute_revision_hash
from app.rag.evidence.factbank_processor import FactBankProcessor


def _task(content: str = "Built Python APIs and reduced latency 30%") -> FactBankRevisionTask:
    return FactBankRevisionTask(
        revision_id="rev-1",
        experience_id="exp-1",
        user_id="user-1",
        content=content,
        revision_hash=compute_revision_hash(content),
        status="extracting",
        attempt_count=1,
    )


def _processor(repository, extractor, embedder) -> FactBankProcessor:
    return FactBankProcessor(
        repository,
        extractor,
        embedder,
        schema_version="factbank-v1",
        extractor_version="atomic-facts-v1",
        embedding_model="test-embedding",
        extraction_deadline_seconds=1.0,
    )


async def test_processor_extracts_once_and_embeds_as_one_batch() -> None:
    task = _task()
    repository = AsyncMock()
    repository.find_reusable.return_value = None
    repository.load_facts.return_value = []
    extractor = AsyncMock()
    extractor.extract.return_value = [
        FactDraft(
            action="Built",
            technologies=("Python",),
            metrics=("30%",),
            source_text=task.content,
        )
    ]
    embedder = AsyncMock()
    embedder.embed.return_value = [[1.0, 0.0], [0.0, 1.0]]

    mode = await _processor(repository, extractor, embedder).process(task)

    assert mode == "extracted"
    extractor.extract.assert_awaited_once_with(task.content)
    embedder.embed.assert_awaited_once_with([task.content, task.content])
    repository.replace_facts.assert_awaited_once()
    repository.complete.assert_awaited_once()


async def test_processor_retries_embedding_without_reextracting_persisted_facts() -> None:
    task = _task()
    facts = build_fact_records(
        experience_id=task.experience_id,
        revision_id=task.revision_id,
        revision_hash=task.revision_hash,
        content=task.content,
        drafts=[FactDraft(source_text=task.content)],
    )
    repository = AsyncMock()
    repository.find_reusable.return_value = None
    repository.load_facts.return_value = facts
    extractor = AsyncMock()
    embedder = AsyncMock()
    embedder.embed.return_value = [[1.0, 0.0], [0.0, 1.0]]

    await _processor(repository, extractor, embedder).process(task)

    extractor.extract.assert_not_awaited()
    repository.replace_facts.assert_not_awaited()
    repository.complete.assert_awaited_once()


async def test_processor_hash_reuse_skips_both_providers() -> None:
    task = _task()
    source_fact = FactRecord(
        fact_id="fact-source",
        experience_id="exp-old",
        source_revision_id="rev-old",
        source_revision_hash=task.revision_hash,
        source_text=task.content,
        source_start=0,
        source_end=len(task.content),
        strength_score=0.5,
        lexical_tokens=("python",),
        embedding_ref="fact-source",
    )
    repository = AsyncMock()
    repository.find_reusable.return_value = ReusableFactBank(
        facts=(source_fact,),
        fact_embeddings=((1.0, 0.0),),
        content_embedding=(0.0, 1.0),
    )
    extractor = AsyncMock()
    embedder = AsyncMock()

    mode = await _processor(repository, extractor, embedder).process(task)

    assert mode == "reused"
    extractor.extract.assert_not_awaited()
    embedder.embed.assert_not_awaited()
    repository.complete.assert_awaited_once()


async def test_processor_uses_deterministic_fallback_when_model_returns_no_valid_fact() -> None:
    task = _task("- Built an API\n- Reduced latency")
    repository = AsyncMock()
    repository.find_reusable.return_value = None
    repository.load_facts.return_value = []
    extractor = AsyncMock()
    extractor.extract.return_value = [FactDraft(source_text="unsupported claim")]
    embedder = AsyncMock()
    embedder.embed.return_value = [[1.0], [1.0], [1.0]]

    mode = await _processor(repository, extractor, embedder).process(task)

    assert mode == "deterministic_fallback"
    saved_facts = repository.replace_facts.call_args.args[1]
    assert [fact.source_text for fact in saved_facts] == [
        "Built an API",
        "Reduced latency",
    ]
