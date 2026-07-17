from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk
from pydantic import BaseModel

from app.providers.base import ToolCall, visible_token_chunks
from app.providers.openai_format import (
    OpenAIFormatProvider,
    _chat_result_from_ai_message,
    _ensure_json_mode_prompt,
)


class ListResumesInput(BaseModel):
    limit: int = 10


class ListResumesTool:
    name = "list_resumes"
    description = "List saved resumes."
    input_schema = ListResumesInput
    requires_confirmation = False
    risk_level = "low"


class FakeBoundLlm:
    def __init__(self, chunks: list[AIMessageChunk]) -> None:
        self.chunks = chunks
        self.bind_calls: list[dict[str, Any]] = []
        self.bound_tools: list[dict[str, Any]] | None = None
        self.tool_choice: str | None = None
        self.stream_messages: list[Any] | None = None
        self.structured_method: str | None = None
        self.structured_messages: list[Any] | None = None

    def bind(self, **kwargs: Any) -> FakeBoundLlm:
        self.bind_calls.append(kwargs)
        return self

    def bind_tools(
        self,
        tools: list[dict[str, Any]],
        *,
        tool_choice: str | None,
    ) -> FakeBoundLlm:
        self.bound_tools = tools
        self.tool_choice = tool_choice
        return self

    def with_structured_output(
        self,
        schema: type,
        *,
        method: str,
    ) -> FakeBoundLlm:
        self.structured_method = method
        return self

    async def ainvoke(self, messages: list[Any]) -> ListResumesInput:
        self.structured_messages = messages
        return ListResumesInput(limit=1)

    async def astream(self, messages: list[Any]) -> AsyncIterator[AIMessageChunk]:
        self.stream_messages = messages
        for chunk in self.chunks:
            yield chunk


def test_openai_tool_call_parser_reads_langchain_ai_message():
    message = AIMessage(
        content="",
        tool_calls=[
            {
                "id": "call-1",
                "name": "list_resumes",
                "args": {"limit": 1},
            }
        ],
    )

    result = _chat_result_from_ai_message(message)

    assert result.tool_calls == [
        ToolCall(id="call-1", name="list_resumes", arguments={"limit": 1})
    ]


def test_structured_prompt_mentions_json_without_mutating_callers_messages() -> None:
    messages = [{"role": "system", "content": "Classify this request."}]

    normalized = _ensure_json_mode_prompt(messages)

    assert "json" in normalized[0]["content"].lower()
    assert messages == [{"role": "system", "content": "Classify this request."}]


async def test_chat_structured_sends_json_instruction_to_json_mode() -> None:
    fake_llm = FakeBoundLlm([])
    provider = OpenAIFormatProvider.__new__(OpenAIFormatProvider)
    provider._llm = fake_llm

    result = await provider.chat_structured(
        [{"role": "system", "content": "Classify this request."}],
        ListResumesInput,
    )

    assert result == ListResumesInput(limit=1)
    assert fake_llm.structured_method == "json_mode"
    assert fake_llm.structured_messages is not None
    assert "json" in str(fake_llm.structured_messages[0].content).lower()


async def test_openai_tool_stream_forwards_tokens_and_reconstructs_tool_call() -> None:
    fake_llm = FakeBoundLlm(
        [
            AIMessageChunk(
                content="Looking ",
                tool_call_chunks=[
                    {
                        "name": "list_resumes",
                        "args": '{"limit":',
                        "id": "call-1",
                        "index": 0,
                    }
                ],
            ),
            AIMessageChunk(
                content="that up.",
                tool_call_chunks=[
                    {"name": None, "args": "1}", "id": "call-1", "index": 0}
                ],
            ),
        ]
    )
    # The method under test only needs the bound chat model; bypassing the
    # constructor keeps this unit test completely local and credential-free.
    provider = OpenAIFormatProvider.__new__(OpenAIFormatProvider)
    provider._llm = fake_llm
    tokens: list[str] = []

    result = await provider.chat_with_tools_stream(
        [{"role": "user", "content": "List my resumes"}],
        [ListResumesTool()],
        on_token=tokens.append,
        temperature=0.4,
        max_tokens=32,
    )

    assert tokens == ["Looking ", "that up."]
    assert result.content == "Looking that up."
    assert result.tool_calls == [
        ToolCall(id="call-1", name="list_resumes", arguments={"limit": 1})
    ]
    assert fake_llm.bind_calls == [{"temperature": 0.4}, {"max_tokens": 32}]
    assert fake_llm.bound_tools is not None
    assert fake_llm.bound_tools[0]["function"]["name"] == "list_resumes"
    assert fake_llm.tool_choice == "auto"


async def test_visible_token_chunks_split_buffered_provider_output() -> None:
    content = "A" * 55

    chunks = [chunk async for chunk in visible_token_chunks(content, frame_delay=0)]

    assert len(chunks) == 4
    assert "".join(chunks) == content
