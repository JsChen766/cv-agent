from __future__ import annotations

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
    name = "create_artifact"
    description = "Save a generated artifact (cover letter, self-intro, match report, etc.) to the user's artifact library"
    input_schema = CreateArtifactInput
    requires_confirmation = True
    risk_level = "medium"

    async def execute(self, input: CreateArtifactInput, context: ToolContext) -> ToolResult:
        artifact = await context.services.artifact.create_artifact(
            context.user_id,
            {
                "type": input.artifact_type,
                "title": input.title,
                "content": input.content,
                "source_jd_id": input.source_jd_id,
                "source_experience_ids": input.source_experience_ids,
            },
        )
        return ToolResult(
            status="success",
            data={"id": artifact.id, "title": artifact.title, "wordCount": artifact.word_count},
            message=f"'{artifact.title}' saved to your artifact library.",
        )


register(CreateArtifactTool())
