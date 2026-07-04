from __future__ import annotations

from functools import lru_cache

from app.core.config import settings


@lru_cache(maxsize=1)
def get_provider():
    """Return the configured LLM provider singleton."""
    if settings.llm_provider == "anthropic":
        from app.providers.anthropic_format import AnthropicFormatProvider
        return AnthropicFormatProvider()
    # Default: OpenAI format (covers OpenAI, DeepSeek, Qwen, Moonshot, etc.)
    from app.providers.openai_format import OpenAIFormatProvider
    return OpenAIFormatProvider()


@lru_cache(maxsize=1)
def get_embedding_provider():
    """Return the embedding provider singleton (always OpenAI-format for now)."""
    from app.providers.openai_format import OpenAIFormatProvider
    return OpenAIFormatProvider()
