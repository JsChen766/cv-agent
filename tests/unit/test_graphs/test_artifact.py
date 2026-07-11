"""Unit tests for artifact_draft_node de-canvas behaviour."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock


async def test_artifact_draft_node_default_no_canvas_events(monkeypatch) -> None:
    """Non-canvas artifact types must set assistant_message to full content and emit no artifact.* SSE events."""
    from app.graphs.artifact.nodes import artifact_draft_node

    fake_content = "# Cover Letter\n\nDear Hiring Manager..."

    class FakeProvider:
        async def chat(self, messages, **kwargs):
            return fake_content

    monkeypatch.setattr("app.graphs.artifact.nodes.get_provider", lambda: FakeProvider())

    artifact = MagicMock()
    artifact.id = "art-1"
    services = MagicMock()
    services.artifact.create_artifact = AsyncMock(return_value=artifact)

    config: dict[str, Any] = {"configurable": {"pool": None, "services": services}}

    state: dict[str, Any] = {
        "user_id": "user-1",
        "artifact_type": "cover_letter",
        "intent_description": "Write a cover letter",
        "assembled_jd_text": "Engineer role",
        "assembled_experiences": [],
        "assembled_user_profile": {"preferred_language": "en"},
        "assembled_preferences": [],
        "workspace": {},
        "pending_sse_events": [],
    }

    result = await artifact_draft_node(state, config)

    # Full Markdown should be the assistant message
    assert result["assistant_message"] == fake_content

    # No artifact.* events should be emitted
    artifact_events = [
        e
        for e in result.get("pending_sse_events", [])
        if str(e.get("event", "")).startswith("artifact.")
    ]
    assert artifact_events == [], f"Expected no artifact events, got: {artifact_events}"


async def test_artifact_draft_node_canvas_type_emits_events(monkeypatch) -> None:
    """Types in _CANVAS_ARTIFACT_TYPES must still emit artifact.* events."""
    import app.graphs.artifact.nodes as nodes_module

    original = nodes_module._CANVAS_ARTIFACT_TYPES
    nodes_module._CANVAS_ARTIFACT_TYPES = {"cover_letter"}

    try:
        from app.graphs.artifact.nodes import artifact_draft_node

        fake_content = "# Cover Letter\n\nDear Hiring Manager..."

        class FakeProvider:
            async def chat(self, messages, **kwargs):
                return fake_content

        monkeypatch.setattr("app.graphs.artifact.nodes.get_provider", lambda: FakeProvider())

        artifact = MagicMock()
        artifact.id = "art-1"
        services = MagicMock()
        services.artifact.create_artifact = AsyncMock(return_value=artifact)

        config: dict[str, Any] = {"configurable": {"pool": None, "services": services}}
        state: dict[str, Any] = {
            "user_id": "user-1",
            "artifact_type": "cover_letter",
            "intent_description": "",
            "assembled_jd_text": "",
            "assembled_experiences": [],
            "assembled_user_profile": {},
            "assembled_preferences": [],
            "workspace": {},
            "pending_sse_events": [],
        }

        result = await artifact_draft_node(state, config)

        artifact_events = [e["event"] for e in result.get("pending_sse_events", []) if "event" in e]
        assert "artifact.started" in artifact_events
        assert "artifact.delta" in artifact_events
        assert "artifact.completed" in artifact_events
        # assistant_message should be the short placeholder, not the full content
        assert result["assistant_message"] != fake_content
    finally:
        nodes_module._CANVAS_ARTIFACT_TYPES = original
