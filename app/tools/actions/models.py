from __future__ import annotations

from pydantic import BaseModel, Field, JsonValue

from app.core.types import ArtifactType

JsonObject = dict[str, JsonValue]


class ProductActionResult(BaseModel):
    message: str
    workspace: JsonObject = Field(default_factory=dict)
    data: JsonValue | None = None
    interrupt: JsonObject | None = None


class OptimizeResumeItemInput(BaseModel):
    resumeItemId: str = Field(min_length=1)
    instruction: str = ""


class RewriteExperienceInput(BaseModel):
    experienceId: str = Field(min_length=1)
    instruction: str = ""


class GenerateResumeFromJdInput(BaseModel):
    jdId: str = Field(min_length=1)
    resumeId: str | None = None
    instruction: str = ""


class VariantInput(BaseModel):
    variantId: str = Field(min_length=1)


class GenerateArtifactInput(BaseModel):
    artifactType: ArtifactType
    instruction: str = ""
    title: str | None = None


class ExportResumeInput(BaseModel):
    resumeId: str = Field(min_length=1)

