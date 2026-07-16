"""
Open-ended node.

Handles general conversation, Q&A, and low-confidence router fallbacks. This
node is the only free-form tool-calling agent; domain-specific subgraphs remain
responsible for structured business flows.
"""

import asyncio
import json
import uuid
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.config import get_stream_writer

from app.core.events import AgentMessageCompletedEvent
from app.graphs.runtime import services_from_config
from app.graphs.state import MainState
from app.graphs.streaming import emit_thinking
from app.graphs.tracing import tool_completed, tool_failed, tool_started
from app.providers.factory import get_provider
from app.tools.base import ServiceContainer, ToolContext, ToolResult
from app.tools.executor import (
    ToolConfirmationRequired,
    ToolExecutionError,
    execute_tool,
    execute_tool_by_name,
)
from app.tools.registry import get_all

_SYSTEM_PROMPT = """你是一个专业的求职助手。你能帮助用户：
- 基于用户的经历库回答问题、做分析
- 撰写和优化简历、求职信、自我介绍
- 解读 JD 要求，分析匹配度
- 提供职业建议和面试准备

**使用工具的原则**：
- 当用户问"我有哪些经历"、"帮我分析我的背景"、"根据我的经历..."时，必须先调用 list_experiences，再按需调用 get_experience 读取详情。
- 当用户问"我保存了哪些JD"时，调用 list_jds。
- 对于需要写入的操作（保存经历、删除等），先向用户确认。
- 如果工作区信息显示"无数据"，主动告知用户并引导他们先导入数据。

**回复风格**：用用户使用的语言回复。简洁、直接、专业，避免无意义的套话。有具体数据时直接展示，不要说"我帮你查一下"然后不查。
"""

_MAX_TOOL_ITERATIONS = 5


async def open_ended_node(
    state: MainState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Handle open-ended queries with optional tool access."""
    provider = get_provider()
    services = services_from_config(config)
    workspace_context = await _load_workspace_context(state, services=services)
    llm_messages = _build_messages(state, workspace_context=workspace_context)
    existing_events = state.get("pending_sse_events", [])
    events: list[dict[str, Any]] = list(existing_events)
    writer = get_stream_writer()
    emit_thinking(writer, "正在组织回答…")

    if services is None:
        # No tool context — stream tokens directly
        stream_iter = await provider.chat(llm_messages, stream=True, temperature=0.7, max_tokens=1500)
        if isinstance(stream_iter, str):
            content = stream_iter
            if content:
                writer({"event": "agent.message.delta", "content": content})
        else:
            content = ""
            async for token in stream_iter:
                writer({"event": "agent.message.delta", "content": token})
                content += token
        events.append(dict(_message_completed(content)))
        return {"assistant_message": content, "pending_sse_events": events}

    tool_context = ToolContext(
        user_id=state.get("user_id", ""),
        thread_id=state.get("thread_id", ""),
        services=services,
    )

    tools = get_all()
    content = ""
    def emit_token(token: str) -> None:
        if token:
            writer({"event": "agent.message.delta", "content": token})

    for _ in range(_MAX_TOOL_ITERATIONS):
        stream_with_tools = getattr(provider, "chat_with_tools_stream", None)
        if callable(stream_with_tools):
            result = await stream_with_tools(
                llm_messages,
                tools,
                on_token=emit_token,
                temperature=0.2,
                max_tokens=1500,
            )
        else:
            # Keep custom/test providers working during the provider-interface
            # rollout. Production providers implement the streaming method.
            result = await provider.chat_with_tools(
                llm_messages,
                tools,
                temperature=0.2,
                max_tokens=1500,
            )

        if not result.tool_calls:
            content = result.content or "Done."
            break

        llm_messages.append(
            {
                "role": "assistant",
                "content": result.content,
                "tool_calls": [
                    {
                        "id": call.id,
                        "name": call.name,
                        "args": call.arguments,
                        "type": "tool_call",
                    }
                    for call in result.tool_calls
                ],
            }
        )

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
                llm_messages.append(_tool_failure_feedback(call.id, call.name, str(exc)))
                continue

            events.append(tool_completed(call.name, tool_result))
            llm_messages.append(_tool_result_feedback(call.id, call.name, tool_result))
    else:
        content = "I completed the available tool steps, but need more specific direction to continue."

    events.append(dict(_message_completed(content)))
    return {"assistant_message": content, "pending_sse_events": events}
def _build_messages(
    state: MainState,
    workspace_context: str = "",
) -> list[dict[str, Any]]:
    messages = state.get("messages", [])
    intent = state.get("intent_description", "")
    rolling_summary = state.get("rolling_summary")

    system_content = _SYSTEM_PROMPT
    if workspace_context:
        system_content = _SYSTEM_PROMPT + "\n" + workspace_context

    llm_messages: list[dict[str, Any]] = [{"role": "system", "content": system_content}]
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


async def _load_workspace_context(
    state: MainState,
    *,
    services: ServiceContainer | None,
) -> str:
    """加载轻量级 workspace 上下文，注入到 system prompt。

    只查询元数据（titles/counts），不做 RAG 或 embedding 检索。
    三个 DB 查询并行发起，失败时静默降级，不中断对话。
    """
    workspace = state.get("workspace", {}) or {}
    user_id = str(state.get("user_id", ""))

    if not services or not user_id:
        return ""

    jd_id = workspace.get("jd_id") if isinstance(workspace, dict) else None
    resume_id = workspace.get("resume_id") if isinstance(workspace, dict) else None

    async def _get_experiences() -> tuple[list[Any], Any]:
        try:
            return await services.experience.list_experiences(user_id, limit=50)
        except Exception:  # noqa: BLE001
            return [], None

    async def _get_jd() -> Any:
        try:
            if isinstance(jd_id, str) and jd_id:
                return await services.jd.get_jd(user_id, jd_id)
        except Exception:  # noqa: BLE001
            pass
        return None

    async def _get_profile() -> Any:
        try:
            return await services.user.get_profile(user_id)
        except Exception:  # noqa: BLE001
            return None

    (items, _), jd, profile = await asyncio.gather(
        _get_experiences(), _get_jd(), _get_profile()
    )

    parts: list[str] = []

    # 经历库
    if items:
        by_cat: dict[str, list[str]] = {}
        for exp in items:
            cat = str(getattr(exp, "category", None) or "其他")
            by_cat.setdefault(cat, []).append(str(getattr(exp, "title", None) or ""))
        lines = [f"  - [{cat}] " + "、".join(titles) for cat, titles in by_cat.items()]
        truncation_note = "，如需查找更多请用 list_experiences 的 q 参数搜索" if len(items) == 50 else ""
        parts.append(f"用户经历库（共 {len(items)} 条{truncation_note}）：\n" + "\n".join(lines))
    else:
        parts.append("用户经历库：暂无数据（用户可能尚未导入经历）")

    # Active JD
    if jd is not None:
        raw_text = getattr(jd, "raw_text", "") or ""
        preview = raw_text[:200].strip() + ("..." if len(raw_text) > 200 else "")
        parts.append(
            f"当前 active JD（ID: {jd_id}）：\n  标题: {getattr(jd, 'title', '') or ''}\n  内容预览: {preview}"
        )
    else:
        parts.append("当前 active JD：无")

    # Active 简历
    if isinstance(resume_id, str) and resume_id:
        parts.append(f"当前 active 简历 ID：{resume_id}（可用 list_resumes 工具查看）")

    # 用户信息
    if profile:
        name = getattr(profile, "full_name", None) or ""
        title = getattr(profile, "current_title", None) or ""
        if name or title:
            parts.append(f"用户信息：{name}，{title}".rstrip("，").rstrip())

    if not parts:
        return ""

    return (
        "\n\n=== 用户工作区 ===\n"
        + "\n\n".join(parts)
        + "\n\n当你需要查看经历详情时，先调用 list_experiences 获取列表，再调用 get_experience 获取某条经历的完整内容。"
        + "\n=== 工作区信息结束 ==="
    )


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
    action = (
        resume_value.get("action") or resume_value.get("decision")
        if isinstance(resume_value, dict)
        else None
    )
    if action in ("preempted", "discard"):
        return ToolResult(status="failed", message="Action was cancelled.")
    explicitly_confirmed = isinstance(resume_value, dict) and (
        resume_value.get("confirmed") is True or action in ("confirm", "accept", "save")
    )
    if not explicitly_confirmed:
        return ToolResult(status="failed", message=f"Tool '{confirmation.tool.name}' was not confirmed.")

    return await execute_tool(confirmation.tool, confirmation.input_model, context)


def _tool_result_feedback(
    tool_call_id: str, tool_name: str, result: ToolResult
) -> dict[str, Any]:
    result_json = json.dumps(result.model_dump(mode="json"), ensure_ascii=False)
    return {
        "role": "tool",
        "tool_call_id": tool_call_id,
        "name": tool_name,
        "content": f"Tool {tool_name} returned:\n{result_json[:4000]}",
    }


def _tool_failure_feedback(tool_call_id: str, tool_name: str, error: str) -> dict[str, Any]:
    return {
        "role": "tool",
        "tool_call_id": tool_call_id,
        "name": tool_name,
        "content": f"Tool {tool_name} failed: {error}. Continue without it.",
    }


def _message_completed(content: str) -> AgentMessageCompletedEvent:
    return {
        "event": "agent.message.completed",
        "content": content,
    }
