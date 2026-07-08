from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class CreateArtifactInput(BaseModel):
    artifact_type: str
    title: str
    content: str
    source_jd_id: str | None = None
    source_experience_ids: list[str] = Field(default_factory=list)


class CreateArtifactTool:
    name: str = "create_artifact"
    description: str = "Save a generated artifact (cover letter, self-intro, match report, etc.) to the user's artifact library"
    input_schema: type[BaseModel] = CreateArtifactInput
    requires_confirmation: bool = True
    risk_level: Literal["low", "medium", "high"] = "medium"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        typed_input = CreateArtifactInput.model_validate(input)
        artifact = await context.services.artifact.create_artifact(
            context.user_id,
            {
                "type": typed_input.artifact_type,
                "title": typed_input.title,
                "content": typed_input.content,
                "source_jd_id": typed_input.source_jd_id,
                "source_experience_ids": typed_input.source_experience_ids,
            },
        )
        return ToolResult(
            status="success",
            data={"id": artifact.id, "title": artifact.title, "wordCount": artifact.word_count},
            message=f"'{artifact.title}' saved to your artifact library.",
        )


register(CreateArtifactTool())
