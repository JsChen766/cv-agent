"""
Rolling summary for long conversation histories.

When message count exceeds threshold, older messages are compressed
into a summary and removed from the state, preserving only recent turns.
"""

from __future__ import annotations

from app.memory.thread_state import MessageDict

COMPRESSION_THRESHOLD = 40    # messages before we start compressing (~20 turns)
MESSAGES_TO_KEEP = 16         # how many recent messages to keep uncompressed (~8 turns)


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
        f"{m['role'].upper()}: {m['content'][:500]}" for m in messages
    )

    prior_section = ""
    if prior_summary:
        prior_section = f"\n\n已有摘要（在此基础上累积，不要丢失已有信息）：\n{prior_summary}"

    result = await provider.chat(
        [
            {
                "role": "system",
                "content": (
                    "你是一个对话压缩助手。请将下方对话历史压缩为简洁的摘要，"
                    "用于后续对话的上下文参考。\n\n"
                    "**必须保留的信息**：\n"
                    "- 用户表达过的明确需求和偏好（例如：想找什么类型的岗位、简历风格偏好）\n"
                    "- 已完成的操作（例如：导入了哪些经历、生成了什么简历、保存了哪个JD）\n"
                    "- 用户提供过的关键信息（例如：目标公司、目标职位、工作年限）\n"
                    "- 对话中做出的决定（例如：决定先优化某段经历再生成）\n"
                    "- 待解决的问题（例如：某段经历还没写完）\n\n"
                    "**格式**：3-6句话，中文，按时间顺序，保留具体细节（不要泛化）。\n"
                    "例如：不要写'用户讨论了简历'，要写'用户导入了3段工作经历，目标是字节跳动后端工程师岗位，"
                    "已生成初版简历草稿，用户要求再优化工作经历中的技术描述部分'。"
                    + prior_section
                ),
            },
            {"role": "user", "content": history_text},
        ],
        temperature=0.2,
        max_tokens=500,
    )
    return str(result)
