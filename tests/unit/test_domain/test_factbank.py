from __future__ import annotations

from app.domain.resume.factbank.models import FactDraft
from app.domain.resume.factbank.service import (
    build_fact_records,
    compute_revision_hash,
    deterministic_fallback_facts,
    normalize_revision_content,
)


def test_revision_hash_ignores_formatting_noise() -> None:
    left = "  Built Python APIs  \r\n\r\n\r\nReduced latency 30%  "
    right = "Built Python APIs\n\nReduced latency 30%"

    assert normalize_revision_content(left) == right
    assert compute_revision_hash(left) == compute_revision_hash(right)


def test_revision_hash_changes_with_semantic_content() -> None:
    assert compute_revision_hash("Reduced latency 30%") != compute_revision_hash(
        "Reduced latency 40%"
    )


def test_fact_ids_are_stable_and_unsupported_metrics_are_removed() -> None:
    content = "使用 Python 构建数据接口，吞吐量提升 30%。"
    draft = FactDraft(
        action="构建",
        object="数据接口",
        technologies=("Python", "Rust"),
        result="吞吐量提升",
        metrics=("30%", "50%"),
        source_text=content,
    )
    kwargs = {
        "experience_id": "exp-1",
        "revision_id": "rev-1",
        "revision_hash": compute_revision_hash(content),
        "content": content,
        "drafts": [draft],
    }

    first = build_fact_records(**kwargs)
    second = build_fact_records(**kwargs)

    assert first[0].fact_id == second[0].fact_id
    assert first[0].technologies == ("Python",)
    assert first[0].metrics == ("30%",)
    assert "python" in first[0].lexical_tokens
    assert first[0].strength_score > 0.5


def test_unlocatable_source_text_is_rejected() -> None:
    facts = build_fact_records(
        experience_id="exp-1",
        revision_id="rev-1",
        revision_hash=compute_revision_hash("Built an API"),
        content="Built an API",
        drafts=[FactDraft(source_text="Invented revenue growth")],
    )

    assert facts == []


def test_deterministic_fallback_splits_markdown_and_sentences() -> None:
    content = "- 构建 Python 服务。吞吐量提升 30%。\n- 负责模型部署"
    kwargs = {
        "experience_id": "exp-1",
        "revision_id": "rev-1",
        "revision_hash": compute_revision_hash(content),
        "content": content,
    }

    first = deterministic_fallback_facts(**kwargs)
    second = deterministic_fallback_facts(**kwargs)

    assert [fact.source_text for fact in first] == [
        "构建 Python 服务。",
        "吞吐量提升 30%。",
        "负责模型部署",
    ]
    assert [fact.fact_id for fact in first] == [fact.fact_id for fact in second]
