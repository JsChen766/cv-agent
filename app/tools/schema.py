from __future__ import annotations

import json
from typing import Any, Protocol

from pydantic import BaseModel

from app.providers.tool_schema import to_anthropic_tool, to_openai_tool
from app.tools.base import ToolResult

__all__ = ["to_anthropic_tool", "to_openai_tool", "validate_tool_input"]


class SchemaTool(Protocol):
    name: str
    description: str
    input_schema: type[BaseModel]


def validate_tool_input(tool: SchemaTool, raw_args: dict[str, Any] | str | None) -> BaseModel:
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
