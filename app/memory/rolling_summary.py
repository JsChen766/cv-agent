"""
Rolling summary for long conversation histories.

When message count exceeds threshold, older messages are compressed
into a summary and removed from the state, preserving only recent turns.
"""

from __future__ import annotations

from app.memory.thread_state import MessageDict

COMPRESSION_THRESHOLD = 20    # messages before we start compressing
MESSAGES_TO_KEEP = 8          # how many recent messages to keep uncompressed


async def maybe_compress(
    messages: list[MessageDict],
    existing_summary: str | None = None,
) -> tuple[str | None, list[MessageDict]]:
    """
    If len(messages) > threshold, compress older messages.

    Returns (new_summary, messages_to_keep).
    If no compression needed, returns (existing_summary, messages).
    """
    if len(messages) <= COMPRESSION_THRESHOLD:
        return existing_summary, messages

    to_compress = messages[:-MESSAGES_TO_KEEP]
    recent = messages[-MESSAGES_TO_KEEP:]

    new_summary = await _summarise(to_compress, existing_summary)
    return new_summary, recent


async def _summarise(
    messages: list[MessageDict],
    prior_summary: str | None,
) -> str:
    """LLM call to compress a batch of messages into a summary paragraph."""
    from app.providers.factory import get_provider

    provider = get_provider()
    history_text = "\n".join(
        f"{m['role'].upper()}: {m['content'][:300]}" for m in messages
    )

    prior_section = ""
    if prior_summary:
        prior_section = f"\n\nExisting summary (expand this):\n{prior_summary}"

    result = await provider.chat(
        [
            {
                "role": "system",
                "content": (
                    "Summarise the conversation history below in 2-4 sentences, "
                    "preserving key decisions, user preferences, and important context "
                    "relevant to resume writing."
                    + prior_section
                ),
            },
            {"role": "user", "content": history_text},
        ],
        temperature=0.3,
        max_tokens=300,
    )
    return str(result)
