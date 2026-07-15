from __future__ import annotations

from typing import Literal, cast

from pydantic import BaseModel, Field, JsonValue

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class ListExperiencesInput(BaseModel):
    category: str | None = None
    tags: list[str] | None = None
    q: str | None = None
    limit: int = Field(default=20, ge=1, le=50)


class ListExperiencesTool:
    name: str = "list_experiences"
    description: str = (
        "List the user's stored experiences (titles and categories only). "
        "Call this FIRST when the user asks about their background, experiences, or work history. "
        "Use the returned IDs to call get_experience for full content of specific items. "
        "Supports filtering by category (work/project/education/other), tags, or keyword search (q)."
    )
    input_schema: type[BaseModel] = ListExperiencesInput
    requires_confirmation: bool = False
    risk_level: Literal["low", "medium", "high"] = "low"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        typed_input = ListExperiencesInput.model_validate(input)
        items, next_cursor = await context.services.experience.list_experiences(
            context.user_id,
            limit=typed_input.limit,
            category=typed_input.category,
            tags=typed_input.tags,
            q=typed_input.q,
        )
        return ToolResult(
            status="success",
            data={
                "items": [
                    {
                        "id": e.id,
                        "title": e.title,
                        "category": e.category,
                        "organization": e.organization,
                        "tags": cast("JsonValue", e.tags),
                    }
                    for e in items
                ],
                "nextCursor": next_cursor,
            },
        )


register(ListExperiencesTool())
