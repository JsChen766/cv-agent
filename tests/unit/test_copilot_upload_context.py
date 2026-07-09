from __future__ import annotations

from typing import Any

from app.api.routes.copilot import ChatRequest, _build_chat_initial_state


class _FakeConn:
    def __init__(self) -> None:
        self.updated_text: str | None = None

    async def fetchrow(self, query: str, file_id: str, user_id: str) -> dict[str, Any]:
        return {
            "id": file_id,
            "user_id": user_id,
            "filename": "resume.pdf",
            "mime_type": "application/pdf",
            "storage_path": "fake/path/resume.pdf",
            "parsed_text": None,
        }

    async def execute(self, query: str, parsed_text: str, file_id: str) -> None:
        self.updated_text = parsed_text


class _Acquire:
    def __init__(self, conn: _FakeConn) -> None:
        self._conn = conn

    async def __aenter__(self) -> _FakeConn:
        return self._conn

    async def __aexit__(self, *args: object) -> None:
        return None


class _FakePool:
    def __init__(self, conn: _FakeConn) -> None:
        self._conn = conn

    def acquire(self) -> _Acquire:
        return _Acquire(self._conn)


class _FakeStorage:
    async def get(self, path: str) -> bytes:
        return b"%PDF fake"


def test_chat_request_accepts_frontend_client_state_fields() -> None:
    body = ChatRequest.model_validate(
        {
            "message": "save to experience library",
            "clientState": {
                "intentSource": "composer",
                "sourceComponent": "AgentRoom",
                "activeThreadId": "thread-1",
                "resumeUpload": {
                    "fileId": "file-1",
                    "originalName": "resume.pdf",
                    "uiOnlyUnknown": True,
                },
                "uploadedFileId": "file-1",
                "unknownFrontendKey": "ignored",
            },
        }
    )

    assert body.clientState.intentSource == "composer"
    assert body.clientState.sourceComponent == "AgentRoom"
    assert body.clientState.activeThreadId == "thread-1"
    assert body.clientState.resumeUpload is not None
    assert body.clientState.resumeUpload.fileId == "file-1"


async def test_build_chat_initial_state_uses_uploaded_file_text(monkeypatch: Any) -> None:
    import app.api.routes.copilot as copilot_route
    import app.infra.files.storage as storage_mod

    async def parse_for_request(content: bytes, mime_type: str) -> str:
        return "Parsed resume experience from the uploaded file."

    monkeypatch.setattr(storage_mod, "get_storage", lambda: _FakeStorage())
    monkeypatch.setattr(copilot_route, "parse_file_for_request", parse_for_request)

    body = ChatRequest.model_validate(
        {
            "message": "save to experience library",
            "clientState": {
                "resumeUpload": {
                    "fileId": "file-1",
                    "originalName": "resume.pdf",
                },
            },
        }
    )
    conn = _FakeConn()

    state = await _build_chat_initial_state(
        thread_id="thread-1",
        user_id="user-1",
        message=body.message,
        client_state=body.clientState,
        turn_id="turn-1",
        pool=_FakePool(conn),  # type: ignore[arg-type]
    )

    assert state["workspace"]["file_id"] == "file-1"
    assert state["extracted_params"]["raw_text"] == "Parsed resume experience from the uploaded file."
    assert state["extracted_params"]["file_id"] == "file-1"
    assert state["extracted_params"]["source"] == "uploaded_file"
    assert state["extracted_params"]["original_name"] == "resume.pdf"
    assert conn.updated_text == "Parsed resume experience from the uploaded file."
