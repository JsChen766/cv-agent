from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class ListJdsInput(BaseModel):
    q: str | None = None
    company: str | None = None
    limit: int = Field(default=20, ge=1, le=50)


class ListJdsTool:
    name: str = "list_jds"
    description: str = "List the user's saved job descriptions"
    input_schema: type[BaseModel] = ListJdsInput
    requires_confirmation: bool = False
    risk_level: Literal["low", "medium", "high"] = "low"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        typed_input = ListJdsInput.model_validate(input)
        items, _ = await context.services.jd.list_jds(context.user_id, limit=typed_input.limit)
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
