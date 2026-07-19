from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class SaveJdInput(BaseModel):
    title: str
    raw_text: str
    company: str | None = None
    target_role: str | None = None


class SaveJdTool:
    name: str = "save_jd"
    description: str = "Save a job description to the user's JD library"
    input_schema: type[BaseModel] = SaveJdInput
    requires_confirmation: bool = True
    risk_level: Literal["low", "medium", "high"] = "medium"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        typed_input = SaveJdInput.model_validate(input)
        jd = await context.services.jd.create_jd(
            context.user_id,
            title=typed_input.title,
            raw_text=typed_input.raw_text,
            company=typed_input.company,
            target_role=typed_input.target_role,
        )
        return ToolResult(
            status="success",
            data={"id": jd.id, "title": jd.title},
            message=f"JD '{jd.title}' saved with {len(jd.requirements)} parsed requirements.",
        )


register(SaveJdTool())
