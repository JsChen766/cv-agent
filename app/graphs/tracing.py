from __future__ import annotations

from typing import Any

from app.tools.base import ToolResult
from app.tools.schema import summarize_tool_result


def thinking(text: str) -> dict[str, Any]:
    return {"event": "agent.thinking", "text": text}


def node_started(node: str, description: str) -> dict[str, Any]:
    return {"event": "agent.node.started", "node": node, "description": description}


def node_completed(node: str, duration_ms: int) -> dict[str, Any]:
    return {"event": "agent.node.completed", "node": node, "duration_ms": duration_ms}


def tool_started(tool: str, input: dict[str, Any]) -> dict[str, Any]:
    return {"event": "agent.tool.started", "tool": tool, "input": input}


def tool_completed(tool: str, result: ToolResult) -> dict[str, Any]:
    return {
        "event": "agent.tool.completed",
        "tool": tool,
        "result_summary": summarize_tool_result(result),
    }


def tool_failed(tool: str, error: str) -> dict[str, Any]:
    return {"event": "agent.tool.failed", "tool": tool, "error": error}
