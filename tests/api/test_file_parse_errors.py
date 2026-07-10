from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.api.deps import get_current_user_id, pool_dep
from app.core.errors import FileParseTimeoutError, ValidationError
from app.main import app


class _FakeConn:
    async def fetchrow(self, query: str, file_id: str, user_id: str) -> dict[str, Any]:
        return {
            "id": file_id,
            "user_id": user_id,
            "filename": "bad.pdf",
            "mime_type": "application/pdf",
            "size_bytes": 15,
            "storage_path": "fake/bad.pdf",
            "parsed_text": None,
        }


class _Acquire:
    async def __aenter__(self) -> _FakeConn:
        return _FakeConn()

    async def __aexit__(self, *args: object) -> None:
        return None


class _FakePool:
    def acquire(self) -> _Acquire:
        return _Acquire()


class _FakeStorage:
    async def get(self, path: str) -> bytes:
        return b"%PDF-not-really"


async def _authenticated_user_id() -> str:
    return "user-1"


async def _pool() -> _FakePool:
    return _FakePool()


def test_parse_uploaded_file_returns_422_for_parser_failure(monkeypatch: Any) -> None:
    import app.api.routes.files as files_route

    async def fail_parse(content: bytes, mime_type: str) -> str:
        raise ValidationError("文件解析失败，请确认文件未损坏且格式正确")

    monkeypatch.setattr(files_route, "get_storage", lambda: _FakeStorage())
    monkeypatch.setattr(files_route, "parse_file_for_request", fail_parse)
    app.dependency_overrides[get_current_user_id] = _authenticated_user_id
    app.dependency_overrides[pool_dep] = _pool

    client = TestClient(app, raise_server_exceptions=False)
    try:
        response = client.post("/v1/files/file-1/parse")
    finally:
        app.dependency_overrides.clear()
        client.close()

    assert response.status_code == 422
    body = response.json()
    assert body["success"] is False
    assert body["error"]["code"] == "validation_error"
    assert body["error"]["message"] == "文件解析失败，请确认文件未损坏且格式正确"


def test_parse_uploaded_file_returns_408_for_parser_timeout(monkeypatch: Any) -> None:
    import app.api.routes.files as files_route

    async def timeout_parse(content: bytes, mime_type: str) -> str:
        raise FileParseTimeoutError("文件解析超时，请确认文件未损坏后重试")

    monkeypatch.setattr(files_route, "get_storage", lambda: _FakeStorage())
    monkeypatch.setattr(files_route, "parse_file_for_request", timeout_parse)
    app.dependency_overrides[get_current_user_id] = _authenticated_user_id
    app.dependency_overrides[pool_dep] = _pool

    client = TestClient(app, raise_server_exceptions=False)
    try:
        response = client.post("/v1/files/file-1/parse")
    finally:
        app.dependency_overrides.clear()
        client.close()

    assert response.status_code == 408
    body = response.json()
    assert body["success"] is False
    assert body["error"]["code"] == "file_parse_timeout"
    assert body["error"]["retryable"] is True
    assert body["error"]["message"] == "文件解析超时，请确认文件未损坏后重试"


def test_parse_uploaded_file_returns_existing_parsed_text(monkeypatch: Any) -> None:
    import app.api.routes.files as files_route

    class CachedConn:
        async def fetchrow(self, query: str, file_id: str, user_id: str) -> dict[str, Any]:
            return {
                "id": file_id,
                "user_id": user_id,
                "filename": "ok.pdf",
                "mime_type": "application/pdf",
                "size_bytes": 10,
                "storage_path": "fake/ok.pdf",
                "parsed_text": "already parsed",
            }

    class CachedAcquire:
        async def __aenter__(self) -> CachedConn:
            return CachedConn()

        async def __aexit__(self, *args: object) -> None:
            return None

    class CachedPool:
        def acquire(self) -> CachedAcquire:
            return CachedAcquire()

    async def fail_parse(content: bytes, mime_type: str) -> str:
        raise AssertionError("cached files should not be parsed again")

    async def cached_pool() -> CachedPool:
        return CachedPool()

    monkeypatch.setattr(files_route, "parse_file_for_request", fail_parse)
    app.dependency_overrides[get_current_user_id] = _authenticated_user_id
    app.dependency_overrides[pool_dep] = cached_pool

    client = TestClient(app, raise_server_exceptions=False)
    try:
        response = client.post("/v1/files/file-1/parse")
    finally:
        app.dependency_overrides.clear()
        client.close()

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"] == {
        "fileId": "file-1",
        "parsedText": "already parsed",
        "charCount": len("already parsed"),
    }


def test_upload_rejects_a_pdf_extension_with_non_pdf_content() -> None:
    """Invalid uploads must not reach pypdf and consume the parser timeout."""
    app.dependency_overrides[get_current_user_id] = _authenticated_user_id
    app.dependency_overrides[pool_dep] = _pool

    client = TestClient(app, raise_server_exceptions=False)
    try:
        response = client.post(
            "/v1/files/upload",
            files={"file": ("not-a-pdf.pdf", b'{"not":"a pdf"}', "application/pdf")},
        )
    finally:
        app.dependency_overrides.clear()
        client.close()

    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "validation_error"
    assert body["error"]["message"] == "文件内容不是有效的 PDF"
