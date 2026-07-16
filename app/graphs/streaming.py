"""Helpers for forwarding progressive UI events through LangGraph."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

StreamWriter = Callable[[dict[str, Any]], None]


def get_optional_stream_writer() -> StreamWriter | None:
    """Return LangGraph's writer when running inside a streamed graph node."""
    from langgraph.config import get_stream_writer

    try:
        return get_stream_writer()
    except RuntimeError:
        return None


def emit_message_deltas(
    writer: StreamWriter,
    content: str,
    *,
    chunk_size: int = 80,
) -> None:
    """Emit bounded fallback chunks when a provider has no token callback."""
    if not content:
        return
    size = max(1, chunk_size)
    for start in range(0, len(content), size):
        writer({"event": "agent.message.delta", "content": content[start : start + size]})


async def emit_message_deltas_progress(
    writer: StreamWriter,
    content: str,
    *,
    chunk_size: int = 80,
    frame_delay: float = 0.018,
) -> None:
    """Emit fallback text chunks with an event-loop/render-frame yield."""
    if not content:
        return
    size = max(1, chunk_size)
    for start in range(0, len(content), size):
        writer({"event": "agent.message.delta", "content": content[start : start + size]})
        if frame_delay > 0:
            await asyncio.sleep(frame_delay)
        else:
            await asyncio.sleep(0)


def emit_thinking(writer: StreamWriter, text: str) -> None:
    """Publish a user-visible progress update for structured/non-token work."""
    if text:
        writer({"event": "agent.thinking", "text": text})


def markdown_progress_chunks(content: str, *, max_chars: int = 420) -> list[str]:
    """Split Markdown into renderable paragraph/section-sized chunks.

    Chunks retain every character from ``content`` in order. Prefer paragraph
    boundaries, then fall back to bounded slices for unusually long blocks.
    """
    if not content:
        return []

    limit = max(1, max_chars)
    blocks = content.splitlines(keepends=True)
    chunks: list[str] = []
    current = ""

    for block in blocks:
        if current and len(current) + len(block) > limit:
            chunks.extend(_bounded_chunks(current, limit))
            current = ""
        current += block
        if not block.strip() and current:
            chunks.extend(_bounded_chunks(current, limit))
            current = ""

    if current:
        chunks.extend(_bounded_chunks(current, limit))
    return chunks


async def emit_content_diff_progress(
    writer: StreamWriter,
    content: str,
    *,
    resume_id: str,
    variant_id: str | None = None,
    structured: dict[str, Any] | None = None,
    diff: dict[str, Any] | None = None,
    frame_delay: float = 0.018,
    max_chars: int = 420,
) -> None:
    """Stream a completed structured document to the canvas progressively.

    Structured generation itself is atomic, but emitting paragraph-sized
    custom events with a render-frame yield prevents the transport and Vue
    scheduler from collapsing the full document into one visual update.
    """
    started: dict[str, Any] = {
        "event": "content.diff.started",
        "resume_id": resume_id,
    }
    if variant_id:
        started["variant_id"] = variant_id
    writer(started)

    chunks = markdown_progress_chunks(content, max_chars=max_chars)
    for index, chunk in enumerate(chunks):
        delta: dict[str, Any] = {
            "event": "content.diff.delta",
            "operations": [{"op": "insert", "text": chunk}],
        }
        if index == len(chunks) - 1:
            if structured is not None:
                delta["structured"] = structured
            if diff is not None:
                delta["diff"] = diff
        writer(delta)
        if frame_delay > 0:
            await asyncio.sleep(frame_delay)
        else:
            await asyncio.sleep(0)

    completed: dict[str, Any] = {
        "event": "content.diff.completed",
        "resume_id": resume_id,
        "total_insertions": len(chunks),
    }
    if variant_id:
        completed["variant_id"] = variant_id
    if diff is not None:
        completed["diff"] = diff
    writer(completed)


def _bounded_chunks(content: str, limit: int) -> list[str]:
    return [content[start : start + limit] for start in range(0, len(content), limit)]
