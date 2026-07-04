"""Local sentence-transformers embedding provider."""

from __future__ import annotations

import asyncio
from typing import Any

from app.core.config import settings
from app.core.errors import ExternalServiceError


class LocalEmbeddingProvider:
    def __init__(self, model: str | None = None) -> None:
        self._model_name = model or settings.embedding_model
        self._model: Any | None = None

    def _load_model(self) -> Any:
        if self._model is None:
            try:
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
            embeddings = await asyncio.to_thread(self._encode, texts)
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
        model = self._load_model()
        vectors = model.encode(
            texts,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        return vectors.astype(float).tolist()
