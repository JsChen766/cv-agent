"""Presentation-level activity projection for SSE streams.

This module maps internal LangGraph/node/tool events to a small, stable
front-end contract. It does not define or alter the internal agent topology.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

AgentRole = Literal[
    "frontdesk",
    "experience_orchestrator",
    "jd_analyst",
    "resume_writer",
    "resume_reviewer",
]
ActivityStatus = Literal["running", "waiting_user", "completed", "failed"]


@dataclass(frozen=True)
class ActivitySpec:
    agent_role: AgentRole
    agent_label: str
    running_action: str
    completed_action: str


_AGENT_LABELS: dict[AgentRole, str] = {
    "frontdesk": "前台",
    "experience_orchestrator": "经历编排员",
    "jd_analyst": "岗位分析师",
    "resume_writer": "简历写手",
    "resume_reviewer": "简历质检员",
}

_NODE_ACTIVITY: dict[str, ActivitySpec] = {
    "router": ActivitySpec("frontdesk", "前台", "正在理解你的请求并分配任务", "已完成任务分配"),
    "router_node": ActivitySpec("frontdesk", "前台", "正在理解你的请求并分配任务", "已完成任务分配"),
    "open_ended": ActivitySpec("frontdesk", "前台", "正在处理你的问题", "已完成回复整理"),
    "open_ended_node": ActivitySpec("frontdesk", "前台", "正在处理你的问题", "已完成回复整理"),
    "experience_import": ActivitySpec("experience_orchestrator", "经历编排员", "正在整理经历信息", "已完成经历整理"),
    "parse": ActivitySpec("experience_orchestrator", "经历编排员", "正在解析经历内容", "已完成经历解析"),
    "parse_import_node": ActivitySpec("experience_orchestrator", "经历编排员", "正在解析经历内容", "已完成经历解析"),
    "review": ActivitySpec("experience_orchestrator", "经历编排员", "正在准备经历确认", "已准备好经历确认"),
    "review_import_node": ActivitySpec("experience_orchestrator", "经历编排员", "正在准备经历确认", "已准备好经历确认"),
    "save": ActivitySpec("experience_orchestrator", "经历编排员", "正在保存确认后的经历", "已保存确认后的经历"),
    "save_import_node": ActivitySpec("experience_orchestrator", "经历编排员", "正在保存确认后的经历", "已保存确认后的经历"),
    "jd": ActivitySpec("jd_analyst", "岗位分析师", "正在分析岗位信息", "已完成岗位分析"),
    "save_jd": ActivitySpec("jd_analyst", "岗位分析师", "正在提取岗位基础信息", "已完成岗位基础信息提取"),
    "save_jd_node": ActivitySpec("jd_analyst", "岗位分析师", "正在提取岗位基础信息", "已完成岗位基础信息提取"),
    "parse_requirements": ActivitySpec("jd_analyst", "岗位分析师", "正在拆解岗位要求", "已完成岗位要求拆解"),
    "parse_requirements_node": ActivitySpec("jd_analyst", "岗位分析师", "正在拆解岗位要求", "已完成岗位要求拆解"),
    "resume_generation": ActivitySpec("resume_writer", "简历写手", "正在生成针对岗位的简历", "已完成简历生成流程"),
    "context_assembly": ActivitySpec("resume_writer", "简历写手", "正在收集简历写作上下文", "已完成上下文收集"),
    "context_assembly_node": ActivitySpec("resume_writer", "简历写手", "正在收集简历写作上下文", "已完成上下文收集"),
    "cot_planning": ActivitySpec("resume_writer", "简历写手", "正在规划简历写作策略", "已完成简历写作策略"),
    "cot_planning_node": ActivitySpec("resume_writer", "简历写手", "正在规划简历写作策略", "已完成简历写作策略"),
    "draft_generation": ActivitySpec("resume_writer", "简历写手", "正在生成内容草稿", "已完成内容草稿"),
    "draft_generation_node": ActivitySpec("resume_writer", "简历写手", "正在生成内容草稿", "已完成内容草稿"),
    "artifact": ActivitySpec("resume_writer", "简历写手", "正在生成文档内容", "已完成文档生成"),
    "artifact_context_assembly_node": ActivitySpec("resume_writer", "简历写手", "正在收集文档写作上下文", "已完成文档上下文收集"),
    "artifact_draft_node": ActivitySpec("resume_writer", "简历写手", "正在生成文档内容", "已完成文档生成"),
    "self_review": ActivitySpec("resume_reviewer", "简历质检员", "正在检查简历质量", "已完成简历质量检查"),
    "self_review_node": ActivitySpec("resume_reviewer", "简历质检员", "正在检查简历质量", "已完成简历质量检查"),
    "revision": ActivitySpec("resume_writer", "简历写手", "正在根据质检意见修改简历", "已完成简历修改"),
    "revision_node": ActivitySpec("resume_writer", "简历写手", "正在根据质检意见修改简历", "已完成简历修改"),
    "output": ActivitySpec("resume_reviewer", "简历质检员", "正在准备简历确认", "已准备好简历确认"),
    "output_node": ActivitySpec("resume_reviewer", "简历质检员", "正在准备简历确认", "已准备好简历确认"),
}

_TOOL_LABELS: dict[str, str] = {
    "list_experiences": "读取经历库",
    "get_experience": "读取经历详情",
    "save_experience": "保存经历",
    "import_experiences_from_text": "导入经历文本",
    "list_jds": "读取岗位库",
    "save_jd": "保存岗位",
    "list_resumes": "读取简历库",
    "create_artifact": "保存文档",
    "get_artifact": "读取文档",
}


def activity_from_node_event(
    node_name: str,
    status: ActivityStatus,
    *,
    thread_id: str | None,
    turn_id: str | None,
    sequence: int,
) -> dict[str, Any] | None:
    """Project a LangGraph node lifecycle event into a stable activity event."""
    spec = _NODE_ACTIVITY.get(node_name)
    if spec is None:
        return None
    action = spec.completed_action if status == "completed" else spec.running_action
    return _activity_event(
        thread_id=thread_id,
        turn_id=turn_id,
        sequence=sequence,
        agent_role=spec.agent_role,
        status=status,
        action=action,
    )


def activity_from_tool_event(
    event: dict[str, Any],
    *,
    thread_id: str | None,
    turn_id: str | None,
    sequence: int,
) -> dict[str, Any] | None:
    """Project an existing agent.tool.* event into an agent activity event."""
    event_type = event.get("event")
    if event_type not in {
        "agent.tool.started",
        "agent.tool.completed",
        "agent.tool.failed",
    }:
        return None

    tool_name = str(event.get("tool") or "")
    if not tool_name:
        return None

    status: ActivityStatus
    if event_type == "agent.tool.started":
        status = "running"
    elif event_type == "agent.tool.failed":
        status = "failed"
    else:
        status = "completed"

    role = _role_for_tool(tool_name)
    label = _tool_label(tool_name)
    action = f"正在调用工具：{label}" if status == "running" else f"已完成工具调用：{label}"
    if status == "failed":
        action = f"工具调用失败：{label}"

    return _activity_event(
        thread_id=thread_id,
        turn_id=turn_id,
        sequence=sequence,
        agent_role=role,
        status=status,
        action=action,
        tool={
            "name": tool_name,
            "label": label,
            "status": status,
        },
    )


def activity_from_interrupt(
    payload: dict[str, Any],
    *,
    thread_id: str | None,
    turn_id: str | None,
    sequence: int,
) -> dict[str, Any]:
    """Project a LangGraph interrupt into a waiting-for-user activity event."""
    interrupt_type = str(
        payload.get("type")
        or payload.get("interrupt_type")
        or payload.get("data", {}).get("type")
        or ""
    )

    if interrupt_type == "resume_review":
        role: AgentRole = "resume_reviewer"
        action = "等待你确认或修改简历版本"
    elif interrupt_type == "experience_import_review":
        role = "experience_orchestrator"
        action = "等待你确认要保存的经历"
    elif interrupt_type == "confirm_action":
        role = _role_for_tool(str(payload.get("tool") or ""))
        action = "等待你确认工具调用"
    else:
        role = "frontdesk"
        action = "等待你的确认"

    tool_name = payload.get("tool")
    tool = None
    if isinstance(tool_name, str) and tool_name:
        tool = {
            "name": tool_name,
            "label": _tool_label(tool_name),
            "status": "waiting_user",
        }

    return _activity_event(
        thread_id=thread_id,
        turn_id=turn_id,
        sequence=sequence,
        agent_role=role,
        status="waiting_user",
        action=action,
        tool=tool,
    )


def _activity_event(
    *,
    thread_id: str | None,
    turn_id: str | None,
    sequence: int,
    agent_role: AgentRole,
    status: ActivityStatus,
    action: str,
    tool: dict[str, Any] | None = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "event": "agent.activity.updated",
        "thread_id": thread_id,
        "turn_id": turn_id,
        "sequence": sequence,
        "timestamp": datetime.now(UTC).isoformat(),
        "agent_role": agent_role,
        "agent_label": _AGENT_LABELS[agent_role],
        "status": status,
        "action": action,
    }
    if tool is not None:
        event["tool"] = tool
    return event


def _role_for_tool(tool_name: str) -> AgentRole:
    if "experience" in tool_name:
        return "experience_orchestrator"
    if tool_name.endswith("_jd") or "_jd" in tool_name or tool_name.endswith("_jds"):
        return "jd_analyst"
    if "resume" in tool_name:
        return "resume_writer"
    if "artifact" in tool_name:
        return "resume_writer"
    return "frontdesk"


def _tool_label(tool_name: str) -> str:
    return _TOOL_LABELS.get(tool_name, tool_name.replace("_", " "))
