from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Sequence
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field


class Message(dict[str, str]):
    """A chat message dict with keys 'role' and 'content'."""

    @classmethod
    def system(cls, content: str) -> Message:
        return cls(role="system", content=content)

    @classmethod
    def user(cls, content: str) -> Message:
        return cls(role="user", content=content)

    @classmethod
    def assistant(cls, content: str) -> Message:
        return cls(role="assistant", content=content)


class ToolCall(BaseModel):
    id: str
    name: str
    arguments: dict[str, Any]


class ChatResult(BaseModel):
    content: str = ""
    tool_calls: list[ToolCall] = Field(default_factory=list)
    raw: Any | None = None


TokenCallback = Callable[[str], None]


def text_from_content(content: Any) -> str:
    """Extract user-visible text from a LangChain message or message chunk."""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        text = content.get("text")
        return text if isinstance(text, str) else ""
    if isinstance(content, list):
        return "".join(text_from_content(item) for item in content)
    return ""


async def visible_token_chunks(
    text: str,
    *,
    max_chars: int = 18,
    frame_delay: float = 0.022,
) -> AsyncIterator[str]:
    """Normalize providers that buffer a whole answer into one stream chunk."""
    if not text:
        return
    size = max(1, max_chars)
    parts = [text[start : start + size] for start in range(0, len(text), size)]
    for index, part in enumerate(parts):
        yield part
        if index < len(parts) - 1:
            await asyncio.sleep(frame_delay)


async def forward_visible_tokens(
    callback: TokenCallback | None,
    text: str,
) -> None:
    if callback is None:
        return
    async for part in visible_token_chunks(text):
        callback(part)


class ToolDefinition(Protocol):
    """Provider-facing tool shape, kept independent from the tools layer."""

    name: str
    description: str
    input_schema: type[BaseModel]
    requires_confirmation: bool
    risk_level: Literal["low", "medium", "high"]


class LLMProvider(Protocol):
    async def chat(
        self,
        messages: list[dict[str, str]],
        *,
        stream: bool = False,
        response_format: type | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
    ) -> str | AsyncIterator[str]: ...

    async def chat_structured(
        self,
        messages: list[dict[str, str]],
        schema: type,
        *,
        temperature: float = 0.2,
    ) -> Any: ...

    async def chat_with_tools(
        self,
        messages: list[dict[str, Any]],
        tools: Sequence[ToolDefinition],
        *,
        tool_choice: str | None = "auto",
        temperature: float = 0.2,
        max_tokens: int | None = None,
    ) -> ChatResult: ...

    async def chat_with_tools_stream(
        self,
        messages: list[dict[str, Any]],
        tools: Sequence[ToolDefinition],
        *,
        on_token: TokenCallback | None = None,
        tool_choice: str | None = "auto",
        temperature: float = 0.2,
        max_tokens: int | None = None,
    ) -> ChatResult: ...

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class EmbeddingProvider(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...
