from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.core.types import ExperienceCategory
from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class SaveExperienceInput(BaseModel):
    title: str
    content: str
    category: ExperienceCategory = "work"
    organization: str | None = None
    role: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    tags: list[str] = Field(default_factory=list)


class SaveExperienceTool:
    name: str = "save_experience"
    description: str = "Create a new experience entry in the user's experience library"
    input_schema: type[BaseModel] = SaveExperienceInput
    requires_confirmation: bool = True
    risk_level: Literal["low", "medium", "high"] = "medium"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        typed_input = SaveExperienceInput.model_validate(input)
        exp = await context.services.experience.create_experience(
            context.user_id,
            category=typed_input.category,
            title=typed_input.title,
            content=typed_input.content,
            organization=typed_input.organization,
            role=typed_input.role,
            start_date=typed_input.start_date,
            end_date=typed_input.end_date,
            tags=typed_input.tags,
        )
        return ToolResult(
            status="success",
            data={"id": exp.id, "title": exp.title},
            message=f"Experience '{exp.title}' saved successfully",
        )


register(SaveExperienceTool())
