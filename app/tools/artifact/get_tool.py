from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class GetArtifactInput(BaseModel):
    artifact_id: str


class GetArtifactTool:
    name: str = "get_artifact"
    description: str = "Retrieve a specific artifact's full content"
    input_schema: type[BaseModel] = GetArtifactInput
    requires_confirmation: bool = False
    risk_level: Literal["low", "medium", "high"] = "low"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        typed_input = GetArtifactInput.model_validate(input)
        artifact = await context.services.artifact.get_artifact(
            context.user_id, typed_input.artifact_id
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
