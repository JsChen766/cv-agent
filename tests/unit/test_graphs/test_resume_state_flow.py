from __future__ import annotations

from app.graphs.resume.nodes import draft_generation_node, output_node, output_route, review_route


class _DraftProvider:
    async def chat(self, messages, **kwargs):
        return "# Resume\n\nGrounded content"


async def test_draft_regeneration_preserves_review_iteration(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.resume.nodes.get_provider", lambda: _DraftProvider())
    result = await draft_generation_node(
        {
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


def test_review_route_stops_at_configured_iteration(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.resume.nodes.settings.max_self_review_iterations", 3)
    state = {
        "review_iteration": 3,
        "review_result": {"verdict": "needs_revision"},
    }

    assert review_route(state) == "output"


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
        }
    )

    assert result["revision_instruction"] == "Focus on backend impact"
    assert result["review_iteration"] == 0
    assert output_route(result) == "revision"
