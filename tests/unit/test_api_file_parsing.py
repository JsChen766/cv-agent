from __future__ import annotations

import time

import pytest

from app.api import file_parsing
from app.core.errors import ValidationError


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

    with pytest.raises(ValidationError) as exc_info:
        await file_parsing.parse_file_for_request(
            b"slow pdf",
            "application/pdf",
            timeout_seconds=0.001,
        )

    assert exc_info.value.message == file_parsing.PARSE_TIMEOUT_MESSAGE
