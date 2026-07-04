from __future__ import annotations

from pydantic import BaseModel

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class SaveExperienceInput(BaseModel):
    category: str
    title: str
    content: str
    organization: str | None = None
    role: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    tags: list[str] = []


class SaveExperienceTool:
    name = "save_experience"
    description = "Create a new experience entry in the user's experience library"
    requires_confirmation = False
    risk_level = "low"

    async def execute(self, input: SaveExperienceInput, context: ToolContext) -> ToolResult:
        exp = await context.services.experience.create_experience(
            context.user_id,
            category=input.category,
            title=input.title,
            content=input.content,
            organization=input.organization,
            role=input.role,
            start_date=input.start_date,
            end_date=input.end_date,
            tags=input.tags,
        )
        return ToolResult(
            status="success",
            data={"id": exp.id, "title": exp.title},
            message=f"Experience '{exp.title}' saved successfully",
        )


register(SaveExperienceTool())
