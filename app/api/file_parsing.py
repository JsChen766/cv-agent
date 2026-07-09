from __future__ import annotations

import asyncio

from app.core.errors import ValidationError
from app.infra.files.parser import parse_file

DEFAULT_PARSE_TIMEOUT_SECONDS = 20.0
PARSE_FAILED_MESSAGE = "文件解析失败，请确认文件未损坏且格式正确"
PARSE_TIMEOUT_MESSAGE = "文件解析超时，请确认文件未损坏后重试"


async def parse_file_for_request(
    content: bytes,
    mime_type: str,
    *,
    timeout_seconds: float = DEFAULT_PARSE_TIMEOUT_SECONDS,
) -> str:
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(parse_file, content, mime_type),
            timeout=timeout_seconds,
        )
    except TimeoutError as exc:
        raise ValidationError(PARSE_TIMEOUT_MESSAGE) from exc
    except ValueError as exc:
        raise ValidationError(PARSE_FAILED_MESSAGE) from exc
