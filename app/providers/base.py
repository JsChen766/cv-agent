from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
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

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class EmbeddingProvider(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...
