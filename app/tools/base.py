from __future__ import annotations

from typing import Literal, Protocol

from pydantic import BaseModel, JsonValue

from app.domain.artifact.service import ArtifactService
from app.domain.experience.service import ExperienceService
from app.domain.jd.service import JdService
from app.domain.preference.service import PreferenceService
from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.service import ResumeService
from app.domain.user.service import UserService


class ServiceContainer(BaseModel):
    """All domain services, injected into tools."""

    model_config = {"arbitrary_types_allowed": True}

    experience: ExperienceService
    jd: JdService
    resume: ResumeService
    artifact: ArtifactService
    preference: PreferenceService
    user: UserService
    resume_layout: ResumeLayoutService | None = None


class ToolContext(BaseModel):
    """Runtime context passed to every tool execution."""

    model_config = {"arbitrary_types_allowed": True}

    user_id: str
    thread_id: str
    services: ServiceContainer


class ToolResult(BaseModel):
    status: Literal["success", "needs_input", "failed"]
    data: JsonValue | None = None
    message: str | None = None


class Tool(Protocol):
    name: str
    description: str
    input_schema: type[BaseModel]
    requires_confirmation: bool
    risk_level: Literal["low", "medium", "high"]

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult: ...
