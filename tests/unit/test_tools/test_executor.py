from pydantic import BaseModel

from app.tools.base import ToolContext, ToolResult
from app.tools.executor import ToolConfirmationRequired, execute_tool


class EchoInput(BaseModel):
    text: str


class EchoTool:
    name = "echo"
    description = "Echo input text"
    input_schema = EchoInput
    requires_confirmation = False
    risk_level = "low"

    async def execute(self, input: EchoInput, context: ToolContext) -> ToolResult:
        return ToolResult(status="success", data={"text": input.text}, message=input.text)


class ConfirmTool(EchoTool):
    name = "confirm"
    requires_confirmation = True
    risk_level = "medium"


async def test_execute_tool_runs_validated_model():
    tool = EchoTool()
    context = _context()

    result = await execute_tool(tool, EchoInput(text="ok"), context)

    assert result.status == "success"
    assert result.message == "ok"


def test_confirmation_error_carries_tool_and_input():
    tool = ConfirmTool()
    input_model = EchoInput(text="needs review")

    error = ToolConfirmationRequired(tool, input_model)

    assert error.tool.name == "confirm"
    assert error.input_model.text == "needs review"


def _context() -> ToolContext:
    return ToolContext.model_construct(
        user_id="user-1",
        thread_id="thread-1",
        services=object(),
    )
