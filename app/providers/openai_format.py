"""
OpenAI-format provider.

Works with: OpenAI, DeepSeek, Qwen (通义千问), Moonshot, etc. —
any vendor that exposes an OpenAI-compatible chat completions API.
Set LLM_BASE_URL to point at a non-OpenAI endpoint.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Sequence
from functools import partial
from typing import Any, cast

from json_repair import repair_json
from langchain_core.messages import BaseMessage
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from pydantic import SecretStr

from app.core.config import settings
from app.core.errors import ExternalServiceError
from app.core.observability import observation_span, sanitize_attributes
from app.providers.base import (
    ChatResult,
    StructuredCallBudgetError,
    StructuredCallResult,
    TokenCallback,
    ToolCall,
    ToolDefinition,
    forward_visible_tokens,
    text_from_content,
    token_usage_from_message,
    visible_token_chunks,
)
from app.providers.retry import (
    RetryStats,
    is_retryable_transport_error,
    run_with_transport_retries,
)
from app.providers.tool_schema import to_openai_tool

logger = logging.getLogger(__name__)


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
        # A provider/model endpoint normally supports one stable structured-output
        # protocol. Remember the last successful mode so subsequent logical calls
        # do not repeat the compatibility ladder. A later failure still falls back
        # through the remaining modes and refreshes the cached capability.
        self._json_schema_supported = _endpoint_supports_json_schema(self._base_url)
        # DeepSeek supports json_object but LangChain's with_structured_output
        # json_mode path often fails Pydantic validation, wasting a full API round
        # trip before falling back to json_prompt. Skip straight to json_prompt.
        self._structured_protocol: str | None = (
            "json_prompt" if not self._json_schema_supported else None
        )

        self._llm = ChatOpenAI(
            model=self._model,
            api_key=SecretStr(self._api_key) if self._api_key else None,
            base_url=self._base_url,
            streaming=False,
            timeout=120,
            max_retries=0,
        )
        resolved_embedding_api_key = (
            embedding_api_key or settings.embedding_api_key or self._api_key
        )
        self._embedding_model = embedding_model or settings.embedding_model
        self._embed = OpenAIEmbeddings(
            model=self._embedding_model,
            api_key=(SecretStr(resolved_embedding_api_key) if resolved_embedding_api_key else None),
            base_url=embedding_base_url or settings.embedding_base_url or self._base_url,
            timeout=60,
            max_retries=0,
        )

    def _bind_chat(self, *, temperature: float) -> Any:
        options: dict[str, Any] = {"temperature": temperature}
        base_url = getattr(self, "_base_url", None)
        if base_url and "deepseek.com" in base_url.lower():
            # DeepSeek V4 enables thinking by default. The resume pipeline needs
            # bounded, directly usable output for both prose and structured calls;
            # otherwise package drafting can spend thousands of tokens reasoning
            # before returning the small artifact requested by the caller.
            options["extra_body"] = {"thinking": {"type": "disabled"}}
        return cast(Any, self._llm.bind(**options))

    def _bind_structured(self, *, temperature: float) -> Any:
        return self._bind_chat(temperature=temperature)

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

        llm = self._bind_chat(temperature=temperature)
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

        bound = self._bind_structured(temperature=temperature)
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
                preferred_protocol = getattr(self, "_structured_protocol", None)
                supports_json_schema = getattr(self, "_json_schema_supported", True)
                for method in _structured_protocol_order(
                    preferred_protocol,
                    supports_json_schema=supports_json_schema,
                ):
                    protocol_stats = RetryStats()
                    try:
                        if method == "json_prompt":
                            (
                                parsed,
                                raw_message,
                                repaired,
                            ) = await self._chat_structured_via_json_prompt(
                                normalized_messages,
                                schema,
                                temperature=temperature,
                                retry_stats=protocol_stats,
                            )
                        else:
                            structured_llm = _structured_with_raw(bound, schema, method)
                            raw_result = await run_with_transport_retries(
                                partial(_invoke, structured_llm, lc_msgs),
                                max_retries=settings.llm_max_transport_retries,
                                stats=protocol_stats,
                            )
                            parsed, raw_message, repaired = _unwrap_structured_result(
                                raw_result,
                                schema,
                            )
                    except Exception as exc:
                        first_error = first_error or exc
                        logger.warning(
                            "chat_structured protocol %s failed for %s: %s",
                            method,
                            schema_name,
                            exc,
                        )
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
                        if method == preferred_protocol:
                            self._structured_protocol = None
                        continue
                    protocol_attempts.append(
                        {
                            "protocol": method,
                            "status": "completed",
                            "transport_attempts": protocol_stats.attempts,
                            "repaired": repaired,
                        }
                    )
                    total_stats.attempts += protocol_stats.attempts
                    total_stats.retries += protocol_stats.retries
                    self._structured_protocol = method
                    _update_span(
                        span,
                        stats=total_stats,
                        message=raw_message,
                        protocol=method,
                        protocol_attempts=protocol_attempts,
                    )
                    return parsed
                _update_span(
                    span,
                    stats=total_stats,
                    protocol=preferred_protocol or "json_mode",
                    protocol_attempts=protocol_attempts,
                )
                raise ExternalServiceError(
                    "模型未能返回有效的结构化内容，自动修复与重试均已失败，请重试。",
                    code="llm_structured_output_failed",
                    retryable=True,
                ) from first_error
        except ExternalServiceError:
            raise
        except Exception as exc:
            raise ExternalServiceError(f"Structured LLM call failed: {exc}") from exc

    async def chat_structured_bounded(
        self,
        messages: list[dict[str, str]],
        schema: type,
        *,
        temperature: float = 0.2,
        deadline_seconds: float,
        max_attempts: int,
    ) -> StructuredCallResult:
        """Structured call with one deadline and one shared physical-request budget."""
        normalized_messages = _ensure_json_mode_prompt(messages)
        lc_messages = _to_lc_messages(normalized_messages)
        bound = self._bind_structured(temperature=temperature)
        protocols = _structured_protocol_order(
            self._structured_protocol,
            supports_json_schema=self._json_schema_supported,
        )
        protocol_index = 0
        attempts = 0
        first_error: Exception | None = None
        last_protocol: str | None = None
        schema_name = getattr(schema, "__name__", str(schema))
        try:
            async with asyncio.timeout(deadline_seconds):
                with observation_span(
                    "llm_calls",
                    "chat_structured_bounded",
                    attributes={
                        **_llm_attributes(self, mode="structured_bounded"),
                        "schema_name": schema_name,
                        "max_physical_attempts": max_attempts,
                        "deadline_seconds": deadline_seconds,
                    },
                ) as span:
                    while attempts < max_attempts:
                        method = protocols[min(protocol_index, len(protocols) - 1)]
                        last_protocol = method
                        attempts += 1
                        raw_message: Any | None = None
                        try:
                            if method == "json_prompt":
                                fallback_messages = _json_prompt_messages(
                                    normalized_messages,
                                    schema,
                                )
                                raw_message = await self._bind_structured(
                                    temperature=temperature
                                ).ainvoke(_to_lc_messages(fallback_messages))
                                parsed, repaired = _parse_structured_text(
                                    text_from_content(raw_message.content),
                                    schema,
                                )
                            else:
                                structured_llm = _structured_with_raw(bound, schema, method)
                                raw_result = await _invoke(structured_llm, lc_messages)
                                parsed, raw_message, repaired = _unwrap_structured_result(
                                    raw_result,
                                    schema,
                                )
                        except asyncio.CancelledError:
                            raise
                        except Exception as exc:
                            first_error = first_error or exc
                            if not is_retryable_transport_error(exc):
                                protocol_index += 1
                            continue
                        self._structured_protocol = method
                        _update_span(
                            span,
                            stats=RetryStats(
                                attempts=attempts,
                                retries=max(0, attempts - 1),
                            ),
                            message=raw_message,
                            protocol=method,
                            protocol_attempts=[
                                {
                                    "protocol": method,
                                    "status": "completed",
                                    "physical_attempts": attempts,
                                    "repaired": repaired,
                                }
                            ],
                        )
                        return StructuredCallResult(
                            value=parsed,
                            attempts=attempts,
                            protocol=method,
                        )
        except TimeoutError as exc:
            raise StructuredCallBudgetError(
                "Structured LLM call exceeded its shared deadline.",
                attempts=attempts,
                protocol=last_protocol,
                error_category="TimeoutError",
            ) from exc
        raise StructuredCallBudgetError(
            "Structured LLM call exhausted its physical request budget.",
            attempts=attempts,
            protocol=last_protocol,
            error_category=(
                first_error.__class__.__name__ if first_error is not None else "UnknownError"
            ),
        ) from first_error

    async def chat_structured_stream_bounded(
        self,
        messages: list[dict[str, str]],
        schema: type,
        *,
        temperature: float = 0.2,
        first_token_timeout_seconds: float,
        idle_timeout_seconds: float,
        deadline_seconds: float,
        max_attempts: int,
        max_tokens: int | None = None,
        on_token: TokenCallback | None = None,
    ) -> StructuredCallResult:
        """Stream one compact JSON response with first-token and idle deadlines."""
        normalized_messages = _ensure_json_mode_prompt(messages)
        stream_messages = _json_prompt_messages(normalized_messages, schema)
        lc_messages = _to_lc_messages(stream_messages)
        llm = self._bind_structured(temperature=temperature)
        if max_tokens is not None:
            llm = llm.bind(max_tokens=max_tokens)

        loop = asyncio.get_running_loop()
        deadline_at = loop.time() + deadline_seconds
        attempts = 0
        first_error: Exception | None = None
        error_category = "UnknownError"
        schema_name = getattr(schema, "__name__", str(schema))
        with observation_span(
            "llm_calls",
            "chat_structured_stream_bounded",
            attributes={
                **_llm_attributes(self, mode="structured_stream_bounded"),
                "schema_name": schema_name,
                "max_physical_attempts": max_attempts,
                "deadline_seconds": deadline_seconds,
                "first_token_timeout_seconds": first_token_timeout_seconds,
                "idle_timeout_seconds": idle_timeout_seconds,
                "max_tokens": max_tokens,
            },
        ) as span:
            while attempts < max_attempts:
                remaining = deadline_at - loop.time()
                if remaining <= 0:
                    error_category = "DeadlineTimeout"
                    break
                attempts += 1
                chunks: list[str] = []
                emitted = False
                last_message: Any | None = None
                stream = llm.astream(lc_messages).__aiter__()
                try:
                    while True:
                        remaining = deadline_at - loop.time()
                        if remaining <= 0:
                            raise TimeoutError("stream deadline exceeded")
                        token_timeout = (
                            idle_timeout_seconds if emitted else first_token_timeout_seconds
                        )
                        try:
                            message = await asyncio.wait_for(
                                anext(stream),
                                timeout=min(token_timeout, remaining),
                            )
                        except StopAsyncIteration:
                            break
                        last_message = message
                        # Reasoning-capable OpenAI-format endpoints may stream many
                        # chunks in `reasoning_content` before the first final
                        # `content` token. Any received chunk proves that the stream
                        # is alive and must refresh the first-token/idle deadline,
                        # while only final content is accumulated for JSON parsing.
                        emitted = True
                        text = text_from_content(getattr(message, "content", ""))
                        if on_token is not None:
                            on_token(text)
                        if not text:
                            continue
                        chunks.append(text)
                    parsed, repaired = _parse_structured_text("".join(chunks), schema)
                except asyncio.CancelledError:
                    raise
                except TimeoutError as exc:
                    first_error = first_error or exc
                    if loop.time() >= deadline_at - 1e-6:
                        error_category = "DeadlineTimeout"
                        break
                    error_category = "IdleTimeout" if emitted else "FirstTokenTimeout"
                    continue
                except Exception as exc:
                    first_error = first_error or exc
                    error_category = exc.__class__.__name__
                    continue

                _update_span(
                    span,
                    stats=RetryStats(attempts=attempts, retries=max(0, attempts - 1)),
                    message=last_message,
                    protocol="json_prompt_stream",
                    protocol_attempts=[
                        {
                            "protocol": "json_prompt_stream",
                            "status": "completed",
                            "physical_attempts": attempts,
                            "repaired": repaired,
                        }
                    ],
                )
                return StructuredCallResult(
                    value=parsed,
                    attempts=attempts,
                    protocol="json_prompt_stream",
                )

            _update_span(
                span,
                stats=RetryStats(attempts=attempts, retries=max(0, attempts - 1)),
                protocol="json_prompt_stream",
            )
            raise StructuredCallBudgetError(
                "Structured streaming LLM call did not complete within its budget.",
                attempts=attempts,
                protocol="json_prompt_stream",
                error_category=error_category,
            ) from first_error

    async def _chat_structured_via_json_prompt(
        self,
        messages: list[dict[str, str]],
        schema: type,
        *,
        temperature: float,
        retry_stats: RetryStats,
    ) -> tuple[Any, Any, bool]:
        fallback_messages = _json_prompt_messages(messages, schema)
        # No max_tokens cap: a full resume JSON with multiple experiences easily
        # exceeds 2k tokens; letting the vendor default apply avoids truncation.
        llm = self._bind_structured(temperature=temperature)
        raw_message = await run_with_transport_retries(
            lambda: llm.ainvoke(_to_lc_messages(fallback_messages)),
            max_retries=settings.llm_max_transport_retries,
            stats=retry_stats,
        )
        parsed, repaired = _parse_structured_text(
            text_from_content(raw_message.content),
            schema,
        )
        return parsed, raw_message, repaired

    async def chat_json(
        self,
        messages: list[dict[str, str]],
        schema: type,
        *,
        temperature: float = 0.2,
    ) -> Any:
        """Lightweight structured output: json_object response_format + manual parse.

        Skips the protocol ladder entirely. The caller is responsible for
        including output-format instructions in the prompt. Faster than
        ``chat_structured`` because it makes exactly one HTTP call with
        server-side JSON enforcement.
        """
        stats = RetryStats()
        try:
            with observation_span(
                "llm_calls",
                "chat_json",
                attributes={
                    **_llm_attributes(self, mode="json"),
                    "schema_name": getattr(schema, "__name__", str(schema)),
                },
            ) as span:
                llm = self._bind_chat(temperature=temperature).bind(
                    response_format={"type": "json_object"}
                )
                raw_message = await run_with_transport_retries(
                    lambda: llm.ainvoke(_to_lc_messages(messages)),
                    max_retries=settings.llm_max_transport_retries,
                    stats=stats,
                )
                parsed, repaired = _parse_structured_text(
                    text_from_content(raw_message.content),
                    schema,
                )
                _update_span(span, stats=stats, message=raw_message, protocol="json_object")
                return parsed
        except ExternalServiceError:
            raise
        except Exception as exc:
            raise ExternalServiceError(f"JSON LLM call failed: {exc}") from exc

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
        llm = self._bind_chat(temperature=temperature)
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
        llm = self._bind_chat(temperature=temperature)
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
                    _chat_result_from_ai_message(message) if message is not None else ChatResult()
                )
        except Exception as e:
            raise ExternalServiceError(f"LLM tool streaming call failed: {e}") from e


def _llm_attributes(provider: OpenAIFormatProvider, *, mode: str) -> dict[str, object]:
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


def _unwrap_structured_result(result: Any, schema: type) -> tuple[Any, Any | None, bool]:
    if isinstance(result, dict) and "parsed" in result:
        parsing_error = result.get("parsing_error")
        if parsing_error is not None:
            raw_message = result.get("raw")
            raw_text = text_from_content(getattr(raw_message, "content", ""))
            if raw_text:
                try:
                    parsed, _ = _parse_structured_text(raw_text, schema, force_repair=True)
                    return parsed, raw_message, True
                except Exception as repair_error:
                    raise parsing_error from repair_error
            raise parsing_error
        parsed = result.get("parsed")
        if parsed is None:
            raise ValueError("Structured LLM response did not contain a parsed value")
        return parsed, result.get("raw"), False
    return result, getattr(result, "raw", None), False


def _parse_structured_text(
    text: str,
    schema: type,
    *,
    force_repair: bool = False,
) -> tuple[Any, bool]:
    """Validate model JSON, repairing syntax only after strict parsing fails."""
    if not force_repair:
        try:
            json_text = OpenAIFormatProvider._extract_json_object(text)
            if hasattr(schema, "model_validate_json"):
                return schema.model_validate_json(json_text), False
            value = json.loads(json_text)
            if hasattr(schema, "model_validate"):
                return schema.model_validate(value), False
            return value, False
        except Exception:
            pass

    repaired_value = repair_json(
        text,
        return_objects=True,
        ensure_ascii=False,
        skip_json_loads=force_repair,
    )
    if hasattr(schema, "model_validate"):
        return schema.model_validate(repaired_value), True
    return repaired_value, True


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
                f"{message.get('content', '')}\n\nReturn the answer as a valid JSON object."
            )
            return normalized

    normalized.insert(
        0,
        {"role": "system", "content": "Return the answer as a valid JSON object."},
    )
    return normalized


def _structured_protocol_order(
    preferred: str | None,
    *,
    supports_json_schema: bool = True,
) -> tuple[str, ...]:
    """Return the compatibility ladder with a known-good mode first."""
    supported = (
        ("json_mode", "json_schema", "json_prompt")
        if supports_json_schema
        else ("json_mode", "json_prompt")
    )
    if preferred is None or preferred not in supported:
        return supported
    return (preferred, *(method for method in supported if method != preferred))


def _json_prompt_messages(
    messages: list[dict[str, str]],
    schema: type,
) -> list[dict[str, str]]:
    schema_json = "{}"
    if hasattr(schema, "model_json_schema"):
        schema_json = json.dumps(schema.model_json_schema(), ensure_ascii=False)
    return [
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


def _endpoint_supports_json_schema(base_url: str | None) -> bool:
    """DeepSeek currently supports json_object but rejects json_schema."""
    return not base_url or "deepseek.com" not in base_url.lower()
