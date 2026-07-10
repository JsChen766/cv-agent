from __future__ import annotations

import asyncio
from typing import Any

from app.core.config import settings
from app.core.errors import FileParseTimeoutError, ValidationError
from app.infra.files.parser import parse_file
from app.infra.files.storage import FileStorage

PARSE_FAILED_MESSAGE = "文件解析失败，请确认文件未损坏且格式正确"
PARSE_TIMEOUT_MESSAGE = "文件解析超时，请确认文件未损坏后重试"


async def parse_file_for_request(
    content: bytes,
    mime_type: str,
    *,
    timeout_seconds: float | None = None,
) -> str:
    timeout = timeout_seconds if timeout_seconds is not None else settings.file_parse_timeout_seconds
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(parse_file, content, mime_type),
            timeout=timeout,
        )
    except TimeoutError as exc:
        raise FileParseTimeoutError(PARSE_TIMEOUT_MESSAGE) from exc
    except ValueError as exc:
        raise ValidationError(PARSE_FAILED_MESSAGE) from exc


async def find_cached_parsed_text_for_upload(
    *,
    conn: Any,
    storage: FileStorage,
    user_id: str,
    file_id: str,
    filename: str,
    mime_type: str,
    size_bytes: int,
    content: bytes,
    candidate_limit: int = 5,
) -> str | None:
    """Reuse parsed text for an identical earlier upload.

    The table does not currently store a content hash, so candidates are narrowed
    by stable metadata and then verified by comparing stored bytes.
    """
    rows = await conn.fetch(
        """
        SELECT id, storage_path, parsed_text
        FROM uploaded_files
        WHERE user_id=$1
          AND id<>$2
          AND filename=$3
          AND mime_type=$4
          AND size_bytes=$5
          AND parsed_text IS NOT NULL
          AND length(trim(parsed_text)) > 0
        ORDER BY created_at DESC
        LIMIT $6
        """,
        user_id,
        file_id,
        filename,
        mime_type,
        size_bytes,
        candidate_limit,
    )
    for row in rows:
        try:
            cached_content = await storage.get(str(row["storage_path"]))
        except OSError:
            continue
        if cached_content == content:
            parsed_text = row["parsed_text"]
            if isinstance(parsed_text, str) and parsed_text.strip():
                return parsed_text
    return None
