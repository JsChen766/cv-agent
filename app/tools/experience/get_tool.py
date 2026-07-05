from __future__ import annotations

from pydantic import BaseModel

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class GetExperienceInput(BaseModel):
    experience_id: str


class GetExperienceTool:
    name = "get_experience"
    description = "Get full details of a specific experience including all revisions"
    input_schema = GetExperienceInput
    requires_confirmation = False
    risk_level = "low"

    async def execute(self, input: GetExperienceInput, context: ToolContext) -> ToolResult:
        exp = await context.services.experience.get_experience(context.user_id, input.experience_id)
        revisions = await context.services.experience.get_revisions(context.user_id, input.experience_id)
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
