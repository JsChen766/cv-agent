"""
Anthropic-format provider (Claude models).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from langchain_anthropic import ChatAnthropic

from app.core.config import settings
from app.core.errors import ExternalServiceError


class AnthropicFormatProvider:
    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
    ) -> None:
        self._model = model or settings.llm_model
        self._llm = ChatAnthropic(
            model=self._model,
            api_key=api_key or settings.llm_api_key,  # type: ignore[arg-type]
        )

    async def chat(
        self,
        messages: list[dict[str, str]],
        *,
        stream: bool = False,
        response_format: type | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
    ) -> str | AsyncIterator[str]:
        from langchain_core.messages import HumanMessage, SystemMessage, AIMessage

        lc_msgs = []
        for m in messages:
            role, content = m["role"], m["content"]
            if role == "system":
                lc_msgs.append(SystemMessage(content=content))
            elif role == "user":
                lc_msgs.append(HumanMessage(content=content))
            elif role == "assistant":
                lc_msgs.append(AIMessage(content=content))

        llm = self._llm.with_config({"temperature": temperature})
        if max_tokens:
            llm = llm.bind(max_tokens=max_tokens)

        try:
            if stream:
                async def _stream() -> AsyncIterator[str]:
                    async for chunk in llm.astream(lc_msgs):
                        if chunk.content:
                            yield str(chunk.content)
                return _stream()
            else:
                result = await llm.ainvoke(lc_msgs)
                return str(result.content)
        except Exception as e:
            raise ExternalServiceError(f"Anthropic call failed: {e}") from e

    async def chat_structured(
        self,
        messages: list[dict[str, str]],
        schema: type,
        *,
        temperature: float = 0.2,
    ) -> Any:
        from langchain_core.messages import HumanMessage, SystemMessage

        lc_msgs = [
            SystemMessage(content=m["content"]) if m["role"] == "system"
            else HumanMessage(content=m["content"])
            for m in messages
        ]
        structured_llm = self._llm.with_structured_output(schema)  # type: ignore[arg-type]
        try:
            return await structured_llm.ainvoke(lc_msgs)
        except Exception as e:
            raise ExternalServiceError(f"Anthropic structured call failed: {e}") from e

    async def embed(self, texts: list[str]) -> list[list[float]]:
        # Anthropic doesn't provide embeddings; use OpenAI format as fallback
        from app.providers.openai_format import OpenAIFormatProvider
        fallback = OpenAIFormatProvider()
        return await fallback.embed(texts)
