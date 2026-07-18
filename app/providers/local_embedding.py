"""Local sentence-transformers embedding provider."""

from __future__ import annotations

import asyncio
import threading
from typing import Any, cast

from app.core.config import settings
from app.core.errors import ExternalServiceError
from app.core.observability import observation_span, sanitize_attributes


class LocalEmbeddingProvider:
    def __init__(self, model: str | None = None) -> None:
        self._model_name = model or settings.embedding_model
        self._model: Any | None = None
        self._model_lock = threading.RLock()

    def _load_model(self) -> Any:
        if self._model is not None:
            return self._model
        # Context assembly requests evidence and guideline embeddings in parallel.
        # SentenceTransformer construction is not safe to run twice concurrently
        # in one process (on macOS/PyTorch it can terminate the process in native
        # code), so guard only the cold-load path and re-check after acquiring.
        with self._model_lock:
            if self._model is not None:
                return self._model
            try:
                with observation_span(
                    "embedding_calls",
                    "local.model_load",
                    attributes={"model": self._model_name, "cold_load": True},
                ):
                    from sentence_transformers import SentenceTransformer

                    self._model = SentenceTransformer(
                        self._model_name,
                        local_files_only=settings.embedding_local_files_only,
                    )
            except Exception as e:
                raise ExternalServiceError(
                    f"Local embedding model load failed: {self._model_name}: {e}"
                ) from e
        return self._model

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        try:
            with observation_span(
                "embedding_calls",
                "local.embed",
                attributes={
                    "model": self._model_name,
                    "batch_size": len(texts),
                    "input_char_count": sum(len(text) for text in texts),
                    "cold_load": self._model is None,
                },
            ) as span:
                embeddings = await asyncio.to_thread(self._encode, texts)
                if span is not None:
                    span.attributes.update(
                        sanitize_attributes({"vector_count": len(embeddings)})
                    )
        except Exception as e:
            raise ExternalServiceError(f"Local embedding call failed: {e}") from e

        for emb in embeddings:
            if len(emb) != settings.embedding_dimensions:
                raise ExternalServiceError(
                    "Local embedding dimension mismatch: "
                    f"expected {settings.embedding_dimensions}, got {len(emb)}"
                )
        return embeddings

    def _encode(self, texts: list[str]) -> list[list[float]]:
        # The local PyTorch/SentenceTransformer stack can crash in native code
        # when the same freshly loaded model is encoded concurrently.  Keep the
        # model-local critical section serialized; callers and surrounding RAG
        # branches remain asynchronous.
        with self._model_lock:
            model = self._load_model()
            vectors = model.encode(
                texts,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
        return cast("list[list[float]]", vectors.astype(float).tolist())
