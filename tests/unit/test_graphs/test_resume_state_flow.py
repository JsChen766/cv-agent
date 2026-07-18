from __future__ import annotations

import asyncio
import json

from app.graphs.resume.nodes import draft_generation_node, output_node, output_route, review_route


class _DraftProvider:
    async def chat_structured(self, messages, schema, **kwargs):
        # Minimal structured resume without the forbidden summary section.
        return schema.model_validate(
            {
                "language": "zh-CN",
                "contact": None,
                "sections": [
                    {
                        "type": "skills",
                        "heading": "技能",
                        "items": [
                            {
                                "raw_text": "Python",
                                "bullets": [],
                            }
                        ],
                    }
                ],
            }
        )


class _ParallelDraftProvider:
    def __init__(self) -> None:
        self.calls = 0
        self.active = 0
        self.max_active = 0

    async def chat_structured(self, messages, schema, **kwargs):
        self.calls += 1
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        await asyncio.sleep(0)
        payload = json.loads(messages[1]["content"])
        source_id = payload["source_experience"]["id"]
        fact_id = payload["allowed_facts"][0]["id"]
        self.active -= 1
        return schema.model_validate(
            {
                "source_experience_id": source_id,
                "bullets": [
                    {
                        "text": f"Delivered grounded work for {source_id}",
                        "source_fact_ids": [fact_id],
                        "matched_jd_requirement_ids": [],
                    }
                ],
            }
        )


class _InvalidParallelDraftProvider:
    def __init__(self) -> None:
        self.calls = 0

    async def chat_structured(self, messages, schema, **kwargs):
        self.calls += 1
        return schema.model_validate(
            {
                "source_experience_id": "wrong-source",
                "bullets": [
                    {
                        "text": "Ungrounded model output",
                        "source_fact_ids": ["unknown-fact"],
                        "matched_jd_requirement_ids": ["unknown-requirement"],
                    }
                ],
            }
        )


async def test_draft_regeneration_preserves_review_iteration(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.resume.nodes.get_provider", lambda: _DraftProvider())
    result = await draft_generation_node(
        {
            "intent_description": "Generate an English resume",
            "user_profile": {"preferred_language": "zh-CN"},
            "review_iteration": 2,
            "revision_instruction": "Make the evidence more specific",
            "evidence_pack": {
                "coverage_ratio": 0.8,
                "matches": [
                    {
                        "requirement_id": "req-1",
                        "requirement_text": "Python",
                        "matched_claims": [
                            {"text": "Built a Python service handling 1M requests/day"}
                        ],
                        "match_score": 0.91,
                    }
                ],
            },
            "workspace": {},
            "pending_sse_events": [],
        }
    )

    assert "review_iteration" not in result
    variant = result["variants"][0]
    assert variant["score"]["evidence_strength"] == 0.8
    assert variant["evidence_summary"][0]["supporting_claims"] == [
        "Built a Python service handling 1M requests/day"
    ]
    # Layer 2: structured is the primary product; markdown is derived
    assert variant["structured"]["sections"][0]["type"] == "skills"
    assert variant["structured"]["language"] == "en-US"
    assert "Python" in variant["content"]
    assert variant["structured"]["layout_profile_version"] == "resume-template-v2"


async def test_parallel_generation_fans_out_by_experience_and_keeps_one_variant(
    monkeypatch,
) -> None:
    provider = _ParallelDraftProvider()
    monkeypatch.setattr("app.graphs.resume.nodes.get_provider", lambda: provider)
    monkeypatch.setattr(
        "app.graphs.resume.nodes.settings.resume_parallel_generation_enabled", True
    )
    monkeypatch.setattr("app.graphs.resume.nodes.settings.resume_parallel_min_experiences", 2)
    monkeypatch.setattr("app.graphs.resume.nodes.settings.resume_generation_max_concurrency", 2)
    monkeypatch.setattr("app.graphs.resume.nodes.settings.resume_parallel_max_experiences", 4)
    experiences = [
        {
            "id": f"exp-{index}",
            "category": "work" if index == 1 else "project",
            "title": f"Experience {index}",
            "content": f"Grounded fact {index}",
            "claims": [{"text": f"Grounded fact {index}"}],
            "tags": ["Python"],
        }
        for index in (1, 2)
    ]
    budget = {
        "experiences": [
            {
                "experience_id": f"exp-{index}",
                "target_candidate_bullets": 4,
                "facts": [{"id": f"exp-{index}-fact-1", "text": f"Grounded fact {index}"}],
            }
            for index in (1, 2)
        ]
    }

    result = await draft_generation_node(
        {
            "relevant_experiences": experiences,
            "content_budget": budget,
            "user_profile": {"preferred_language": "en-US"},
            "pending_sse_events": [],
            "workspace": {},
        }
    )

    assert provider.calls == 2
    assert provider.max_active == 2
    assert result["generation_strategy"] == "parallel_experience_drafts"
    assert len(result["variants"]) == 1
    section_types = [
        section["type"] for section in result["variants"][0]["structured"]["sections"]
    ]
    assert section_types == ["experience", "project", "skills"]


async def test_parallel_generation_caps_calls_to_highest_ranked_experiences(
    monkeypatch,
) -> None:
    provider = _ParallelDraftProvider()
    monkeypatch.setattr("app.graphs.resume.nodes.get_provider", lambda: provider)
    monkeypatch.setattr(
        "app.graphs.resume.nodes.settings.resume_parallel_generation_enabled", True
    )
    monkeypatch.setattr("app.graphs.resume.nodes.settings.resume_parallel_min_experiences", 2)
    monkeypatch.setattr("app.graphs.resume.nodes.settings.resume_generation_max_concurrency", 2)
    monkeypatch.setattr("app.graphs.resume.nodes.settings.resume_parallel_max_experiences", 4)
    experiences = [
        {
            "id": f"exp-{index}",
            "category": "work",
            "title": f"Experience {index}",
            "content": f"Grounded fact {index}",
            "claims": [{"text": f"Grounded fact {index}"}],
        }
        for index in range(1, 7)
    ]
    budget = {
        "experiences": [
            {
                "experience_id": f"exp-{index}",
                "jd_match_score": index / 10,
                "target_candidate_bullets": 4,
                "facts": [{"id": f"exp-{index}-fact-1", "text": f"Grounded fact {index}"}],
            }
            for index in range(1, 7)
        ]
    }

    result = await draft_generation_node(
        {
            "relevant_experiences": experiences,
            "content_budget": budget,
            "user_profile": {"preferred_language": "en-US"},
            "pending_sse_events": [],
            "workspace": {},
        }
    )

    assert provider.calls == 4
    assert result["generation_strategy"] == "parallel_experience_drafts"
    structured = result["variants"][0]["structured"]
    generated_ids = {
        item["source_experience_id"]
        for section in structured["sections"]
        for item in section["items"]
        if item["bullets"]
    }
    assert generated_ids == {"exp-3", "exp-4", "exp-5", "exp-6"}
    narrative_items = [
        item
        for section in structured["sections"]
        if section["type"] != "skills"
        for item in section["items"]
    ]
    assert len(narrative_items) == 4


async def test_parallel_generation_uses_assembled_grounded_fallback_when_budget_is_missing(
    monkeypatch,
) -> None:
    provider = _ParallelDraftProvider()
    monkeypatch.setattr("app.graphs.resume.nodes.get_provider", lambda: provider)
    monkeypatch.setattr(
        "app.graphs.resume.nodes.settings.resume_parallel_generation_enabled", True
    )
    monkeypatch.setattr("app.graphs.resume.nodes.settings.resume_parallel_min_experiences", 2)
    monkeypatch.setattr("app.graphs.resume.nodes.settings.resume_generation_max_concurrency", 2)
    monkeypatch.setattr("app.graphs.resume.nodes.settings.resume_parallel_max_experiences", 4)
    experiences = [
        {
            "id": f"legacy-{index}",
            "category": "work",
            "title": f"Legacy {index}",
            "content": f"Grounded legacy fact {index}",
            "claims": [],
        }
        for index in range(1, 4)
    ]

    result = await draft_generation_node(
        {
            "assembled_experiences": experiences,
            "content_budget": {},
            "user_profile": {"preferred_language": "en-US"},
            "pending_sse_events": [],
            "workspace": {},
        }
    )

    assert provider.calls == 3
    assert result["generation_strategy"] == "parallel_experience_drafts"


async def test_parallel_generation_isolates_invalid_experience_output(monkeypatch) -> None:
    provider = _InvalidParallelDraftProvider()
    monkeypatch.setattr("app.graphs.resume.nodes.get_provider", lambda: provider)
    monkeypatch.setattr(
        "app.graphs.resume.nodes.settings.resume_parallel_generation_enabled", True
    )
    monkeypatch.setattr("app.graphs.resume.nodes.settings.resume_parallel_min_experiences", 2)
    experiences = [
        {
            "id": f"grounded-{index}",
            "category": "work",
            "title": f"Grounded {index}",
            "content": f"Verified source fact {index}",
            "claims": [],
        }
        for index in range(1, 3)
    ]

    result = await draft_generation_node(
        {
            "relevant_experiences": experiences,
            "content_budget": {},
            "user_profile": {"preferred_language": "en-US"},
            "pending_sse_events": [],
            "workspace": {},
        }
    )

    assert provider.calls == 2
    assert result["generation_strategy"] == "parallel_experience_drafts"
    bullets = [
        bullet
        for section in result["variants"][0]["structured"]["sections"]
        for item in section["items"]
        for bullet in item["bullets"]
    ]
    assert {bullet["text"] for bullet in bullets} == {
        "Verified source fact 1",
        "Verified source fact 2",
    }
    assert all(
        bullet["source_fact_ids"][0].startswith("grounded-") for bullet in bullets
    )


def test_review_route_stops_at_configured_iteration(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.resume.nodes.settings.max_self_review_iterations", 3)
    state = {
        "review_iteration": 3,
        "review_result": {"verdict": "needs_revision"},
    }

    assert review_route(state) == "quality_gate"


async def test_resume_review_feedback_routes_back_to_generation(monkeypatch) -> None:
    monkeypatch.setattr(
        "langgraph.types.interrupt",
        lambda payload: {"action": "revise", "feedback": "Focus on backend impact"},
    )

    result = await output_node(
        {
            "variants": [{"id": "variant-1", "title": "Draft", "content": "old"}],
            "workspace": {},
            "pending_sse_events": [],
            "review_iteration": 2,
            "quality_status": "passed",
        }
    )

    assert result["revision_instruction"] == "Focus on backend impact"
    assert result["review_iteration"] == 0
    assert output_route(result) == "revision"
