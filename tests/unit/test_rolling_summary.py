from __future__ import annotations

from app.memory.rolling_summary import MESSAGES_TO_KEEP, maybe_compress


async def test_maybe_compress_keeps_recent_messages_and_extends_summary(monkeypatch) -> None:
    captured = {}

    async def summarize(messages, prior_summary):
        captured["messages"] = messages
        captured["prior_summary"] = prior_summary
        return "updated summary"

    monkeypatch.setattr("app.memory.rolling_summary._summarise", summarize)
    messages = [
        {"role": "user", "content": f"message-{index}", "turn_id": None}
        for index in range(21)
    ]

    summary, recent = await maybe_compress(messages, "prior summary")

    assert summary == "updated summary"
    assert len(recent) == MESSAGES_TO_KEEP
    assert recent[0]["content"] == "message-13"
    assert captured["prior_summary"] == "prior summary"
    assert len(captured["messages"]) == 13
