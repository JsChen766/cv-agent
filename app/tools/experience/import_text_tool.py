from __future__ import annotations

from pydantic import BaseModel, Field

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class ImportTextInput(BaseModel):
    raw_text: str
    candidates: list[dict] = Field(default_factory=list)
    source_label: str | None = None


class ImportTextTool:
    name = "import_experience_text"
    description = "Import experiences from raw text (resume paste, LinkedIn export, etc.)"
    input_schema = ImportTextInput
    requires_confirmation = False
    risk_level = "low"

    async def execute(self, input: ImportTextInput, context: ToolContext) -> ToolResult:
        job, candidates = await context.services.experience.start_import_from_text(
            context.user_id, input.raw_text, input.candidates
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
