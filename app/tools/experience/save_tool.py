from __future__ import annotations

from pydantic import BaseModel, Field

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class SaveExperienceInput(BaseModel):
    title: str
    content: str
    category: str = "work"
    organization: str | None = None
    role: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    tags: list[str] = Field(default_factory=list)


class SaveExperienceTool:
    name = "save_experience"
    description = "Create a new experience entry in the user's experience library"
    input_schema = SaveExperienceInput
    requires_confirmation = True
    risk_level = "medium"

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
