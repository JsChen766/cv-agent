from __future__ import annotations

from functools import lru_cache

from app.core.config import settings
from app.providers.base import EmbeddingProvider, LLMProvider


@lru_cache(maxsize=1)
def get_provider() -> LLMProvider:
    """Return the configured LLM provider singleton."""
    if settings.llm_provider == "anthropic":
        from app.providers.anthropic_format import AnthropicFormatProvider
        return AnthropicFormatProvider()
    # Default: OpenAI format (covers OpenAI, DeepSeek, Qwen, Moonshot, etc.)
    from app.providers.openai_format import OpenAIFormatProvider
    return OpenAIFormatProvider()


@lru_cache(maxsize=1)
def get_embedding_provider() -> EmbeddingProvider:
    """Return the configured embedding provider singleton."""
    if settings.embedding_provider == "local":
        from app.providers.local_embedding import LocalEmbeddingProvider
        return LocalEmbeddingProvider()

    from app.providers.openai_format import OpenAIFormatProvider
    return OpenAIFormatProvider()
