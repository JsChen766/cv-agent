"""
Open-ended node.

Handles general conversation, Q&A, and any intent the router
couldn't classify with high confidence. Uses the full tool registry
so it can call any tool the user might need.
"""

from __future__ import annotations

from app.core.events import AgentMessageCompletedEvent
from app.graphs.state import MainState
from app.providers.factory import get_provider
from app.tools.registry import get_all


_SYSTEM_PROMPT = """You are a professional resume assistant. You help users:
- Write and improve their resumes
- Craft cover letters and self-introductions
- Analyse job descriptions and match their experience
- Give career advice and interview preparation tips

You have access to tools to read and manage the user's experiences, JDs, resumes, and artifacts.
Respond in the same language the user uses. Be concise, specific, and professional.
"""


async def open_ended_node(state: MainState) -> dict:
    """Handle open-ended queries with tool access."""
    messages = state.get("messages", [])
    intent = state.get("intent_description", "")
    rolling_summary = state.get("rolling_summary")

    # Build message list for LLM
    lc_messages = [{"role": "system", "content": _SYSTEM_PROMPT}]
    if rolling_summary:
        lc_messages.append({
            "role": "system",
            "content": f"Conversation summary: {rolling_summary}",
        })
    lc_messages.extend(
        {"role": m["role"], "content": m["content"]}
        for m in (messages[-10:] if len(messages) > 10 else messages)
        if m["role"] in ("user", "assistant")
    )

    provider = get_provider()
    response = await provider.chat(lc_messages, temperature=0.7, max_tokens=1500)
    content = str(response)

    # Emit message completed event
    msg_event: AgentMessageCompletedEvent = {
        "event": "agent.message.completed",
        "content": content,
    }
    existing_events = state.get("pending_sse_events", [])

    return {
        "assistant_message": content,
        "pending_sse_events": [*existing_events, msg_event],
    }
