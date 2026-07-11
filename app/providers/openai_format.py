"""
OpenAI-format provider.

Works with: OpenAI, DeepSeek, Qwen (通义千问), Moonshot, etc. —
any vendor that exposes an OpenAI-compatible chat completions API.
Set LLM_BASE_URL to point at a non-OpenAI endpoint.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from typing import Any, cast

from langchain_core.messages import BaseMessage
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from pydantic import SecretStr

from app.core.config import settings
from app.core.errors import ExternalServiceError
from app.providers.base import ChatResult, ToolCall, ToolDefinition
from app.providers.tool_schema import to_openai_tool


class OpenAIFormatProvider:
    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        embedding_model: str | None = None,
        embedding_api_key: str | None = None,
        embedding_base_url: str | None = None,
    ) -> None:
        self._model = model or settings.llm_model
        self._api_key = api_key or settings.llm_api_key
        self._base_url = base_url or settings.llm_base_url

        self._llm = ChatOpenAI(
            model=self._model,
            api_key=SecretStr(self._api_key) if self._api_key else None,
            base_url=self._base_url,
            streaming=False,
            timeout=60,
            max_retries=3,
        )
        resolved_embedding_api_key = (
            embedding_api_key or settings.embedding_api_key or self._api_key
        )
        self._embed = OpenAIEmbeddings(
            model=embedding_model or settings.embedding_model,
            api_key=(
                SecretStr(resolved_embedding_api_key) if resolved_embedding_api_key else None
            ),
            base_url=embedding_base_url or settings.embedding_base_url or self._base_url,
            timeout=60,
            max_retries=3,
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
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

        lc_msgs: list[BaseMessage] = []
        for m in messages:
            role, content = m["role"], m["content"]
            if role == "system":
                lc_msgs.append(SystemMessage(content=content))
            elif role == "user":
                lc_msgs.append(HumanMessage(content=content))
            elif role == "assistant":
                lc_msgs.append(AIMessage(content=content))

        llm = cast(Any, self._llm.bind(temperature=temperature))
        if max_tokens is not None:
            llm = llm.bind(max_tokens=max_tokens)

        try:
            if stream:
                async def _stream() -> AsyncIterator[str]:
                    try:
                        async for chunk in llm.astream(lc_msgs):
                            if chunk.content:
                                yield str(chunk.content)
                    except Exception as exc:
                        raise ExternalServiceError(f"LLM streaming call failed: {exc}") from exc
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

        lc_msgs: list[BaseMessage] = []
        for m in messages:
            role, content = m["role"], m["content"]
            if role == "system":
                lc_msgs.append(SystemMessage(content=content))
            else:
                lc_msgs.append(HumanMessage(content=content))

        structured_llm = self._llm.bind(temperature=temperature).with_structured_output(schema)
        try:
            return await structured_llm.ainvoke(lc_msgs)
        except Exception as e:
            try:
                return await self._chat_structured_via_json_prompt(
                    messages,
                    schema,
                    temperature=temperature,
                )
            except Exception as fallback_error:
                raise ExternalServiceError(
                    f"Structured LLM call failed: {e}; JSON fallback failed: {fallback_error}"
                ) from fallback_error

    async def _chat_structured_via_json_prompt(
        self,
        messages: list[dict[str, str]],
        schema: type,
        *,
        temperature: float,
    ) -> Any:
        schema_json = "{}"
        if hasattr(schema, "model_json_schema"):
            schema_json = json.dumps(schema.model_json_schema(), ensure_ascii=False)

        fallback_messages = [
            {
                "role": "system",
                "content": (
                    "Return only valid JSON. Do not wrap it in markdown. "
                    "The JSON must match this schema:\n"
                    f"{schema_json}"
                ),
            },
            *messages,
        ]
        raw = await self.chat(
            fallback_messages,
            temperature=temperature,
            max_tokens=2000,
        )
        json_text = self._extract_json_object(str(raw))

        if hasattr(schema, "model_validate_json"):
            return schema.model_validate_json(json_text)
        if hasattr(schema, "model_validate"):
            return schema.model_validate(json.loads(json_text))
        return json.loads(json_text)

    @staticmethod
    def _extract_json_object(text: str) -> str:
        stripped = text.strip()
        if stripped.startswith("```"):
            stripped = stripped.strip("`")
            if stripped.startswith("json"):
                stripped = stripped[4:].strip()

        start = stripped.find("{")
        end = stripped.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise ValueError(f"LLM did not return a JSON object: {stripped[:200]}")
        return stripped[start : end + 1]

    async def embed(self, texts: list[str]) -> list[list[float]]:
        try:
            return await self._embed.aembed_documents(texts)
        except Exception as e:
            raise ExternalServiceError(f"Embedding call failed: {e}") from e

    async def chat_with_tools(
        self,
        messages: list[dict[str, Any]],
        tools: Sequence[ToolDefinition],
        *,
        tool_choice: str | None = "auto",
        temperature: float = 0.2,
        max_tokens: int | None = None,
    ) -> ChatResult:
        llm = cast(Any, self._llm.bind(temperature=temperature))
        if max_tokens is not None:
            llm = llm.bind(max_tokens=max_tokens)
        if tools:
            llm = llm.bind_tools(
                [to_openai_tool(tool) for tool in tools],
                tool_choice=tool_choice,
            )

        try:
            result = await llm.ainvoke(_to_lc_messages(messages))
            return _chat_result_from_ai_message(result)
        except Exception as e:
            raise ExternalServiceError(f"LLM tool call failed: {e}") from e


def _to_lc_messages(messages: list[dict[str, Any]]) -> list[BaseMessage]:
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

    lc_msgs: list[BaseMessage] = []
    for message in messages:
        role = message.get("role")
        content = str(message.get("content", ""))
        if role == "system":
            lc_msgs.append(SystemMessage(content=content))
        elif role == "assistant":
            raw_tool_calls = message.get("tool_calls")
            tool_calls = raw_tool_calls if isinstance(raw_tool_calls, list) else []
            lc_msgs.append(AIMessage(content=content, tool_calls=tool_calls))
        elif role == "tool":
            lc_msgs.append(
                ToolMessage(
                    content=content,
                    tool_call_id=str(message.get("tool_call_id", message.get("name", "tool"))),
                )
            )
        else:
            lc_msgs.append(HumanMessage(content=content))
    return lc_msgs


def _chat_result_from_ai_message(message: Any) -> ChatResult:
    raw_tool_calls = getattr(message, "tool_calls", None) or []
    tool_calls = []
    for index, call in enumerate(raw_tool_calls):
        if isinstance(call, dict):
            name = call.get("name", "")
            args = call.get("args", call.get("arguments", {})) or {}
            call_id = str(call.get("id") or f"tool-call-{index}")
        else:
            name = getattr(call, "name", "")
            args = getattr(call, "args", {}) or {}
            call_id = str(getattr(call, "id", "") or f"tool-call-{index}")
        tool_calls.append(ToolCall(id=call_id, name=name, arguments=dict(args)))
    return ChatResult(content=str(getattr(message, "content", "") or ""), tool_calls=tool_calls, raw=message)
