from __future__ import annotations

from app.graphs.streaming import emit_content_diff_progress, markdown_progress_chunks


def test_markdown_progress_chunks_preserve_content() -> None:
    content = "# Profile\n\nShort summary.\n\n## Experience\n\n" + ("A" * 120)

    chunks = markdown_progress_chunks(content, max_chars=40)

    assert len(chunks) > 2
    assert "".join(chunks) == content
    assert all(len(chunk) <= 40 for chunk in chunks)


async def test_emit_content_diff_progress_sends_separate_canvas_events() -> None:
    emitted: list[dict[str, object]] = []
    content = "# Profile\n\nSummary.\n\n## Experience\n\nBuilt a product."

    await emit_content_diff_progress(
        emitted.append,
        content,
        resume_id="resume-1",
        variant_id="variant-1",
        structured={"sections": []},
        diff={"changed_bullet_ids": ["bul-1"]},
        frame_delay=0,
        max_chars=24,
    )

    event_types = [event["event"] for event in emitted]
    assert event_types[0] == "content.diff.started"
    assert event_types[-1] == "content.diff.completed"
    deltas = [event for event in emitted if event["event"] == "content.diff.delta"]
    assert len(deltas) > 1
    assert (
        "".join(
            str(operation["text"])
            for event in deltas
            for operation in event["operations"]  # type: ignore[index]
        )
        == content
    )
    assert deltas[-1]["structured"] == {"sections": []}
    assert emitted[-1]["variant_id"] == "variant-1"
