from __future__ import annotations

from pydantic import BaseModel

from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.registry import register


class ListExperiencesInput(BaseModel):
    category: str | None = None
    tags: list[str] | None = None
    q: str | None = None
    limit: int = 20


class ListExperiencesTool:
    name = "list_experiences"
    description = "List the user's experience library, optionally filtered by category, tags, or search query"
    requires_confirmation = False
    risk_level = "low"

    async def execute(self, input: ListExperiencesInput, context: ToolContext) -> ToolResult:
        items, next_cursor = await context.services.experience.list_experiences(
            context.user_id,
            limit=input.limit,
            category=input.category,
            tags=input.tags,
            q=input.q,
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
                        "tags": e.tags,
                    }
                    for e in items
                ],
                "nextCursor": next_cursor,
            },
        )


register(ListExperiencesTool())
