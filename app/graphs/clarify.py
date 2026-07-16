"""Clarify node — ask user one focused question to disambiguate intent."""

from __future__ import annotations

from langgraph.config import get_stream_writer

from app.core.events import AgentMessageCompletedEvent
from app.graphs.state import MainState
from app.providers.factory import get_provider

_CLARIFY_SYSTEM = """You are a professional resume assistant. The user's request is ambiguous.

Ask ONE concise clarifying question to understand what they want to do.
- Be conversational and friendly
- Keep it to 1–2 sentences
- Offer 2–3 concrete options if it helps narrow things down
- Respond in the same language the user used
"""


async def clarify_node(state: MainState) -> dict[str, object]:
    """Generate a clarifying question and return it as the assistant message."""
    provider = get_provider()
    messages = state.get("messages", [])
    intent_hint = state.get("intent_description", "")

    llm_messages: list[dict[str, str]] = [{"role": "system", "content": _CLARIFY_SYSTEM}]
    if intent_hint:
        llm_messages.append({"role": "system", "content": f"Routing hint (not shown to user): {intent_hint}"})

    for m in messages[-6:] if len(messages) > 6 else messages:
        if m["role"] in ("user", "assistant"):
            llm_messages.append({"role": m["role"], "content": m["content"]})

    writer = get_stream_writer()
    writer({"event": "agent.thinking", "text": "正在确认你的具体需求…"})
    response = await provider.chat(
        llm_messages,
        stream=True,
        temperature=0.7,
        max_tokens=200,
    )
    content_parts: list[str] = []

    # `LLMProvider.chat` has a str | AsyncIterator[str] return contract. A
    # streaming provider returns the iterator here; retain a defensive fallback
    # for custom providers that return a complete string despite stream=True.
    if isinstance(response, str):
        if response:
            writer({"event": "agent.message.delta", "content": response})
        content_parts.append(response)
    else:
        async for token in response:
            writer({"event": "agent.message.delta", "content": token})
            content_parts.append(token)

    content = "".join(content_parts)

    completed_event: AgentMessageCompletedEvent = {
        "event": "agent.message.completed",
        "content": content,
    }
    existing = state.get("pending_sse_events", [])
    return {
        "assistant_message": content,
        "pending_sse_events": [*existing, dict(completed_event)],
    }
