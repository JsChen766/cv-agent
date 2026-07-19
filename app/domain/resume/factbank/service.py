from __future__ import annotations

import hashlib
import re
import unicodedata
import uuid
from collections.abc import Iterable

from app.domain.resume.factbank.models import FactDraft, FactRecord

_FACT_ID_NAMESPACE = uuid.UUID("812cb44d-85e2-48ea-8cda-f9ce4ddaf931")
_LATIN_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9+#./_-]*", re.IGNORECASE)
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")
_SENTENCE_BOUNDARY_RE = re.compile(r"(?<=[。！？!?；;])\s*|\n+")
_MARKDOWN_PREFIX_RE = re.compile(r"^\s*(?:[-*•]+|\d+[.)])\s*")


def normalize_revision_content(content: str) -> str:
    """Normalize formatting noise while preserving semantic line boundaries."""
    normalized = unicodedata.normalize("NFKC", content).replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in normalized.split("\n")]
    compact: list[str] = []
    previous_blank = False
    for line in lines:
        blank = not line.strip()
        if blank and previous_blank:
            continue
        compact.append("" if blank else line.strip())
        previous_blank = blank
    return "\n".join(compact).strip()


def compute_revision_hash(content: str) -> str:
    normalized = normalize_revision_content(content)
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def build_fact_records(
    *,
    experience_id: str,
    revision_id: str,
    revision_hash: str,
    content: str,
    drafts: Iterable[FactDraft],
) -> list[FactRecord]:
    normalized_content = normalize_revision_content(content)
    records: list[FactRecord] = []
    seen: set[str] = set()
    search_offsets: dict[str, int] = {}

    for draft in drafts:
        source_text = normalize_revision_content(draft.source_text)
        if not source_text:
            continue
        start_at = search_offsets.get(source_text, 0)
        source_start = normalized_content.find(source_text, start_at)
        if source_start < 0:
            source_start = normalized_content.find(source_text)
        if source_start < 0:
            continue
        source_end = source_start + len(source_text)
        search_offsets[source_text] = source_end

        technologies = _supported_values(draft.technologies, source_text)
        metrics = _supported_values(draft.metrics, source_text)
        normalized_draft = draft.model_copy(
            update={
                "source_text": source_text,
                "action": _supported_optional(draft.action, source_text),
                "object": _supported_optional(draft.object, source_text),
                "method": _supported_optional(draft.method, source_text),
                "technologies": technologies,
                "scope": _supported_optional(draft.scope, source_text),
                "constraint": _supported_optional(draft.constraint, source_text),
                "result": _supported_optional(draft.result, source_text),
                "metrics": metrics,
                "time_range": _supported_optional(draft.time_range, source_text),
            }
        )
        dedup_key = "|".join(
            [
                _key(source_text),
                _key(normalized_draft.action),
                _key(normalized_draft.object),
                _key(normalized_draft.result),
            ]
        )
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        fact_id = _stable_fact_id(
            revision_id=revision_id,
            source_start=source_start,
            source_end=source_end,
            fingerprint=dedup_key,
        )
        records.append(
            FactRecord(
                **normalized_draft.model_dump(),
                fact_id=fact_id,
                experience_id=experience_id,
                source_revision_id=revision_id,
                source_revision_hash=revision_hash,
                source_start=source_start,
                source_end=source_end,
                strength_score=_strength_score(normalized_draft),
                lexical_tokens=lexical_tokens(normalized_draft),
                embedding_ref=fact_id,
            )
        )
    return records


def deterministic_fallback_facts(
    *,
    experience_id: str,
    revision_id: str,
    revision_hash: str,
    content: str,
) -> list[FactRecord]:
    normalized = normalize_revision_content(content)
    chunks: list[str] = []
    for part in _SENTENCE_BOUNDARY_RE.split(normalized):
        cleaned = _MARKDOWN_PREFIX_RE.sub("", part).strip(" \t-•")
        if cleaned:
            chunks.append(cleaned)
    drafts = [FactDraft(source_text=chunk) for chunk in _ordered_unique(chunks)]
    return build_fact_records(
        experience_id=experience_id,
        revision_id=revision_id,
        revision_hash=revision_hash,
        content=normalized,
        drafts=drafts,
    )


def clone_fact_records(
    facts: Iterable[FactRecord],
    *,
    experience_id: str,
    revision_id: str,
    revision_hash: str,
    content: str,
) -> list[FactRecord]:
    drafts = [FactDraft.model_validate(fact.model_dump()) for fact in facts]
    return build_fact_records(
        experience_id=experience_id,
        revision_id=revision_id,
        revision_hash=revision_hash,
        content=content,
        drafts=drafts,
    )


def lexical_tokens(draft: FactDraft) -> tuple[str, ...]:
    text = " ".join(
        value
        for value in (
            draft.source_text,
            draft.action,
            draft.object,
            draft.method,
            *draft.technologies,
            draft.scope,
            draft.constraint,
            draft.result,
            *draft.metrics,
            draft.time_range,
        )
        if value
    )
    normalized = unicodedata.normalize("NFKC", text).lower()
    tokens = [match.group(0) for match in _LATIN_TOKEN_RE.finditer(normalized)]
    for match in _CJK_RE.finditer(normalized):
        value = match.group(0)
        if len(value) == 1:
            tokens.append(value)
        else:
            tokens.extend(value[index : index + 2] for index in range(len(value) - 1))
    return tuple(_ordered_unique(tokens))


def _supported_values(values: Iterable[str], source_text: str) -> tuple[str, ...]:
    source_key = _key(source_text)
    return tuple(value.strip() for value in values if value.strip() and _key(value) in source_key)


def _supported_optional(value: str | None, source_text: str) -> str | None:
    if value is None or not value.strip():
        return None
    return value.strip() if _key(value) in _key(source_text) else None


def _strength_score(draft: FactDraft) -> float:
    score = 0.05
    score += 0.18 if draft.action else 0.0
    score += 0.12 if draft.object else 0.0
    score += 0.12 if draft.method else 0.0
    score += 0.08 if draft.technologies else 0.0
    score += 0.08 if draft.scope else 0.0
    score += 0.08 if draft.constraint else 0.0
    score += 0.17 if draft.result else 0.0
    score += 0.10 if draft.metrics else 0.0
    score += 0.02 if draft.time_range else 0.0
    return round(min(1.0, score), 4)


def _stable_fact_id(
    *, revision_id: str, source_start: int, source_end: int, fingerprint: str
) -> str:
    value = f"{revision_id}:{source_start}:{source_end}:{fingerprint}"
    return f"fact-{uuid.uuid5(_FACT_ID_NAMESPACE, value)}"


def _key(value: str | None) -> str:
    if not value:
        return ""
    return "".join(unicodedata.normalize("NFKC", value).lower().split())


def _ordered_unique(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        key = _key(value)
        if key and key not in seen:
            result.append(value)
            seen.add(key)
    return result
