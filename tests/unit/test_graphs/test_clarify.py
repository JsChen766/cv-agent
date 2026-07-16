from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from app.graphs.clarify import clarify_node
from app.graphs.state import MainState


class StreamingClarifyProvider:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def chat(
        self,
        messages: list[dict[str, str]],
        *,
        stream: bool = False,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        self.calls.append({"messages": messages, "stream": stream, **kwargs})

        async def tokens() -> AsyncIterator[str]:
            yield "Are you looking "
            yield "to improve a resume or prepare for an interview?"

        return tokens()


async def test_clarify_node_forwards_streamed_tokens_and_completes_message(monkeypatch) -> None:
    provider = StreamingClarifyProvider()
    emitted_events: list[dict[str, str]] = []
    state: MainState = {
        "messages": [{"role": "user", "content": "Can you help me?"}],
        "pending_sse_events": [],
    }
    monkeypatch.setattr("app.graphs.clarify.get_provider", lambda: provider)
    monkeypatch.setattr("app.graphs.clarify.get_stream_writer", lambda: emitted_events.append)

    result = await clarify_node(state)

    assert provider.calls[0]["stream"] is True
    assert emitted_events == [
        {"event": "agent.thinking", "text": "正在确认你的具体需求…"},
        {"event": "agent.message.delta", "content": "Are you looking "},
        {
            "event": "agent.message.delta",
            "content": "to improve a resume or prepare for an interview?",
        },
    ]
    assert result["assistant_message"] == (
        "Are you looking to improve a resume or prepare for an interview?"
    )
    assert result["pending_sse_events"] == [
        {
            "event": "agent.message.completed",
            "content": "Are you looking to improve a resume or prepare for an interview?",
        }
    ]
