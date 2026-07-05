from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.registry import get
from app.tools.schema import summarize_tool_result, validate_tool_input


class ToolExecutionError(RuntimeError):
    """Raised when a tool cannot be executed."""


class ToolConfirmationRequired(RuntimeError):
    """Raised when a selected tool must be confirmed by the user first."""

    def __init__(self, tool: Tool, input_model: BaseModel) -> None:
        self.tool = tool
        self.input_model = input_model
        super().__init__(f"Tool '{tool.name}' requires confirmation")


async def execute_tool_by_name(
    tool_name: str,
    raw_args: dict[str, Any] | str | None,
    context: ToolContext,
    *,
    require_confirmation: bool = True,
) -> ToolResult:
    tool = get(tool_name)
    input_model = validate_tool_input(tool, raw_args)
    if require_confirmation and tool.requires_confirmation:
        raise ToolConfirmationRequired(tool, input_model)
    return await execute_tool(tool, input_model, context)


async def execute_tool(tool: Tool, input_model: BaseModel, context: ToolContext) -> ToolResult:
    try:
        return await tool.execute(input_model, context)
    except Exception as exc:
        raise ToolExecutionError(f"Tool '{tool.name}' failed: {exc}") from exc


def result_for_model(tool_name: str, result: ToolResult) -> dict[str, Any]:
    return {
        "role": "tool",
        "name": tool_name,
        "content": summarize_tool_result(result),
        "data": result.model_dump(mode="json"),
    }
