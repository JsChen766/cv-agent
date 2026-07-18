from __future__ import annotations

import json

import pytest

from app.graphs.resume.nodes import layout_revision_node, layout_route
from app.tools.base import ServiceContainer
from tests.unit.test_domain.test_resume_repair import _repair_context


class _RepairProvider:
    def __init__(self) -> None:
        self.calls = []

    async def chat_structured(self, messages, schema, **kwargs):
        self.calls.append((messages, schema, kwargs))
        return schema.model_validate(
            {
                "repairs": [
                    {
                        "bullet_id": "bullet-1",
                        "candidates": [
                            {
                                "text": "A" * 68,
                                "source_fact_ids": ["exp-1-fact-1"],
                                "matched_jd_requirement_ids": ["req-1"],
                            }
                        ],
                    }
                ]
            }
        )


class _TwoBulletRepairProvider:
    def __init__(self) -> None:
        self.calls = []

    async def chat_structured(self, messages, schema, **kwargs):
        self.calls.append((messages, schema, kwargs))
        return schema.model_validate(
            {
                "repairs": [
                    {
                        "bullet_id": bullet_id,
                        "candidates": [
                            {
                                "text": "A" * length,
                                "source_fact_ids": ["exp-1-fact-1"],
                                "matched_jd_requirement_ids": ["req-1"],
                            }
                        ],
                    }
                    for bullet_id, length in (("bullet-1", 68), ("bullet-2", 69))
                ]
            }
        )


class _RejectedRepairProvider:
    async def chat_structured(self, messages, schema, **kwargs):
        return schema.model_validate(
            {
                "repairs": [
                    {
                        "bullet_id": "bullet-1",
                        "candidates": [
                            {
                                "text": "still short",
                                "source_fact_ids": ["exp-1-fact-1"],
                                "matched_jd_requirement_ids": ["req-1"],
                            }
                        ],
                    }
                ]
            }
        )


async def test_layout_revision_is_one_local_batch_and_keeps_one_variant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    layout, structured, report, experiences, budget = _repair_context()
    structured["sections"][0]["items"][0]["bullets"].append(
        {
            "id": "passing-bullet",
            "text": "B" * 68,
            "source_fact_ids": ["exp-1-fact-1"],
            "matched_jd_requirement_ids": [],
        }
    )
    report = layout.measure_resume_layout(structured)
    provider = _RepairProvider()
    monkeypatch.setattr("app.graphs.resume.nodes.get_provider", lambda: provider)
    services = ServiceContainer.model_construct(resume_layout=layout)

    result = await layout_revision_node(
        {
            "variants": [{"id": "variant-1", "structured": structured, "content": "old"}],
            "resume_structure": structured,
            "layout_report": report.model_dump(),
            "relevant_experiences": experiences,
            "content_budget": budget,
            "generation_call_count": 1,
        },
        {"configurable": {"services": services}},
    )

    assert len(provider.calls) == 1
    prompt = provider.calls[0][0][1]["content"]
    targets = json.loads(prompt.split("\n", 1)[1])
    assert [target["bullet_id"] for target in targets] == ["bullet-1"]
    assert "B" * 68 not in prompt
    assert len(result["variants"]) == 1
    assert result["variants"][0]["id"] == "variant-1"
    assert result["local_repair_call_count"] == 1
    assert result["local_repair_status"] == "applied"


async def test_layout_revision_repairs_all_failed_bullets_in_one_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    layout, structured, _report, experiences, budget = _repair_context()
    structured["sections"][0]["items"][0]["bullets"].append(
        {
            "id": "bullet-2",
            "text": "FastAPI",
            "source_fact_ids": ["exp-1-fact-1"],
            "matched_jd_requirement_ids": ["req-1"],
        }
    )
    report = layout.measure_resume_layout(structured)
    provider = _TwoBulletRepairProvider()
    monkeypatch.setattr("app.graphs.resume.nodes.get_provider", lambda: provider)

    result = await layout_revision_node(
        {
            "variants": [{"id": "variant-1", "structured": structured, "content": "old"}],
            "layout_report": report.model_dump(),
            "relevant_experiences": experiences,
            "content_budget": budget,
            "generation_call_count": 1,
        },
        {"configurable": {"services": ServiceContainer.model_construct(resume_layout=layout)}},
    )

    assert len(provider.calls) == 1
    repaired_bullets = result["variants"][0]["structured"]["sections"][0]["items"][0]["bullets"]
    assert [bullet["text"] for bullet in repaired_bullets] == ["A" * 68, "A" * 69]


async def test_layout_revision_exposes_pii_free_rejection_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    layout, structured, report, experiences, budget = _repair_context()
    monkeypatch.setattr(
        "app.graphs.resume.nodes.get_provider", lambda: _RejectedRepairProvider()
    )

    result = await layout_revision_node(
        {
            "variants": [{"id": "variant-1", "structured": structured, "content": "old"}],
            "layout_report": report.model_dump(),
            "relevant_experiences": experiences,
            "content_budget": budget,
            "generation_call_count": 1,
        },
        {"configurable": {"services": ServiceContainer.model_construct(resume_layout=layout)}},
    )

    assert result["local_repair_status"] == "rejected"
    assert result["local_repair_rejection_codes"] == [
        "no_passing_candidate",
        "layout_not_pass",
    ]
    assert result["local_repair_diagnostics"][0]["bullet_id"] == "bullet-1"
    assert "text" not in result["local_repair_diagnostics"][0]


def test_layout_route_does_not_send_non_bullet_failures_to_model() -> None:
    state = {
        "layout_report": {
            "status": "needs_revision",
            "violations": [{"code": "page_limit_exceeded", "severity": "hard"}],
        },
        "layout_revision_iteration": 0,
        "generation_call_count": 1,
        "local_repair_call_count": 0,
    }

    assert layout_route(state) == "failed"


def test_layout_route_enforces_single_local_repair_budget() -> None:
    state = {
        "layout_report": {
            "status": "needs_revision",
            "violations": [{"code": "bullet_too_short", "severity": "hard"}],
        },
        "layout_revision_iteration": 0,
        "generation_call_count": 1,
        "local_repair_call_count": 1,
    }

    assert layout_route(state) == "failed"
