from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.domain.experience.models import ImportCandidateDraft
from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class ImportTextInput(BaseModel):
    raw_text: str
    candidates: list[ImportCandidateDraft] = Field(default_factory=list)
    source_label: str | None = None


class ImportTextTool:
    name = "import_experience_text"
    description = "Import experiences from raw text (resume paste, LinkedIn export, etc.)"
    input_schema: type[BaseModel] = ImportTextInput
    requires_confirmation = False
    risk_level: Literal["low", "medium", "high"] = "low"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        typed_input = ImportTextInput.model_validate(input)
        job, candidates = await context.services.experience.start_import_from_text(
            context.user_id, typed_input.raw_text, typed_input.candidates
        )
        return ToolResult(
            status="needs_input",
            data={
                "jobId": job.id,
                "candidates": [
                    {
                        "id": c.id,
                        "title": c.title,
                        "category": c.category,
                        "organization": c.organization,
                        "content": c.content[:200] + "...",
                    }
                    for c in candidates
                ],
            },
            message=f"Found {len(candidates)} experiences to import. Please review and confirm.",
        )


register(ImportTextTool())
