from app.graphs.router import router_node


async def test_router_node_uses_preset_route_without_llm() -> None:
    result = await router_node(
        {
            "target_subgraph": "resume_generation",
            "intent_description": "Generate resume from selected JD",
            "artifact_type": None,
            "context_hints": [],
            "extracted_params": {},
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "resume_generation"
    assert result["intent_description"] == "Generate resume from selected JD"
    assert result["router_confidence"] == 1.0
    assert result["pending_sse_events"] == [
        {
            "event": "agent.route.completed",
            "target": "resume_generation",
            "intent_description": "Generate resume from selected JD",
            "confidence": 1.0,
        }
    ]
