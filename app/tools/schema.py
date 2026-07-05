from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel

from app.tools.base import Tool, ToolResult


def to_openai_tool(tool: Tool) -> dict[str, Any]:
    """Convert an internal tool definition to an OpenAI-compatible tool schema."""
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": _json_schema(tool),
        },
    }


def to_anthropic_tool(tool: Tool) -> dict[str, Any]:
    """Convert an internal tool definition to an Anthropic-compatible tool schema."""
    return {
        "name": tool.name,
        "description": tool.description,
        "input_schema": _json_schema(tool),
    }


def validate_tool_input(tool: Tool, raw_args: dict[str, Any] | str | None) -> BaseModel:
    """Validate model-produced arguments with the tool's Pydantic input schema."""
    if raw_args is None:
        data: dict[str, Any] = {}
    elif isinstance(raw_args, str):
        data = json.loads(raw_args or "{}")
    else:
        data = raw_args
    return tool.input_schema.model_validate(data)


def summarize_tool_result(result: ToolResult) -> str:
    """Produce a compact result summary safe for UI trace and model feedback."""
    if result.message:
        return result.message
    if result.status == "success":
        return "Tool completed successfully."
    if result.status == "needs_input":
        return "Tool needs user input."
    return "Tool failed."


def _json_schema(tool: Tool) -> dict[str, Any]:
    schema = tool.input_schema.model_json_schema()
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    schema.setdefault("required", [])
    return schema
