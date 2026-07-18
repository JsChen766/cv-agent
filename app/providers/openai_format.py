"""
OpenAI-format provider.

Works with: OpenAI, DeepSeek, Qwen (通义千问), Moonshot, etc. —
any vendor that exposes an OpenAI-compatible chat completions API.
Set LLM_BASE_URL to point at a non-OpenAI endpoint.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from functools import partial
from typing import Any, cast

from langchain_core.messages import BaseMessage
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from pydantic import SecretStr

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
            max_retries=0,
        )
        resolved_embedding_api_key = (
            embedding_api_key or settings.embedding_api_key or self._api_key
        )
        self._embedding_model = embedding_model or settings.embedding_model
        self._embed = OpenAIEmbeddings(
            model=self._embedding_model,
            api_key=(
                SecretStr(resolved_embedding_api_key) if resolved_embedding_api_key else None
            ),
            base_url=embedding_base_url or settings.embedding_base_url or self._base_url,
            timeout=60,
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
                stats = RetryStats()
                emitted = False
                try:
                    with observation_span(
                        "llm_calls",
                        "chat_stream",
                        attributes=_llm_attributes(self, mode="stream"),
                    ) as span:
                        # A stream can only be retried safely before the first visible token.
                        for attempt in range(settings.llm_max_transport_retries + 1):
                            stats.attempts += 1
                            try:
                                async for chunk in llm.astream(lc_msgs):
                                    text = text_from_content(getattr(chunk, "content", ""))
                                    async for part in visible_token_chunks(text):
                                        emitted = True
                                        yield part
                                break
                            except Exception:
                                if emitted or attempt >= settings.llm_max_transport_retries:
                                    raise
                                stats.retries += 1
                        _update_span(span, stats=stats)
                except Exception as exc:
                    raise ExternalServiceError(f"LLM streaming call failed: {exc}") from exc
            return _stream()

        stats = RetryStats()
        try:
            with observation_span(
                "llm_calls", "chat", attributes=_llm_attributes(self, mode="text")
            ) as span:
                result = await run_with_transport_retries(
                    lambda: llm.ainvoke(lc_msgs),
                    max_retries=settings.llm_max_transport_retries,
                    stats=stats,
                )
                _update_span(span, stats=stats, message=result)
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
        """Structured output with a 3-tier compatibility ladder:

        1. `method="json_mode"` — sends `response_format={"type":"json_object"}`.
           Supported by OpenAI proper, DeepSeek, Qwen, Moonshot, etc. Client-side
           schema validation via LangChain.
        2. `method="json_schema"` — sends `response_format={"type":"json_schema", ...}`.
           OpenAI's server-side enforcement path; vendors that don't support it
           (e.g. DeepSeek returns "This response_format type is unavailable now")
           get skipped by tier 1 first.
        3. Prompt-based JSON — schema shipped as text in the system prompt, no
           `response_format` at all. Works on any vendor. Client-side validated.
        """
        from langchain_core.messages import HumanMessage, SystemMessage

        # OpenAI-compatible JSON mode rejects requests whose prompt never
        # mentions JSON, even when the structured-output wrapper supplies the
        # response format. Make the contract explicit for every structured
        # call so vendor-specific prompts cannot trigger a 400.
        normalized_messages = _ensure_json_mode_prompt(messages)

        lc_msgs: list[BaseMessage] = []
        for m in normalized_messages:
            role, content = m["role"], m["content"]
            if role == "system":
                lc_msgs.append(SystemMessage(content=content))
            else:
                lc_msgs.append(HumanMessage(content=content))

        bound = self._llm.bind(temperature=temperature)
        total_stats = RetryStats()
        protocol_attempts: list[dict[str, object]] = []
        schema_name = getattr(schema, "__name__", str(schema))
        try:
            with observation_span(
                "llm_calls",
                "chat_structured",
                attributes={
                    **_llm_attributes(self, mode="structured"),
                    "schema_name": schema_name,
                },
            ) as span:
                first_error: Exception | None = None
                for method in ("json_mode", "json_schema"):
                    protocol_stats = RetryStats()
                    try:
                        structured_llm = _structured_with_raw(bound, schema, method)
                        raw_result = await run_with_transport_retries(
                            partial(_invoke, structured_llm, lc_msgs),
                            max_retries=settings.llm_max_transport_retries,
                            stats=protocol_stats,
                        )
                        parsed, raw_message = _unwrap_structured_result(raw_result)
                    except Exception as exc:
                        first_error = first_error or exc
                        protocol_attempts.append(
                            {
                                "protocol": method,
                                "status": "failed",
                                "transport_attempts": protocol_stats.attempts,
                                "error_category": exc.__class__.__name__,
                            }
                        )
                        total_stats.attempts += protocol_stats.attempts
                        total_stats.retries += protocol_stats.retries
                        continue
                    protocol_attempts.append(
                        {
                            "protocol": method,
                            "status": "completed",
                            "transport_attempts": protocol_stats.attempts,
                        }
                    )
                    total_stats.attempts += protocol_stats.attempts
                    total_stats.retries += protocol_stats.retries
                    _update_span(
                        span,
                        stats=total_stats,
                        message=raw_message,
                        protocol=method,
                        protocol_attempts=protocol_attempts,
                    )
                    return parsed

                protocol_stats = RetryStats()
                try:
                    parsed, raw_message = await self._chat_structured_via_json_prompt(
                        normalized_messages,
                        schema,
                        temperature=temperature,
                        retry_stats=protocol_stats,
                    )
                except Exception as fallback_error:
                    protocol_attempts.append(
                        {
                            "protocol": "json_prompt",
                            "status": "failed",
                            "transport_attempts": protocol_stats.attempts,
                            "error_category": fallback_error.__class__.__name__,
                        }
                    )
                    total_stats.attempts += protocol_stats.attempts
                    total_stats.retries += protocol_stats.retries
                    _update_span(
                        span,
                        stats=total_stats,
                        protocol="json_prompt",
                        protocol_attempts=protocol_attempts,
                    )
                    raise ExternalServiceError(
                        f"Structured LLM call failed: {first_error}; "
                        f"prompt fallback failed: {fallback_error}"
                    ) from fallback_error
                protocol_attempts.append(
                    {
                        "protocol": "json_prompt",
                        "status": "completed",
                        "transport_attempts": protocol_stats.attempts,
                    }
                )
                total_stats.attempts += protocol_stats.attempts
                total_stats.retries += protocol_stats.retries
                _update_span(
                    span,
                    stats=total_stats,
                    message=raw_message,
                    protocol="json_prompt",
                    protocol_attempts=protocol_attempts,
                )
                return parsed
        except ExternalServiceError:
            raise
        except Exception as exc:
            raise ExternalServiceError(f"Structured LLM call failed: {exc}") from exc

    async def _chat_structured_via_json_prompt(
        self,
        messages: list[dict[str, str]],
        schema: type,
        *,
        temperature: float,
        retry_stats: RetryStats,
    ) -> tuple[Any, Any]:
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
        # No max_tokens cap: a full resume JSON with multiple experiences easily
        # exceeds 2k tokens; letting the vendor default apply avoids truncation.
        llm = self._llm.bind(temperature=temperature)
        raw_message = await run_with_transport_retries(
            lambda: llm.ainvoke(_to_lc_messages(fallback_messages)),
            max_retries=settings.llm_max_transport_retries,
            stats=retry_stats,
        )
        json_text = self._extract_json_object(text_from_content(raw_message.content))

        if hasattr(schema, "model_validate_json"):
            return schema.model_validate_json(json_text), raw_message
        if hasattr(schema, "model_validate"):
            return schema.model_validate(json.loads(json_text)), raw_message
        return json.loads(json_text), raw_message


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
        stats = RetryStats()
        try:
            with observation_span(
                "embedding_calls",
                "openai.embed",
                attributes={
                    "model": getattr(self, "_embedding_model", settings.embedding_model),
                    "batch_size": len(texts),
                    "input_char_count": sum(len(text) for text in texts),
                },
            ) as span:
                vectors = await run_with_transport_retries(
                    lambda: self._embed.aembed_documents(texts),
                    max_retries=settings.embedding_max_transport_retries,
                    stats=stats,
                )
                if span is not None:
                    span.attributes.update(
                        sanitize_attributes(
                            {
                                "transport_attempts": stats.attempts,
                                "retry_count": stats.retries,
                                "vector_count": len(vectors),
                            }
                        )
                    )
                return vectors
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

        stats = RetryStats()
        try:
            with observation_span(
                "llm_calls", "chat_with_tools", attributes=_llm_attributes(self, mode="tools")
            ) as span:
                result = await run_with_transport_retries(
                    lambda: llm.ainvoke(_to_lc_messages(messages)),
                    max_retries=settings.llm_max_transport_retries,
                    stats=stats,
                )
                _update_span(span, stats=stats, message=result)
                return _chat_result_from_ai_message(result)
        except Exception as e:
            raise ExternalServiceError(f"LLM tool call failed: {e}") from e

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
        """Stream a tool-enabled response and preserve its final tool calls.

        LangChain emits ``AIMessageChunk`` values for both text and partial tool
        arguments. Adding the chunks back together lets LangChain reconstruct
        the complete tool-call payload before it is parsed into ``ChatResult``.
        """
        llm = cast(Any, self._llm.bind(temperature=temperature))
        if max_tokens is not None:
            llm = llm.bind(max_tokens=max_tokens)
        if tools:
            llm = llm.bind_tools(
                [to_openai_tool(tool) for tool in tools],
                tool_choice=tool_choice,
            )

        try:
            with observation_span(
                "llm_calls",
                "chat_with_tools_stream",
                attributes=_llm_attributes(self, mode="tools_stream"),
            ) as span:
                message = None
                async for chunk in llm.astream(_to_lc_messages(messages)):
                    text = text_from_content(getattr(chunk, "content", ""))
                    await forward_visible_tokens(on_token, text)
                    message = chunk if message is None else message + chunk
                _update_span(span, stats=RetryStats(attempts=1), message=message)
                return (
                    _chat_result_from_ai_message(message)
                    if message is not None
                    else ChatResult()
                )
        except Exception as e:
            raise ExternalServiceError(f"LLM tool streaming call failed: {e}") from e


def _llm_attributes(
    provider: OpenAIFormatProvider, *, mode: str
) -> dict[str, object]:
    return {
        "provider": "openai_format",
        "model": getattr(provider, "_model", "unknown"),
        "mode": mode,
    }


def _update_span(
    span: Any,
    *,
    stats: RetryStats,
    message: Any | None = None,
    protocol: str | None = None,
    protocol_attempts: list[dict[str, object]] | None = None,
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
    if protocol is not None:
        values["protocol"] = protocol
    if protocol_attempts is not None:
        values["protocol_attempt_count"] = len(protocol_attempts)
        values["protocol_attempts"] = protocol_attempts
    span.attributes.update(sanitize_attributes(values))


def _structured_with_raw(bound: Any, schema: type, method: str) -> Any:
    try:
        return bound.with_structured_output(schema, method=method, include_raw=True)
    except TypeError:
        # Small local fakes and older compatible LangChain versions may not
        # expose include_raw. The public provider result remains unchanged.
        return bound.with_structured_output(schema, method=method)


def _unwrap_structured_result(result: Any) -> tuple[Any, Any | None]:
    if isinstance(result, dict) and "parsed" in result:
        parsing_error = result.get("parsing_error")
        if parsing_error is not None:
            raise parsing_error
        return result.get("parsed"), result.get("raw")
    return result, getattr(result, "raw", None)


async def _invoke(runnable: Any, messages: list[BaseMessage]) -> Any:
    return await runnable.ainvoke(messages)


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


def _ensure_json_mode_prompt(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    """Return a copied message list that explicitly requests a JSON object."""
    normalized = [dict(message) for message in messages]
    if any("json" in str(message.get("content", "")).lower() for message in normalized):
        return normalized

    for message in normalized:
        if message.get("role") == "system":
            message["content"] = (
                f"{message.get('content', '')}\n\n"
                "Return the answer as a valid JSON object."
            )
            return normalized

    normalized.insert(
        0,
        {"role": "system", "content": "Return the answer as a valid JSON object."},
    )
    return normalized
