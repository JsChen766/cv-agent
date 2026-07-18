from __future__ import annotations

import asyncio
import sys
import time
from types import ModuleType
from typing import Any

from langchain_core.messages import AIMessage
from pydantic import BaseModel

from app.core.observability import TraceRecorder
from app.providers.local_embedding import LocalEmbeddingProvider
from app.providers.openai_format import OpenAIFormatProvider
from app.providers.retry import RetryStats, run_with_transport_retries


class StructuredResult(BaseModel):
    value: int


class FakeStructuredInvocation:
    def __init__(self, method: str) -> None:
        self.method = method

    async def ainvoke(self, messages: list[Any]) -> dict[str, object]:
        if self.method == "json_mode":
            raise ValueError("unsupported protocol")
        raw = AIMessage(
            content='{"value": 7}',
            usage_metadata={"input_tokens": 11, "output_tokens": 5, "total_tokens": 16},
        )
        return {
            "parsed": StructuredResult(value=7),
            "raw": raw,
            "parsing_error": None,
        }


class FakeBound:
    def bind(self, **kwargs: Any) -> FakeBound:
        return self

    def with_structured_output(
        self, schema: type, *, method: str, include_raw: bool = False
    ) -> FakeStructuredInvocation:
        return FakeStructuredInvocation(method)


def _recorder() -> TraceRecorder:
    return TraceRecorder(
        run_id="rgrun-provider",
        request_id="request-provider",
        thread_id="thread-provider",
        turn_id="turn-provider",
        trigger="chat",
    )


async def test_structured_fallback_is_one_logical_call_with_two_physical_requests() -> None:
    provider = OpenAIFormatProvider.__new__(OpenAIFormatProvider)
    provider._model = "fake-model"
    provider._llm = FakeBound()
    recorder = _recorder()

    with recorder.activate(node="draft_generation"):
        result = await provider.chat_structured(
            [{"role": "system", "content": "Return JSON."}],
            StructuredResult,
        )

    assert result == StructuredResult(value=7)
    calls = recorder.metrics()["llm_calls"]
    assert len(calls) == 1
    assert calls[0]["logical_call_count"] == 1
    assert calls[0]["protocol_attempt_count"] == 2
    assert calls[0]["physical_request_count"] == 2
    assert calls[0]["protocol"] == "json_schema"
    assert calls[0]["input_tokens"] == 11
    assert calls[0]["output_tokens"] == 5


async def test_transport_retry_counts_attempts_and_skips_schema_errors() -> None:
    attempts = 0
    stats = RetryStats()

    async def timeout_once() -> str:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise TimeoutError("retry")
        return "ok"

    result = await run_with_transport_retries(
        timeout_once,
        max_retries=3,
        stats=stats,
        sleep=_no_sleep,
    )
    assert result == "ok"
    assert stats.attempts == 2
    assert stats.retries == 1


async def _no_sleep(seconds: float) -> None:
    return None


async def test_local_embedding_cold_load_is_serialized(monkeypatch: Any) -> None:
    load_count = 0
    active_encodes = 0
    max_active_encodes = 0

    class FakeVectors:
        def astype(self, value: type) -> FakeVectors:
            return self

        def tolist(self) -> list[list[float]]:
            return [[0.1, 0.2]]

    class FakeSentenceTransformer:
        def __init__(self, model: str, *, local_files_only: bool) -> None:
            nonlocal load_count
            load_count += 1
            time.sleep(0.05)

        def encode(self, texts: list[str], **kwargs: object) -> FakeVectors:
            nonlocal active_encodes, max_active_encodes
            active_encodes += 1
            max_active_encodes = max(max_active_encodes, active_encodes)
            time.sleep(0.05)
            active_encodes -= 1
            return FakeVectors()

    fake_module = ModuleType("sentence_transformers")
    fake_module.SentenceTransformer = FakeSentenceTransformer  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sentence_transformers", fake_module)
    monkeypatch.setattr("app.providers.local_embedding.settings.embedding_dimensions", 2)
    provider = LocalEmbeddingProvider("fake-model")

    await asyncio.gather(provider.embed(["first"]), provider.embed(["second"]))

    assert load_count == 1
    assert max_active_encodes == 1
