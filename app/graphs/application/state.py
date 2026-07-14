from __future__ import annotations

from typing import Any

from app.graphs.resume.state import ResumeGenerationState


class ApplicationPackageState(ResumeGenerationState, total=False):
    """Resume state plus the additional deliverables required by a JD."""

    application_tasks: list[dict[str, Any]]
    application_deliverables: list[dict[str, Any]]
    unsupported_requirements: list[dict[str, Any]]
