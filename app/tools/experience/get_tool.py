from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class GetExperienceInput(BaseModel):
    experience_id: str


class GetExperienceTool:
    name: str = "get_experience"
    description: str = (
        "Get the full content of one specific experience by its ID. "
        "Always call list_experiences first to get the ID, then call this for the complete text. "
        "Returns the full description text needed for analysis or resume writing."
    )
    input_schema: type[BaseModel] = GetExperienceInput
    requires_confirmation: bool = False
    risk_level: Literal["low", "medium", "high"] = "low"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        typed_input = GetExperienceInput.model_validate(input)
        exp = await context.services.experience.get_experience(
            context.user_id, typed_input.experience_id
        )
        revisions = await context.services.experience.get_revisions(
            context.user_id, typed_input.experience_id
        )
        return ToolResult(
            status="success",
            data={
                "id": exp.id,
                "title": exp.title,
                "category": exp.category,
                "organization": exp.organization,
                "content": exp.current_revision.content if exp.current_revision else "",
                "revisionCount": len(revisions),
            },
        )


register(GetExperienceTool())
