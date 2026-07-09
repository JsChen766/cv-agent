from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.api.deps import get_current_user_id, pool_dep
from app.core.errors import ValidationError
from app.main import app


class _FakeConn:
    async def fetchrow(self, query: str, file_id: str, user_id: str) -> dict[str, Any]:
        return {
            "id": file_id,
            "user_id": user_id,
            "filename": "bad.pdf",
            "mime_type": "application/pdf",
            "storage_path": "fake/bad.pdf",
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
