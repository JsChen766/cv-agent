from __future__ import annotations

import time

import pytest

from app.api import file_parsing
from app.core.errors import FileParseTimeoutError, ValidationError


async def test_parse_file_for_request_converts_parser_value_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_parse(content: bytes, mime_type: str) -> str:
        raise ValueError("PDF parsing failed")

    monkeypatch.setattr(file_parsing, "parse_file", fail_parse)

    with pytest.raises(ValidationError) as exc_info:
        await file_parsing.parse_file_for_request(b"bad pdf", "application/pdf")

    assert exc_info.value.message == file_parsing.PARSE_FAILED_MESSAGE


async def test_parse_file_for_request_times_out(monkeypatch: pytest.MonkeyPatch) -> None:
    def slow_parse(content: bytes, mime_type: str) -> str:
        time.sleep(0.05)
        return "late result"

    monkeypatch.setattr(file_parsing, "parse_file", slow_parse)

    with pytest.raises(FileParseTimeoutError) as exc_info:
        await file_parsing.parse_file_for_request(
            b"slow pdf",
            "application/pdf",
            timeout_seconds=0.001,
        )

    assert exc_info.value.message == file_parsing.PARSE_TIMEOUT_MESSAGE
    assert exc_info.value.http_status == 408


async def test_parse_file_for_request_uses_configured_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def slow_parse(content: bytes, mime_type: str) -> str:
        time.sleep(0.05)
        return "late result"

    monkeypatch.setattr(file_parsing, "parse_file", slow_parse)
    monkeypatch.setattr(file_parsing.settings, "file_parse_timeout_seconds", 0.001)

    with pytest.raises(FileParseTimeoutError):
        await file_parsing.parse_file_for_request(b"slow pdf", "application/pdf")


class _CacheStorage:
    def __init__(self, files: dict[str, bytes]) -> None:
        self._files = files

    async def save(self, content: bytes, filename: str, user_id: str) -> str:
        raise NotImplementedError

    async def get(self, path: str) -> bytes:
        return self._files[path]

    async def delete(self, path: str) -> None:
        raise NotImplementedError


class _CacheConn:
    async def fetch(self, query: str, *args: object) -> list[dict[str, object]]:
        return [
            {
                "id": "file-old",
                "storage_path": "stored/old.pdf",
                "parsed_text": "cached parsed text",
            }
        ]


async def test_find_cached_parsed_text_verifies_matching_content() -> None:
    cached = await file_parsing.find_cached_parsed_text_for_upload(
        conn=_CacheConn(),
        storage=_CacheStorage({"stored/old.pdf": b"same bytes"}),
        user_id="user-1",
        file_id="file-new",
        filename="resume.pdf",
        mime_type="application/pdf",
        size_bytes=10,
        content=b"same bytes",
    )

    assert cached == "cached parsed text"


async def test_find_cached_parsed_text_skips_non_matching_content() -> None:
    cached = await file_parsing.find_cached_parsed_text_for_upload(
        conn=_CacheConn(),
        storage=_CacheStorage({"stored/old.pdf": b"different bytes"}),
        user_id="user-1",
        file_id="file-new",
        filename="resume.pdf",
        mime_type="application/pdf",
        size_bytes=10,
        content=b"same bytes",
    )

    assert cached is None
