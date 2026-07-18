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
from app.core.observability import observation_span, sanitize_attributes
from app.providers.base import (
    ChatResult,
    TokenCallback,
    ToolCall,
    ToolDefinition,
    forward_visible_tokens,
    text_from_content,
    token_usage_from_message,
    visible_token_chunks,
)
from app.providers.retry import RetryStats, run_with_transport_retries
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
            max_retries=0,
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

        if stream:
            async def _stream() -> AsyncIterator[str]:
                try:
                    with observation_span(
                        "llm_calls",
                        "chat_stream",
                        attributes=_anthropic_attributes(self, mode="stream"),
                    ) as span:
                        async for chunk in llm.astream(lc_msgs):
                            text = text_from_content(getattr(chunk, "content", ""))
                            async for part in visible_token_chunks(text):
                                yield part
                        _update_anthropic_span(span, RetryStats(attempts=1), None)
                except Exception as exc:
                    raise ExternalServiceError(
                        f"Anthropic streaming call failed: {exc}"
                    ) from exc
            return _stream()

        stats = RetryStats()
        try:
            with observation_span(
                "llm_calls", "chat", attributes=_anthropic_attributes(self, mode="text")
            ) as span:
                result = await run_with_transport_retries(
                    lambda: llm.ainvoke(lc_msgs),
                    max_retries=settings.llm_max_transport_retries,
                    stats=stats,
                )
                _update_anthropic_span(span, stats, result)
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
        bound = self._llm.bind(temperature=temperature)
        try:
            structured_llm = bound.with_structured_output(schema, include_raw=True)
        except TypeError:
            structured_llm = bound.with_structured_output(schema)
        stats = RetryStats()
        try:
            with observation_span(
                "llm_calls",
                "chat_structured",
                attributes={
                    **_anthropic_attributes(self, mode="structured"),
                    "schema_name": getattr(schema, "__name__", str(schema)),
                    "protocol": "anthropic_tool_schema",
                },
            ) as span:
                result = await run_with_transport_retries(
                    lambda: structured_llm.ainvoke(lc_msgs),
                    max_retries=settings.llm_max_transport_retries,
                    stats=stats,
                )
                parsed, raw = _unwrap_anthropic_structured(result)
                _update_anthropic_span(span, stats, raw, protocol_attempt_count=1)
                return parsed
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

        stats = RetryStats()
        try:
            with observation_span(
                "llm_calls",
                "chat_with_tools",
                attributes=_anthropic_attributes(self, mode="tools"),
            ) as span:
                result = await run_with_transport_retries(
                    lambda: llm.ainvoke(_to_lc_messages(messages)),
                    max_retries=settings.llm_max_transport_retries,
                    stats=stats,
                )
                _update_anthropic_span(span, stats, result)
                return _chat_result_from_ai_message(result)
        except Exception as e:
            raise ExternalServiceError(f"Anthropic tool call failed: {e}") from e

    async def chat_with_tools_stream(
        self,
        messages: list[dict[str, Any]],
        tools: Sequence[ToolDefinition],
        *,
        on_token: TokenCallback | None = None,
        tool_choice: str | None = "auto",
        temperature: float = 0.2,
        max_tokens: int | None = None,
    ) -> ChatResult:
        """Stream a tool-enabled response while rebuilding final tool calls."""
        llm = cast(Any, self._llm.bind(temperature=temperature))
        if max_tokens is not None:
            llm = llm.bind(max_tokens=max_tokens)
        if tools:
            llm = llm.bind_tools(
                [to_anthropic_tool(tool) for tool in tools],
                tool_choice=tool_choice,
            )

        try:
            with observation_span(
                "llm_calls",
                "chat_with_tools_stream",
                attributes=_anthropic_attributes(self, mode="tools_stream"),
            ) as span:
                message = None
                async for chunk in llm.astream(_to_lc_messages(messages)):
                    text = text_from_content(getattr(chunk, "content", ""))
                    await forward_visible_tokens(on_token, text)
                    message = chunk if message is None else message + chunk
                _update_anthropic_span(span, RetryStats(attempts=1), message)
                return (
                    _chat_result_from_ai_message(message)
                    if message is not None
                    else ChatResult()
                )
        except Exception as e:
            raise ExternalServiceError(f"Anthropic tool streaming call failed: {e}") from e


def _anthropic_attributes(
    provider: AnthropicFormatProvider, *, mode: str
) -> dict[str, object]:
    return {
        "provider": "anthropic_format",
        "model": getattr(provider, "_model", "unknown"),
        "mode": mode,
    }


def _update_anthropic_span(
    span: Any,
    stats: RetryStats,
    message: Any | None,
    *,
    protocol_attempt_count: int | None = None,
) -> None:
    if span is None:
        return
    usage = token_usage_from_message(message) if message is not None else None
    values: dict[str, object] = {
        "logical_call_count": 1,
        "physical_request_count": stats.attempts,
        "transport_attempts": stats.attempts,
        "retry_count": stats.retries,
        "usage_available": usage.available if usage else False,
    }
    if usage:
        values.update(
            {
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "total_tokens": usage.total_tokens,
            }
        )
    if protocol_attempt_count is not None:
        values["protocol_attempt_count"] = protocol_attempt_count
    span.attributes.update(sanitize_attributes(values))


def _unwrap_anthropic_structured(result: Any) -> tuple[Any, Any | None]:
    if isinstance(result, dict) and "parsed" in result:
        parsing_error = result.get("parsing_error")
        if parsing_error is not None:
            raise parsing_error
        return result.get("parsed"), result.get("raw")
    return result, getattr(result, "raw", None)


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
    return ChatResult(
        content=text_from_content(getattr(message, "content", "")),
        tool_calls=tool_calls,
        raw=message,
    )
