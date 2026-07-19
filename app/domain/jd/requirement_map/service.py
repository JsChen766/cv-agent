from __future__ import annotations

import asyncio
import html
import logging
import re
import time
import unicodedata
from datetime import UTC, datetime
from hashlib import sha256

from app.core.errors import ExternalServiceError, ValidationError
from app.core.types import generate_id
from app.domain.jd.requirement_map.models import (
    ParsedRequirementDraft,
    Requirement,
    RequirementCategory,
    RequirementImportance,
    RequirementMap,
    RequirementMapResolution,
)
from app.domain.jd.requirement_map.parser import RequirementMapParser
from app.domain.jd.requirement_map.repository import RequirementMapRepository

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_ZERO_WIDTH_RE = re.compile(r"[\u200b-\u200d\ufeff]")
_INLINE_SPACE_RE = re.compile(r"[\t\f\v ]+")
_BLANK_LINES_RE = re.compile(r"\n{3,}")
_BULLET_RE = re.compile(r"^[\s\-–—•▪◦·*]+")
_TRAILING_PUNCTUATION_RE = re.compile(r"[\s。．.!！?？;；,，:：]+$")
_TOKEN_RE = re.compile(r"[\w+#.-]+", re.UNICODE)
logger = logging.getLogger(__name__)


def normalize_jd_text(raw_text: str) -> str:
    """Normalize formatting noise without deleting semantic JD content."""
    value = unicodedata.normalize("NFKC", html.unescape(raw_text))
    value = _ZERO_WIDTH_RE.sub("", value.replace("\r\n", "\n").replace("\r", "\n"))
    value = _HTML_TAG_RE.sub("\n", value)
    lines: list[str] = []
    for line in value.splitlines():
        normalized = _INLINE_SPACE_RE.sub(" ", line).strip()
        normalized = _BULLET_RE.sub("- ", normalized)
        lines.append(normalized)
    return _BLANK_LINES_RE.sub("\n\n", "\n".join(lines)).strip()


def compute_jd_hash(normalized_text: str) -> str:
    return sha256(normalized_text.casefold().encode("utf-8")).hexdigest()


def requirement_weight(
    category: RequirementCategory,
    importance: RequirementImportance,
) -> float:
    if importance == "optional":
        return 0.30
    if importance == "preferred":
        return 0.60
    if category == "responsibility":
        return 0.85
    return 1.00


def build_requirements(
    jd_hash: str,
    drafts: tuple[ParsedRequirementDraft, ...],
) -> tuple[tuple[Requirement, ...], int]:
    merged: list[ParsedRequirementDraft] = []
    duplicate_count = 0
    for draft in drafts:
        cleaned = _clean_draft(draft)
        if not cleaned.description:
            continue
        duplicate_index = _find_duplicate(merged, cleaned)
        if duplicate_index is None:
            merged.append(cleaned)
            continue
        duplicate_count += 1
        merged[duplicate_index] = _merge_drafts(merged[duplicate_index], cleaned)

    requirements = tuple(
        Requirement(
            requirement_id=_stable_requirement_id(jd_hash, draft),
            description=draft.description,
            category=draft.category,
            keywords=draft.keywords,
            importance=draft.importance,
            weight=requirement_weight(draft.category, draft.importance),
        )
        for draft in merged
    )
    return requirements, duplicate_count


class RequirementMapService:
    def __init__(
        self,
        repository: RequirementMapRepository,
        parser: RequirementMapParser,
        *,
        normalization_version: str,
        schema_version: str,
        parser_version: str,
        parser_model: str,
        deadline_seconds: float,
        max_normalized_chars: int,
    ) -> None:
        self._repository = repository
        self._parser = parser
        self._normalization_version = normalization_version
        self._schema_version = schema_version
        self._parser_version = parser_version
        self._parser_model = parser_model
        self._deadline_seconds = deadline_seconds
        self._max_normalized_chars = max_normalized_chars

    async def resolve(self, user_id: str, raw_text: str) -> RequirementMapResolution:
        started_at = time.perf_counter()
        normalized = normalize_jd_text(raw_text)
        if not normalized:
            raise ValidationError("Job description cannot be empty")
        if len(normalized) > self._max_normalized_chars:
            raise ValidationError(
                f"Job description exceeds {self._max_normalized_chars} normalized characters"
            )
        jd_hash = compute_jd_hash(normalized)
        cached = await self._repository.get_cached(
            user_id,
            jd_hash,
            normalization_version=self._normalization_version,
            schema_version=self._schema_version,
            parser_version=self._parser_version,
            parser_model=self._parser_model,
        )
        if cached is not None:
            logger.info(
                "RequirementMap cache hit",
                extra={
                    "user_id": user_id,
                    "jd_hash_prefix": jd_hash[:12],
                    "requirements_count": len(cached.requirements),
                    "normalized_length": len(normalized),
                    "parser_version": self._parser_version,
                    "parser_model": self._parser_model,
                    "duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
                },
            )
            return RequirementMapResolution(
                requirement_map=cached,
                cache_hit=True,
                normalized_length=len(normalized),
            )

        try:
            async with asyncio.timeout(self._deadline_seconds):
                parsed = await self._parser.parse(normalized)
        except TimeoutError as exc:
            logger.warning(
                "RequirementMap parse timed out",
                extra={
                    "user_id": user_id,
                    "jd_hash_prefix": jd_hash[:12],
                    "normalized_length": len(normalized),
                    "parser_version": self._parser_version,
                    "parser_model": self._parser_model,
                    "duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
                },
            )
            raise ExternalServiceError(
                "JD requirement parsing exceeded its deadline",
                code="jd_requirement_parse_timeout",
            ) from exc
        except ExternalServiceError:
            raise
        except Exception as exc:
            logger.warning(
                "RequirementMap parse failed",
                extra={
                    "user_id": user_id,
                    "jd_hash_prefix": jd_hash[:12],
                    "normalized_length": len(normalized),
                    "parser_version": self._parser_version,
                    "parser_model": self._parser_model,
                    "duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
                    "error_type": type(exc).__name__,
                },
            )
            raise ExternalServiceError(
                "JD requirement parsing failed",
                code="jd_requirement_parse_failed",
            ) from exc

        requirements, duplicate_count = build_requirements(jd_hash, parsed.requirements)
        if not requirements:
            raise ExternalServiceError(
                "JD requirement parser returned no usable requirements",
                code="jd_requirement_parse_empty",
            )
        now = datetime.now(UTC)
        requirement_map = RequirementMap(
            requirement_map_id=generate_id("rmap-"),
            user_id=user_id,
            jd_hash=jd_hash,
            normalization_version=self._normalization_version,
            schema_version=self._schema_version,
            parser_version=self._parser_version,
            parser_model=self._parser_model,
            title=_clean_optional(parsed.title),
            company=_clean_optional(parsed.company),
            target_role=_clean_optional(parsed.target_role),
            requirements=requirements,
            source="parsed",
            created_at=now,
            updated_at=now,
        )
        persisted = await self._repository.save(requirement_map)
        logger.info(
            "RequirementMap cache miss parsed",
            extra={
                "user_id": user_id,
                "jd_hash_prefix": jd_hash[:12],
                "requirements_count": len(persisted.requirements),
                "duplicate_count": duplicate_count,
                "normalized_length": len(normalized),
                "parser_version": self._parser_version,
                "parser_model": self._parser_model,
                "duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
            },
        )
        return RequirementMapResolution(
            requirement_map=persisted,
            cache_hit=False,
            normalized_length=len(normalized),
            duplicate_count=duplicate_count,
        )


def _clean_draft(draft: ParsedRequirementDraft) -> ParsedRequirementDraft:
    description = _INLINE_SPACE_RE.sub(" ", draft.description).strip()
    description = _TRAILING_PUNCTUATION_RE.sub("", description)
    keywords = tuple(
        dict.fromkeys(keyword.strip() for keyword in draft.keywords if keyword.strip())
    )
    return draft.model_copy(update={"description": description, "keywords": keywords})


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = _INLINE_SPACE_RE.sub(" ", value).strip()
    return cleaned or None


def _canonical_description(value: str) -> str:
    return " ".join(_TOKEN_RE.findall(value.casefold()))


def _find_duplicate(
    existing: list[ParsedRequirementDraft],
    candidate: ParsedRequirementDraft,
) -> int | None:
    candidate_text = _canonical_description(candidate.description)
    candidate_keywords = {value.casefold() for value in candidate.keywords}
    for index, item in enumerate(existing):
        item_text = _canonical_description(item.description)
        if candidate_text == item_text:
            return index
        shorter, longer = sorted((candidate_text, item_text), key=len)
        item_keywords = {value.casefold() for value in item.keywords}
        if shorter and shorter in longer and candidate_keywords & item_keywords:
            return index
    return None


def _merge_drafts(
    left: ParsedRequirementDraft,
    right: ParsedRequirementDraft,
) -> ParsedRequirementDraft:
    importance_order: dict[RequirementImportance, int] = {
        "optional": 0,
        "preferred": 1,
        "must_have": 2,
    }
    importance = max((left.importance, right.importance), key=importance_order.__getitem__)
    description = max((left.description, right.description), key=len)
    keywords = tuple(dict.fromkeys((*left.keywords, *right.keywords)))
    category = left.category if left.category == right.category else _stronger_category(left, right)
    return ParsedRequirementDraft(
        description=description,
        category=category,
        keywords=keywords,
        importance=importance,
    )


def _stronger_category(
    left: ParsedRequirementDraft,
    right: ParsedRequirementDraft,
) -> RequirementCategory:
    priority: dict[RequirementCategory, int] = {
        "technology": 5,
        "qualification": 4,
        "responsibility": 3,
        "domain": 2,
        "soft_skill": 1,
    }
    return max((left.category, right.category), key=priority.__getitem__)


def _stable_requirement_id(jd_hash: str, draft: ParsedRequirementDraft) -> str:
    signature = f"{draft.category}:{_canonical_description(draft.description)}"
    digest = sha256(f"{jd_hash}:{signature}".encode()).hexdigest()[:20]
    return f"req-{digest}"
