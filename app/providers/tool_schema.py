"""Provider-specific serialization for structurally defined tools."""

from __future__ import annotations

from typing import Any

from app.providers.base import ToolDefinition


def to_openai_tool(tool: ToolDefinition) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": _json_schema(tool),
        },
    }


def to_anthropic_tool(tool: ToolDefinition) -> dict[str, Any]:
    return {
        "name": tool.name,
        "description": tool.description,
        "input_schema": _json_schema(tool),
    }


def _json_schema(tool: ToolDefinition) -> dict[str, Any]:
    schema = tool.input_schema.model_json_schema()
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    schema.setdefault("required", [])
    return schema
