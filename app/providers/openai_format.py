"""
OpenAI-format provider.

Works with: OpenAI, DeepSeek, Qwen (通义千问), Moonshot, etc. —
any vendor that exposes an OpenAI-compatible chat completions API.
Set LLM_BASE_URL to point at a non-OpenAI endpoint.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from langchain_openai import ChatOpenAI, OpenAIEmbeddings

from app.core.config import settings
from app.core.errors import ExternalServiceError


class OpenAIFormatProvider:
    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        embedding_model: str | None = None,
    ) -> None:
        self._model = model or settings.llm_model
        self._api_key = api_key or settings.llm_api_key
        self._base_url = base_url or settings.llm_base_url

        self._llm = ChatOpenAI(
            model=self._model,
            api_key=self._api_key,  # type: ignore[arg-type]
            base_url=self._base_url,
            streaming=False,
        )
        self._embed = OpenAIEmbeddings(
            model=embedding_model or settings.embedding_model,
            api_key=self._api_key,  # type: ignore[arg-type]
            base_url=self._base_url,
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
            raise ExternalServiceError(f"LLM call failed: {e}") from e

    async def chat_structured(
        self,
        messages: list[dict[str, str]],
        schema: type,
        *,
        temperature: float = 0.2,
    ) -> Any:
        from langchain_core.messages import HumanMessage, SystemMessage

        lc_msgs = []
        for m in messages:
            role, content = m["role"], m["content"]
            if role == "system":
                lc_msgs.append(SystemMessage(content=content))
            else:
                lc_msgs.append(HumanMessage(content=content))

        structured_llm = self._llm.with_structured_output(schema)  # type: ignore[arg-type]
        try:
            return await structured_llm.ainvoke(lc_msgs)
        except Exception as e:
            raise ExternalServiceError(f"Structured LLM call failed: {e}") from e

    async def embed(self, texts: list[str]) -> list[list[float]]:
        try:
            return await self._embed.aembed_documents(texts)
        except Exception as e:
            raise ExternalServiceError(f"Embedding call failed: {e}") from e
