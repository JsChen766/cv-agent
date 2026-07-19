"""Shared deterministic grounding checks for generated resume text."""

from __future__ import annotations

import re

from app.domain.resume.planning.models import ResumePlan
from app.domain.resume.retrieval.models import HybridRetrievalResult

_SPACE = re.compile(r"\s+")
_COMMON_TECHNOLOGIES = {
    "airflow",
    "android",
    "angular",
    "aws",
    "azure",
    "c++",
    "clickhouse",
    "docker",
    "elasticsearch",
    "fastapi",
    "flask",
    "gcp",
    "git",
    "golang",
    "graphql",
    "hadoop",
    "java",
    "javascript",
    "kafka",
    "kotlin",
    "kubernetes",
    "langchain",
    "langgraph",
    "linux",
    "mongodb",
    "mysql",
    "next.js",
    "node.js",
    "openai",
    "pandas",
    "postgresql",
    "power bi",
    "pytorch",
    "react",
    "redis",
    "rust",
    "scala",
    "scikit-learn",
    "spark",
    "sql",
    "sqlite",
    "supabase",
    "swift",
    "tensorflow",
    "typescript",
    "vue",
}
_TECH_ALIASES = {
    "js": "javascript",
    "nodejs": "node.js",
    "node": "node.js",
    "postgres": "postgresql",
    "powerbi": "power bi",
    "sklearn": "scikit-learn",
    "ts": "typescript",
}


def technology_vocabulary(
    plan: ResumePlan,
    retrieval: HybridRetrievalResult,
) -> tuple[str, ...]:
    values = set(_COMMON_TECHNOLOGIES)
    values.update(
        _canonical_technology(value)
        for fact in retrieval.facts
        for value in fact.technologies
        if value.strip()
    )
    for requirement in plan.requirements:
        if requirement.category.lower() in {"technology", "skill", "technical_skill"}:
            values.update(
                _canonical_technology(value) for value in requirement.keywords if value.strip()
            )
    return tuple(
        sorted(
            (value for value in values if value),
            key=lambda value: (-len(value), value),
        )
    )


def unsupported_technologies(
    text: str,
    source_text: str,
    explicit_technologies: tuple[str, ...],
    vocabulary: tuple[str, ...],
) -> tuple[str, ...]:
    normalized_text = _normalize_technology_text(text)
    normalized_source = _normalize_technology_text(source_text)
    allowed = {_canonical_technology(value) for value in explicit_technologies}
    detected = {
        technology for technology in vocabulary if _contains_technology(normalized_text, technology)
    }
    supported = {
        technology
        for technology in detected
        if technology in allowed or _contains_technology(normalized_source, technology)
    }
    return tuple(sorted(detected - supported))


def _contains_technology(text: str, technology: str) -> bool:
    escaped = re.escape(technology)
    return re.search(rf"(?<![a-z0-9+#.]){escaped}(?![a-z0-9+#.])", text) is not None


def _canonical_technology(value: str) -> str:
    normalized = _normalize_technology_text(value).strip(" .")
    return _TECH_ALIASES.get(normalized, normalized)


def _normalize_technology_text(value: str) -> str:
    return _SPACE.sub(" ", value.casefold().replace("／", "/")).strip()
