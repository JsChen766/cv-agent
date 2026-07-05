from __future__ import annotations

from pydantic import BaseModel

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class GetArtifactInput(BaseModel):
    artifact_id: str


class GetArtifactTool:
    name = "get_artifact"
    description = "Retrieve a specific artifact's full content"
    input_schema = GetArtifactInput
    requires_confirmation = False
    risk_level = "low"

    async def execute(self, input: GetArtifactInput, context: ToolContext) -> ToolResult:
        artifact = await context.services.artifact.get_artifact(
            context.user_id, input.artifact_id
        )
        return ToolResult(
            status="success",
            data={
                "id": artifact.id,
                "type": artifact.type,
                "title": artifact.title,
                "content": artifact.content,
                "wordCount": artifact.word_count,
            },
        )


register(GetArtifactTool())
