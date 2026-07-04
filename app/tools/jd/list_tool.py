from __future__ import annotations

from pydantic import BaseModel

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class ListJdsInput(BaseModel):
    limit: int = 10


class ListJdsTool:
    name = "list_jds"
    description = "List the user's saved job descriptions"
    requires_confirmation = False
    risk_level = "low"

    async def execute(self, input: ListJdsInput, context: ToolContext) -> ToolResult:
        items, _ = await context.services.jd.list_jds(context.user_id, limit=input.limit)
        return ToolResult(
            status="success",
            data={
                "items": [
                    {"id": j.id, "title": j.title, "company": j.company}
                    for j in items
                ]
            },
        )


register(ListJdsTool())
