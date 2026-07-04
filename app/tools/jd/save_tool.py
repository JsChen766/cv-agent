from __future__ import annotations

from pydantic import BaseModel

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class SaveJdInput(BaseModel):
    title: str
    raw_text: str
    company: str | None = None
    target_role: str | None = None


class SaveJdTool:
    name = "save_jd"
    description = "Save a job description to the user's JD library"
    requires_confirmation = False
    risk_level = "low"

    async def execute(self, input: SaveJdInput, context: ToolContext) -> ToolResult:
        jd = await context.services.jd.create_jd(
            context.user_id,
            title=input.title,
            raw_text=input.raw_text,
            company=input.company,
            target_role=input.target_role,
        )
        return ToolResult(
            status="success",
            data={"id": jd.id, "title": jd.title},
            message=f"JD '{jd.title}' saved. Requirements will be extracted automatically.",
        )


register(SaveJdTool())
