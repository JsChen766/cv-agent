from __future__ import annotations

from pydantic import BaseModel, Field

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class ListResumesInput(BaseModel):
    q: str | None = None
    limit: int = Field(default=20, ge=1, le=50)


class ListResumesTool:
    name = "list_resumes"
    description = "List the user's saved resumes"
    input_schema = ListResumesInput
    requires_confirmation = False
    risk_level = "low"

    async def execute(self, input: ListResumesInput, context: ToolContext) -> ToolResult:
        items, _ = await context.services.resume.list_resumes(
            context.user_id, limit=input.limit
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
