from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, JsonValue

from app.tools.actions import capabilities
from app.tools.actions.models import (
    ExportResumeInput,
    GenerateArtifactInput,
    GenerateResumeFromJdInput,
    OptimizeResumeItemInput,
    RewriteExperienceInput,
    VariantInput,
)
from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


def _tool_data(result_data: JsonValue | None, workspace: dict[str, JsonValue]) -> JsonValue:
    if isinstance(result_data, dict):
        return {**result_data, "workspace": workspace}
    return {"result": result_data, "workspace": workspace}


class OptimizeResumeItemTool:
    name: str = "optimize_resume_item"
    description: str = "Rewrite and save one existing resume item using the user's instruction"
    input_schema: type[BaseModel] = OptimizeResumeItemInput
    requires_confirmation: bool = True
    risk_level: Literal["low", "medium", "high"] = "medium"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        result = await capabilities.optimize_resume_item(
            context.services,
            context.user_id,
            OptimizeResumeItemInput.model_validate(input),
        )
        return ToolResult(status="success", data=_tool_data(result.data, result.workspace), message=result.message)


class RewriteExperienceTool:
    name: str = "rewrite_experience"
    description: str = "Rewrite an existing experience entry and save it as a new AI generated revision"
    input_schema: type[BaseModel] = RewriteExperienceInput
    requires_confirmation: bool = True
    risk_level: Literal["low", "medium", "high"] = "medium"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        result = await capabilities.rewrite_experience(
            context.services,
            context.user_id,
            RewriteExperienceInput.model_validate(input),
        )
        return ToolResult(status="success", data=_tool_data(result.data, result.workspace), message=result.message)


class GenerateResumeFromJdTool:
    name: str = "generate_resume_from_jd"
    description: str = "Create a tailored resume variant from a saved JD"
    input_schema: type[BaseModel] = GenerateResumeFromJdInput
    requires_confirmation: bool = True
    risk_level: Literal["low", "medium", "high"] = "medium"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        result = await capabilities.generate_resume_from_jd(
            context.services,
            context.user_id,
            GenerateResumeFromJdInput.model_validate(input),
        )
        return ToolResult(status="success", data=_tool_data(result.data, result.workspace), message=result.message)


class AcceptVariantTool:
    name: str = "accept_variant"
    description: str = "Accept a generated resume variant and save it into the resume"
    input_schema: type[BaseModel] = VariantInput
    requires_confirmation: bool = True
    risk_level: Literal["low", "medium", "high"] = "medium"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        result = await capabilities.accept_variant(
            context.services,
            context.user_id,
            VariantInput.model_validate(input),
        )
        return ToolResult(status="success", data=_tool_data(result.data, result.workspace), message=result.message)


class ShowEvidenceTool:
    name: str = "show_evidence"
    description: str = "Explain the evidence, risks, and missing information for a generated resume variant"
    input_schema: type[BaseModel] = VariantInput
    requires_confirmation: bool = False
    risk_level: Literal["low", "medium", "high"] = "low"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        result = await capabilities.show_evidence(
            context.services,
            context.user_id,
            VariantInput.model_validate(input),
        )
        return ToolResult(status="success", data=_tool_data(result.data, result.workspace), message=result.message)


class GenerateArtifactTool:
    name: str = "generate_artifact"
    description: str = "Generate and save a career artifact such as a self introduction or cover letter"
    input_schema: type[BaseModel] = GenerateArtifactInput
    requires_confirmation: bool = True
    risk_level: Literal["low", "medium", "high"] = "medium"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        result = await capabilities.generate_artifact(
            context.services,
            context.user_id,
            GenerateArtifactInput.model_validate(input),
        )
        return ToolResult(status="success", data=_tool_data(result.data, result.workspace), message=result.message)


class ExportResumeTool:
    name: str = "export_resume"
    description: str = "Prepare resume export metadata for the browser print-to-PDF flow"
    input_schema: type[BaseModel] = ExportResumeInput
    requires_confirmation: bool = False
    risk_level: Literal["low", "medium", "high"] = "low"

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult:
        result = await capabilities.export_resume(
            context.services,
            context.user_id,
            ExportResumeInput.model_validate(input),
        )
        return ToolResult(status="success", data=_tool_data(result.data, result.workspace), message=result.message)


register(OptimizeResumeItemTool())
register(RewriteExperienceTool())
register(GenerateResumeFromJdTool())
register(AcceptVariantTool())
register(ShowEvidenceTool())
register(GenerateArtifactTool())
register(ExportResumeTool())
