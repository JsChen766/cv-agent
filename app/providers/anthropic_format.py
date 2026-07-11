"""
Anthropic-format provider (Claude models).
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from typing import Any, cast

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import BaseMessage

from app.core.config import settings
from app.core.errors import ExternalServiceError
from app.providers.base import ChatResult, ToolCall, ToolDefinition
from app.providers.tool_schema import to_anthropic_tool


class AnthropicFormatProvider:
    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
    ) -> None:
        self._model = model or settings.llm_model
        self._llm = ChatAnthropic(
            model_name=self._model,
            api_key=api_key or settings.llm_api_key,  # type: ignore[arg-type]
            timeout=None,
            stop=None,
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
                        raise ExternalServiceError(
                            f"Anthropic streaming call failed: {exc}"
                        ) from exc
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
        structured_llm = self._llm.bind(temperature=temperature).with_structured_output(schema)
        try:
            return await structured_llm.ainvoke(lc_msgs)
        except Exception as e:
            raise ExternalServiceError(f"Anthropic structured call failed: {e}") from e

    async def embed(self, texts: list[str]) -> list[list[float]]:
        # Anthropic doesn't provide embeddings; use OpenAI format as fallback
        from app.providers.openai_format import OpenAIFormatProvider
        fallback = OpenAIFormatProvider()
        return await fallback.embed(texts)

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
                [to_anthropic_tool(tool) for tool in tools],
                tool_choice=tool_choice,
            )

        try:
            result = await llm.ainvoke(_to_lc_messages(messages))
            return _chat_result_from_ai_message(result)
        except Exception as e:
            raise ExternalServiceError(f"Anthropic tool call failed: {e}") from e


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
