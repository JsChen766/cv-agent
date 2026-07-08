"""
Open-ended node.

Handles general conversation, Q&A, and low-confidence router fallbacks. This
node is the only free-form tool-calling agent; domain-specific subgraphs remain
responsible for structured business flows.
"""

import json
import uuid
from typing import Any

from langchain_core.runnables import RunnableConfig

from app.core.events import AgentMessageCompletedEvent
from app.graphs.runtime import services_from_config
from app.graphs.state import MainState
from app.graphs.tracing import tool_completed, tool_failed, tool_started
from app.providers.factory import get_provider
from app.tools.base import ToolContext, ToolResult
from app.tools.executor import (
    ToolConfirmationRequired,
    ToolExecutionError,
    execute_tool,
    execute_tool_by_name,
)
from app.tools.registry import get_all

_SYSTEM_PROMPT = """You are a professional resume assistant. You help users:
- Write and improve their resumes
- Craft cover letters and self-introductions
- Analyse job descriptions and match their experience
- Give career advice and interview preparation tips

You have access to tools to read and manage the user's experiences, JDs, resumes, and artifacts.
Use tools when they are needed to answer accurately. For write/delete actions, ask for confirmation.
Respond in the same language the user uses. Be concise, specific, and professional.
"""

_MAX_TOOL_ITERATIONS = 5


async def open_ended_node(
    state: MainState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Handle open-ended queries with optional tool access."""
    provider = get_provider()
    llm_messages = _build_messages(state)
    existing_events = state.get("pending_sse_events", [])
    events: list[dict[str, Any]] = list(existing_events)

    services = services_from_config(config)
    if services is None:
        response = await provider.chat(llm_messages, temperature=0.7, max_tokens=1500)
        content = str(response)
        events.append(dict(_message_completed(content)))
        return {"assistant_message": content, "pending_sse_events": events}

    tool_context = ToolContext(
        user_id=state.get("user_id", ""),
        thread_id=state.get("thread_id", ""),
        services=services,
    )

    tools = get_all()
    content = ""
    for _ in range(_MAX_TOOL_ITERATIONS):
        result = await provider.chat_with_tools(
            llm_messages,
            tools,
            temperature=0.2,
            max_tokens=1500,
        )

        if not result.tool_calls:
            content = result.content or "Done."
            break

        if result.content:
            llm_messages.append({"role": "assistant", "content": result.content})

        for call in result.tool_calls:
            events.append(tool_started(call.name, call.arguments))
            try:
                tool_result = await execute_tool_by_name(
                    call.name,
                    call.arguments,
                    tool_context,
                    require_confirmation=True,
                )
            except ToolConfirmationRequired as confirmation:
                tool_result = await _confirm_and_execute_tool(confirmation, tool_context, events)
            except (KeyError, ToolExecutionError, ValueError) as exc:
                events.append(tool_failed(call.name, str(exc)))
                llm_messages.append(
                    {
                        "role": "user",
                        "content": f"Tool {call.name} failed: {exc}. Continue without it.",
                    }
                )
                continue

            events.append(tool_completed(call.name, tool_result))
            llm_messages.append(_tool_result_feedback(call.name, tool_result))
    else:
        content = "I completed the available tool steps, but need more specific direction to continue."

    events.append(dict(_message_completed(content)))
    return {"assistant_message": content, "pending_sse_events": events}


def _build_messages(state: MainState) -> list[dict[str, Any]]:
    messages = state.get("messages", [])
    intent = state.get("intent_description", "")
    rolling_summary = state.get("rolling_summary")

    llm_messages: list[dict[str, Any]] = [{"role": "system", "content": _SYSTEM_PROMPT}]
    if intent:
        llm_messages.append({"role": "system", "content": f"Current intent: {intent}"})
    if rolling_summary:
        llm_messages.append({"role": "system", "content": f"Conversation summary: {rolling_summary}"})

    llm_messages.extend(
        {"role": m["role"], "content": m["content"]}
        for m in (messages[-10:] if len(messages) > 10 else messages)
        if m["role"] in ("user", "assistant")
    )
    return llm_messages


async def _confirm_and_execute_tool(
    confirmation: ToolConfirmationRequired,
    context: ToolContext,
    events: list[dict[str, Any]],
) -> ToolResult:
    from langgraph.types import interrupt

    interrupt_id = str(uuid.uuid4())
    payload = {
        "interrupt_id": interrupt_id,
        "type": "confirm_action",
        "message": f"Please confirm before I run '{confirmation.tool.name}'.",
        "tool": confirmation.tool.name,
        "input": confirmation.input_model.model_dump(mode="json"),
        "variants": [],
        "candidates": [],
        "action_options": [
            {"id": "confirm", "label": "Confirm", "description": "Run this tool"},
            {"id": "discard", "label": "Discard", "description": "Do not run this tool"},
        ],
    }
    events.append({"event": "agent.interrupt", **payload})

    resume_value = interrupt(payload)
    action = resume_value.get("action") if isinstance(resume_value, dict) else None
    if action not in (None, "confirm", "accept"):
        return ToolResult(status="failed", message=f"Tool '{confirmation.tool.name}' was not confirmed.")

    return await execute_tool(confirmation.tool, confirmation.input_model, context)


def _tool_result_feedback(tool_name: str, result: ToolResult) -> dict[str, str]:
    result_json = json.dumps(result.model_dump(mode="json"), ensure_ascii=False)
    return {
        "role": "user",
        "content": f"Tool {tool_name} returned:\n{result_json[:4000]}",
    }


def _message_completed(content: str) -> AgentMessageCompletedEvent:
    return {
        "event": "agent.message.completed",
        "content": content,
    }
