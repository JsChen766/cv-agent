from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class ListResumesInput(BaseModel):
    q: str | None = None
    limit: int = Field(default=20, ge=1, le=50)


class ListResumesTool:
    name: str = "list_resumes"
    description: str = "List the user's saved resumes"
    input_schema: type[BaseModel] = ListResumesInput
    requires_confirmation: bool = False
    risk_level: Literal["low", "medium", "high"] = "low"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        typed_input = ListResumesInput.model_validate(input)
        items, _ = await context.services.resume.list_resumes(
            context.user_id, limit=typed_input.limit
        )
        return ToolResult(
            status="success",
            data={
                "items": [
                    {"id": r.id, "title": r.title, "targetRole": r.target_role}
                    for r in items
                ]
            },
        )


register(ListResumesTool())
