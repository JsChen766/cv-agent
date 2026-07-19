from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock

import pytest

from app.core.errors import ExternalServiceError, ValidationError
from app.domain.jd.requirement_map.models import (
    ParsedJdDraft,
    ParsedRequirementDraft,
    RequirementMap,
)
from app.domain.jd.requirement_map.service import (
    RequirementMapService,
    build_requirements,
    compute_jd_hash,
    normalize_jd_text,
    requirement_weight,
)


class _MemoryRepository:
    def __init__(self) -> None:
        self.items: dict[tuple[str, ...], RequirementMap] = {}
        self.save_count = 0

    async def get_cached(
        self,
        user_id: str,
        jd_hash: str,
        *,
        normalization_version: str,
        schema_version: str,
        parser_version: str,
        parser_model: str,
    ) -> RequirementMap | None:
        return self.items.get(
            (
                user_id,
                jd_hash,
                normalization_version,
                schema_version,
                parser_version,
                parser_model,
            )
        )

    async def save(self, requirement_map: RequirementMap) -> RequirementMap:
        self.save_count += 1
        key = (
            requirement_map.user_id,
            requirement_map.jd_hash,
            requirement_map.normalization_version,
            requirement_map.schema_version,
            requirement_map.parser_version,
            requirement_map.parser_model,
        )
        existing = self.items.setdefault(key, requirement_map)
        return existing


def _service(
    repository: _MemoryRepository,
    parser: Any,
    *,
    deadline_seconds: float = 1.0,
    parser_version: str = "parser-v1",
) -> RequirementMapService:
    return RequirementMapService(
        repository,
        parser,
        normalization_version="normalization-v1",
        schema_version="schema-v1",
        parser_version=parser_version,
        parser_model="test-model",
        deadline_seconds=deadline_seconds,
        max_normalized_chars=10000,
    )


def _parsed() -> ParsedJdDraft:
    return ParsedJdDraft(
        title="Backend Engineer",
        company="Acme",
        target_role="Backend Engineer",
        requirements=(
            ParsedRequirementDraft(
                description="Build Python APIs.",
                category="responsibility",
                keywords=("Python", "API"),
                importance="must_have",
            ),
            ParsedRequirementDraft(
                description="Build Python APIs",
                category="responsibility",
                keywords=("Python",),
                importance="preferred",
            ),
            ParsedRequirementDraft(
                description="Experience with PostgreSQL",
                category="technology",
                keywords=("PostgreSQL",),
                importance="preferred",
            ),
        ),
    )


def test_normalization_produces_stable_hash_without_dropping_content() -> None:
    left = normalize_jd_text("<p>Backend Engineer</p>\r\n\u200b • Python  APIs")
    right = normalize_jd_text("Backend Engineer\n\n- Python APIs")

    assert compute_jd_hash(left) == compute_jd_hash(right)
    assert compute_jd_hash(left) != compute_jd_hash(f"{right}\nPostgreSQL")


def test_build_requirements_deduplicates_assigns_weights_and_stable_ids() -> None:
    jd_hash = compute_jd_hash("Backend Engineer")
    requirements, duplicates = build_requirements(jd_hash, _parsed().requirements)
    repeated, _ = build_requirements(jd_hash, _parsed().requirements)

    assert duplicates == 1
    assert len(requirements) == 2
    assert requirements[0].importance == "must_have"
    assert requirements[0].weight == 0.85
    assert requirements[1].weight == 0.60
    assert [item.requirement_id for item in requirements] == [
        item.requirement_id for item in repeated
    ]
    assert requirement_weight("technology", "must_have") == 1.0
    assert requirement_weight("soft_skill", "optional") == 0.3


async def test_cache_miss_calls_parser_once_and_hit_calls_it_zero_times() -> None:
    repository = _MemoryRepository()
    parser = AsyncMock()
    parser.parse.return_value = _parsed()
    service = _service(repository, parser)

    first = await service.resolve("user-1", "Backend Engineer\nBuild Python APIs")
    second = await service.resolve("user-1", "Backend Engineer\nBuild Python APIs")

    assert first.cache_hit is False
    assert first.duplicate_count == 1
    assert second.cache_hit is True
    parser.parse.assert_awaited_once()
    assert repository.save_count == 1


async def test_cache_is_tenant_and_version_scoped() -> None:
    repository = _MemoryRepository()
    parser = AsyncMock()
    parser.parse.return_value = _parsed()

    await _service(repository, parser).resolve("user-1", "Build APIs")
    await _service(repository, parser).resolve("user-2", "Build APIs")
    await _service(repository, parser, parser_version="parser-v2").resolve("user-1", "Build APIs")

    assert parser.parse.await_count == 3


async def test_parse_timeout_does_not_write_cache() -> None:
    repository = _MemoryRepository()

    class SlowParser:
        async def parse(self, normalized_jd_text: str) -> ParsedJdDraft:
            await asyncio.sleep(0.05)
            return _parsed()

    with pytest.raises(ExternalServiceError) as error:
        await _service(repository, SlowParser(), deadline_seconds=0.001).resolve(
            "user-1", "Build APIs"
        )

    assert error.value.code == "jd_requirement_parse_timeout"
    assert repository.save_count == 0


async def test_empty_or_oversized_jd_is_rejected_before_provider_call() -> None:
    repository = _MemoryRepository()
    parser = AsyncMock()
    parser.parse.return_value = _parsed()
    service = RequirementMapService(
        repository,
        parser,
        normalization_version="normalization-v1",
        schema_version="schema-v1",
        parser_version="parser-v1",
        parser_model="test-model",
        deadline_seconds=1,
        max_normalized_chars=10,
    )

    with pytest.raises(ValidationError):
        await service.resolve("user-1", " \n ")
    with pytest.raises(ValidationError):
        await service.resolve("user-1", "x" * 11)
    parser.parse.assert_not_awaited()
