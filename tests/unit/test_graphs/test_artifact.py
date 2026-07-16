"""Unit tests for artifact_draft_node de-canvas behaviour."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock


class _StructuredProvider:
    """Mock provider that satisfies both chat_structured (Layer B) and chat (legacy)."""

    async def chat_structured(self, messages, schema, **kwargs):
        # Return a minimal cover_letter structure that validates against the schema.
        return schema.model_validate(
            {
                "recipient": "Dear Hiring Manager",
                "opening": "I am writing to apply.",
                "body_paragraphs": [
                    {"text": "I bring relevant experience.", "source_experience_ids": [], "matched_jd_requirement_ids": []}
                ],
                "closing": "Looking forward to your response.",
                "signature": None,
            }
        )

    async def chat(self, messages, **kwargs):
        return "# Cover Letter\n\nDear Hiring Manager..."


class _StreamingArtifactProvider:
    async def chat(self, messages, **kwargs):
        assert kwargs.get("stream") is True

        async def tokens():
            yield "first "
            yield "second"

        return tokens()


async def test_artifact_generate_forwards_provider_tokens(monkeypatch) -> None:
    from app.graphs.artifact.nodes import artifact_generate_node

    emitted_events: list[dict[str, str]] = []
    monkeypatch.setattr(
        "app.graphs.artifact.nodes.get_provider",
        lambda: _StreamingArtifactProvider(),
    )
    monkeypatch.setattr(
        "app.graphs.artifact.nodes.get_stream_writer",
        lambda: emitted_events.append,
    )

    result = await artifact_generate_node(
        {
            "artifact_type": "other",
            "intent_description": "Write a summary",
            "workspace": {},
            "messages": [{"role": "user", "content": "Write it"}],
            "pending_sse_events": [],
        },
        {"configurable": {}},
    )

    assert emitted_events == [
        {"event": "agent.message.delta", "content": "first "},
        {"event": "agent.message.delta", "content": "second"},
    ]
    assert result["assistant_message"] == "first second"


async def test_artifact_default_no_canvas_events(monkeypatch) -> None:
    """Non-canvas artifact types persist to DB and set assistant_message to full content,
    without emitting any artifact.* SSE events (chat bubble IS the content)."""
    from app.graphs.artifact.nodes import artifact_draft_node, artifact_persist_node

    monkeypatch.setattr("app.graphs.artifact.nodes.get_provider", lambda: _StructuredProvider())

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

    draft = await artifact_draft_node(state, config)
    state.update(draft)
    persisted = await artifact_persist_node(state, config)

    # Full derived Markdown should be the assistant message
    assert isinstance(persisted["assistant_message"], str) and persisted["assistant_message"].strip()
    assert persisted["assistant_message"] == state["artifact_content"]

    # No artifact.* events should be emitted for the default chat path
    artifact_events = [
        e
        for e in persisted.get("pending_sse_events", [])
        if str(e.get("event", "")).startswith("artifact.")
    ]
    assert artifact_events == [], f"Expected no artifact events, got: {artifact_events}"


async def test_artifact_canvas_type_emits_events(monkeypatch) -> None:
    """Types in _CANVAS_ARTIFACT_TYPES must still emit artifact.* events from persist."""
    import app.graphs.artifact.nodes as nodes_module

    original = nodes_module._CANVAS_ARTIFACT_TYPES
    nodes_module._CANVAS_ARTIFACT_TYPES = {"cover_letter"}

    try:
        from app.graphs.artifact.nodes import artifact_draft_node, artifact_persist_node

        monkeypatch.setattr("app.graphs.artifact.nodes.get_provider", lambda: _StructuredProvider())

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

        draft = await artifact_draft_node(state, config)
        state.update(draft)
        persisted = await artifact_persist_node(state, config)

        artifact_events = [e["event"] for e in persisted.get("pending_sse_events", []) if "event" in e]
        assert "artifact.started" in artifact_events
        assert "artifact.delta" in artifact_events
        assert "artifact.completed" in artifact_events
        # assistant_message should be the short placeholder, not the full content
        assert persisted["assistant_message"] != state["artifact_content"]
    finally:
        nodes_module._CANVAS_ARTIFACT_TYPES = original
