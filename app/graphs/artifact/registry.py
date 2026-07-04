"""Artifact type registry — add new artifact types here."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ArtifactTypeConfig:
    default_context_hints: list[str] = field(default_factory=list)
    default_tone: str = "professional"
    max_tokens: int = 2000


ARTIFACT_REGISTRY: dict[str, ArtifactTypeConfig] = {
    "cover_letter": ArtifactTypeConfig(
        default_context_hints=["active_jd", "experiences", "profile"],
        max_tokens=800,
    ),
    "self_intro": ArtifactTypeConfig(
        default_context_hints=["experiences", "target_role", "profile"],
        max_tokens=400,
    ),
    "match_report": ArtifactTypeConfig(
        default_context_hints=["active_jd", "experiences"],
        max_tokens=1500,
    ),
    "interview_prep": ArtifactTypeConfig(
        default_context_hints=["active_jd", "experiences", "profile"],
        max_tokens=2000,
    ),
    "linkedin_summary": ArtifactTypeConfig(
        default_context_hints=["experiences", "profile"],
        max_tokens=500,
    ),
    "other": ArtifactTypeConfig(
        default_context_hints=["experiences"],
        max_tokens=2000,
    ),
}


def get_config(artifact_type: str) -> ArtifactTypeConfig:
    return ARTIFACT_REGISTRY.get(artifact_type, ARTIFACT_REGISTRY["other"])
