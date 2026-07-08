from __future__ import annotations

from typing import Literal

import pytest
from fastapi.testclient import TestClient

from app.api.deps import (
    get_artifact_service,
    get_current_user_id,
    get_experience_service,
    get_jd_service,
    get_preference_service,
    get_resume_service,
    get_user_service,
)
from app.api.routes.threads import _require_thread
from app.core.errors import ForbiddenError, NotFoundError
from app.main import app

HttpMethod = Literal["delete", "get", "patch", "post"]


@pytest.fixture
def client() -> TestClient:
    app.dependency_overrides.clear()
    test_client = TestClient(app, raise_server_exceptions=False)
    try:
        yield test_client
    finally:
        app.dependency_overrides.clear()
        test_client.close()


async def _authenticated_user_id() -> str:
    return "user-b"


class _ListExperienceService:
    async def list_experiences(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
        category: str | None = None,
        tags: list[str] | None = None,
        q: str | None = None,
    ) -> tuple[list[object], str | None]:
        return [], None


class _ListJdService:
    async def list_jds(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
    ) -> tuple[list[object], str | None]:
        return [], None


class _ListResumeService:
    async def list_resumes(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
    ) -> tuple[list[object], str | None]:
        return [], None


class _ListArtifactService:
    async def list_artifacts(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
        type: str | None = None,
    ) -> tuple[list[object], str | None]:
        return [], None


class _CrossUserExperienceService(_ListExperienceService):
    async def get_experience(self, user_id: str, experience_id: str) -> object:
        raise NotFoundError(f"Experience not found: {experience_id}")

    async def update_experience_meta(self, user_id: str, experience_id: str, patch: object) -> object:
        raise NotFoundError(f"Experience not found: {experience_id}")

    async def archive_experience(self, user_id: str, experience_id: str) -> None:
        raise NotFoundError(f"Experience not found: {experience_id}")

    async def add_revision(
        self,
        user_id: str,
        experience_id: str,
        content: str,
        source: str = "manual",
    ) -> object:
        raise NotFoundError(f"Experience not found: {experience_id}")

    async def accept_candidate(self, user_id: str, candidate_id: str) -> object:
        raise NotFoundError(f"Import candidate not found: {candidate_id}")

    async def reject_candidate(self, user_id: str, candidate_id: str) -> None:
        raise NotFoundError(f"Import candidate not found: {candidate_id}")


class _CrossUserJdService(_ListJdService):
    async def get_jd(self, user_id: str, jd_id: str) -> object:
        raise NotFoundError(f"JD not found: {jd_id}")

    async def delete_jd(self, user_id: str, jd_id: str) -> None:
        raise NotFoundError(f"JD not found: {jd_id}")


class _CrossUserResumeService(_ListResumeService):
    async def get_resume(self, user_id: str, resume_id: str) -> object:
        raise NotFoundError(f"Resume not found: {resume_id}")

    async def update_resume(self, user_id: str, resume_id: str, patch: object) -> object:
        raise NotFoundError(f"Resume not found: {resume_id}")

    async def add_item(self, user_id: str, resume_id: str, data: object) -> object:
        raise NotFoundError(f"Resume not found: {resume_id}")

    async def update_item_by_id(self, user_id: str, item_id: str, patch: object) -> object:
        raise NotFoundError(f"Resume item not found: {item_id}")

    async def delete_item_by_id(self, user_id: str, item_id: str) -> None:
        raise NotFoundError(f"Resume item not found: {item_id}")

    async def reorder_items(self, user_id: str, resume_id: str, ordered_ids: list[str]) -> list[object]:
        raise NotFoundError(f"Resume not found: {resume_id}")


class _CrossUserArtifactService(_ListArtifactService):
    async def get_artifact(self, user_id: str, artifact_id: str) -> object:
        raise NotFoundError(f"Artifact not found: {artifact_id}")

    async def update_artifact(self, user_id: str, artifact_id: str, patch: dict[str, object]) -> object:
        raise NotFoundError(f"Artifact not found: {artifact_id}")

    async def delete_artifact(self, user_id: str, artifact_id: str) -> None:
        raise NotFoundError(f"Artifact not found: {artifact_id}")


class _PreferenceService:
    async def record_signal(
        self,
        user_id: str,
        *,
        signal_type: str,
        raw_content: str,
        context: dict[str, object] | None = None,
    ) -> None:
        return None


class _UserService:
    pass


async def _experience_service() -> _ListExperienceService:
    return _ListExperienceService()


async def _jd_service() -> _ListJdService:
    return _ListJdService()


async def _resume_service() -> _ListResumeService:
    return _ListResumeService()


async def _artifact_service() -> _ListArtifactService:
    return _ListArtifactService()


async def _cross_user_experience_service() -> _CrossUserExperienceService:
    return _CrossUserExperienceService()


async def _cross_user_jd_service() -> _CrossUserJdService:
    return _CrossUserJdService()


async def _cross_user_resume_service() -> _CrossUserResumeService:
    return _CrossUserResumeService()


async def _cross_user_artifact_service() -> _CrossUserArtifactService:
    return _CrossUserArtifactService()


async def _preference_service() -> _PreferenceService:
    return _PreferenceService()


async def _user_service() -> _UserService:
    return _UserService()


def _install_auth_and_list_services() -> None:
    app.dependency_overrides[get_current_user_id] = _authenticated_user_id
    app.dependency_overrides[get_experience_service] = _experience_service
    app.dependency_overrides[get_jd_service] = _jd_service
    app.dependency_overrides[get_resume_service] = _resume_service
    app.dependency_overrides[get_artifact_service] = _artifact_service
    app.dependency_overrides[get_preference_service] = _preference_service
    app.dependency_overrides[get_user_service] = _user_service


PROTECTED_ENDPOINTS: list[tuple[str, HttpMethod, str, dict[str, object]]] = [
    ("users-me", "get", "/v1/users/me", {}),
    ("profile-get", "get", "/v1/users/me/profile", {}),
    ("profile-patch", "patch", "/v1/users/me/profile", {"json": {}}),
    ("preferences-list", "get", "/v1/users/me/preferences", {}),
    ("preferences-post", "post", "/v1/users/me/preferences", {"json": {"rule": "x", "category": "tone"}}),
    ("preferences-delete", "delete", "/v1/users/me/preferences/pref-owned-by-a", {}),
    ("file-upload", "post", "/v1/files/upload", {"files": {"file": ("a.txt", b"x", "text/plain")}}),
    ("file-parse", "post", "/v1/files/file-owned-by-a/parse", {}),
    ("experiences-list", "get", "/v1/product/experiences", {}),
    (
        "experiences-post",
        "post",
        "/v1/product/experiences",
        {"json": {"category": "project", "title": "x", "content": "x"}},
    ),
    ("experiences-get", "get", "/v1/product/experiences/exp-owned-by-a", {}),
    ("experiences-patch", "patch", "/v1/product/experiences/exp-owned-by-a", {"json": {"title": "x"}}),
    ("experiences-delete", "delete", "/v1/product/experiences/exp-owned-by-a", {}),
    (
        "experience-revision",
        "post",
        "/v1/product/experiences/exp-owned-by-a/revisions",
        {"json": {"content": "x"}},
    ),
    ("import-text", "post", "/v1/product/import/text", {"json": {"raw_text": "x", "candidates": []}}),
    ("candidate-accept", "post", "/v1/product/import-candidates/cand-owned-by-a/accept", {}),
    ("candidate-reject", "post", "/v1/product/import-candidates/cand-owned-by-a/reject", {}),
    ("jds-list", "get", "/v1/product/jds", {}),
    ("jds-post", "post", "/v1/product/jds", {"json": {"title": "x", "raw_text": "x"}}),
    ("jds-get", "get", "/v1/product/jds/jd-owned-by-a", {}),
    ("jds-delete", "delete", "/v1/product/jds/jd-owned-by-a", {}),
    ("resumes-list", "get", "/v1/product/resumes", {}),
    ("resumes-post", "post", "/v1/product/resumes", {"json": {"title": "x"}}),
    ("resumes-get", "get", "/v1/product/resumes/resume-owned-by-a", {}),
    ("resumes-patch", "patch", "/v1/product/resumes/resume-owned-by-a", {"json": {"title": "x"}}),
    (
        "resume-item-add",
        "post",
        "/v1/product/resumes/resume-owned-by-a/items",
        {"json": {"section_type": "summary", "content_snapshot": "x"}},
    ),
    ("resume-item-patch", "patch", "/v1/product/resume-items/item-owned-by-a", {"json": {"title": "x"}}),
    ("resume-item-delete", "delete", "/v1/product/resume-items/item-owned-by-a", {}),
    (
        "resume-reorder",
        "post",
        "/v1/product/resumes/resume-owned-by-a/reorder",
        {"json": {"ordered_ids": ["item-owned-by-a"]}},
    ),
    ("artifacts-list", "get", "/v1/product/artifacts", {}),
    ("artifacts-get", "get", "/v1/product/artifacts/artifact-owned-by-a", {}),
    ("artifacts-patch", "patch", "/v1/product/artifacts/artifact-owned-by-a", {"json": {"title": "x"}}),
    ("artifacts-delete", "delete", "/v1/product/artifacts/artifact-owned-by-a", {}),
    ("copilot-chat", "post", "/v1/copilot/chat", {"json": {"message": "x"}}),
    ("copilot-stream", "post", "/v1/copilot/chat/stream", {"json": {"message": "x"}}),
    (
        "copilot-actions",
        "post",
        "/v1/copilot/actions",
        {"json": {"action": {"type": "export_resume", "payload": {"resumeId": "resume-owned-by-a"}}}},
    ),
    ("copilot-sidebar", "get", "/v1/copilot/sidebar", {}),
    ("threads-list", "get", "/v1/threads", {}),
    ("threads-get", "get", "/v1/threads/thread-owned-by-a", {}),
    ("threads-patch", "patch", "/v1/threads/thread-owned-by-a", {"json": {"title": "x"}}),
    ("threads-resume", "post", "/v1/threads/thread-owned-by-a/resume", {"json": {"turnId": "turn-1"}}),
    ("threads-discard", "post", "/v1/threads/thread-owned-by-a/discard", {"json": {"turnId": "turn-1"}}),
]


@pytest.mark.parametrize(
    ("case_id", "method", "path", "kwargs"),
    PROTECTED_ENDPOINTS,
    ids=[case[0] for case in PROTECTED_ENDPOINTS],
)
def test_protected_endpoints_reject_unauthenticated_requests(
    client: TestClient,
    case_id: str,
    method: HttpMethod,
    path: str,
    kwargs: dict[str, object],
) -> None:
    response = getattr(client, method)(path, **kwargs)

    assert response.status_code == 401, case_id


PAGINATED_PATHS = [
    "/v1/product/experiences",
    "/v1/product/jds",
    "/v1/product/resumes",
    "/v1/product/artifacts",
    "/v1/threads",
]


@pytest.mark.parametrize("path", PAGINATED_PATHS)
@pytest.mark.parametrize("limit", [0, 101])
def test_paginated_endpoints_reject_out_of_range_limits(
    client: TestClient,
    path: str,
    limit: int,
) -> None:
    _install_auth_and_list_services()

    response = client.get(path, params={"limit": limit})

    assert response.status_code == 422


@pytest.mark.parametrize("path", PAGINATED_PATHS)
@pytest.mark.parametrize(
    "params",
    [
        {},
        {"limit": "1"},
        {"limit": "100"},
        {"limit": "1", "cursor": "cursor-token"},
    ],
)
def test_paginated_endpoints_accept_supported_limit_cursor_combinations(
    client: TestClient,
    path: str,
    params: dict[str, str],
) -> None:
    _install_auth_and_list_services()
    query_params = dict(params)
    if path == "/v1/threads" and query_params.get("cursor") == "cursor-token":
        query_params["cursor"] = "2026-07-07T00:00:00+00:00"

    response = client.get(path, params=query_params)

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["items"] == []
    assert data["nextCursor"] is None


@pytest.mark.parametrize(
    ("case_id", "method", "path", "kwargs"),
    [
        ("experience-category-query", "get", "/v1/product/experiences", {"params": {"category": "invalid"}}),
        ("artifact-type-query", "get", "/v1/product/artifacts", {"params": {"type": "invalid"}}),
        ("create-experience-empty-title", "post", "/v1/product/experiences", {"json": {"category": "project", "title": "", "content": "x"}}),
        ("create-experience-invalid-category", "post", "/v1/product/experiences", {"json": {"category": "invalid", "title": "x", "content": "x"}}),
        ("create-jd-missing-title", "post", "/v1/product/jds", {"json": {"raw_text": "x"}}),
        ("create-jd-extra-field", "post", "/v1/product/jds", {"json": {"title": "x", "raw_text": "x", "unexpected": True}}),
        ("create-resume-empty-title", "post", "/v1/product/resumes", {"json": {"title": ""}}),
        ("resume-invalid-status", "patch", "/v1/product/resumes/resume-1", {"json": {"status": "invalid"}}),
        (
            "resume-item-negative-order",
            "post",
            "/v1/product/resumes/resume-1/items",
            {"json": {"section_type": "summary", "order_index": -1}},
        ),
        ("resume-reorder-empty", "post", "/v1/product/resumes/resume-1/reorder", {"json": {"ordered_ids": []}}),
        ("profile-negative-years", "patch", "/v1/users/me/profile", {"json": {"years_of_experience": -1}}),
        ("preference-empty-rule", "post", "/v1/users/me/preferences", {"json": {"rule": "", "category": "tone"}}),
        ("chat-empty-message", "post", "/v1/copilot/chat", {"json": {"message": ""}}),
        (
            "action-invalid-type",
            "post",
            "/v1/copilot/actions",
            {"json": {"action": {"type": "invalid", "payload": {}}}},
        ),
        (
            "action-missing-required-payload-field",
            "post",
            "/v1/copilot/actions",
            {"json": {"action": {"type": "export_resume", "payload": {}}}},
        ),
        (
            "action-extra-payload-field",
            "post",
            "/v1/copilot/actions",
            {"json": {"action": {"type": "export_resume", "payload": {"resumeId": "r1", "extra": True}}}},
        ),
        ("thread-empty-title", "patch", "/v1/threads/thread-1", {"json": {"title": ""}}),
        ("thread-invalid-status", "patch", "/v1/threads/thread-1", {"json": {"status": "invalid"}}),
        ("thread-resume-empty-turn", "post", "/v1/threads/thread-1/resume", {"json": {"turnId": ""}}),
    ],
)
def test_field_validation_boundaries_return_422(
    client: TestClient,
    case_id: str,
    method: HttpMethod,
    path: str,
    kwargs: dict[str, object],
) -> None:
    _install_auth_and_list_services()

    response = getattr(client, method)(path, **kwargs)

    assert response.status_code == 422, case_id


def test_thread_list_rejects_invalid_datetime_cursor(client: TestClient) -> None:
    _install_auth_and_list_services()

    response = client.get("/v1/threads", params={"cursor": "cursor-token"})

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("case_id", "method", "path", "kwargs", "service_override", "service_factory"),
    [
        ("experience-get", "get", "/v1/product/experiences/exp-owned-by-a", {}, get_experience_service, _cross_user_experience_service),
        ("experience-patch", "patch", "/v1/product/experiences/exp-owned-by-a", {"json": {"title": "x"}}, get_experience_service, _cross_user_experience_service),
        ("experience-delete", "delete", "/v1/product/experiences/exp-owned-by-a", {}, get_experience_service, _cross_user_experience_service),
        ("experience-revision", "post", "/v1/product/experiences/exp-owned-by-a/revisions", {"json": {"content": "x"}}, get_experience_service, _cross_user_experience_service),
        ("candidate-accept", "post", "/v1/product/import-candidates/cand-owned-by-a/accept", {}, get_experience_service, _cross_user_experience_service),
        ("candidate-reject", "post", "/v1/product/import-candidates/cand-owned-by-a/reject", {}, get_experience_service, _cross_user_experience_service),
        ("jd-get", "get", "/v1/product/jds/jd-owned-by-a", {}, get_jd_service, _cross_user_jd_service),
        ("jd-delete", "delete", "/v1/product/jds/jd-owned-by-a", {}, get_jd_service, _cross_user_jd_service),
        ("resume-get", "get", "/v1/product/resumes/resume-owned-by-a", {}, get_resume_service, _cross_user_resume_service),
        ("resume-patch", "patch", "/v1/product/resumes/resume-owned-by-a", {"json": {"title": "x"}}, get_resume_service, _cross_user_resume_service),
        (
            "resume-item-add",
            "post",
            "/v1/product/resumes/resume-owned-by-a/items",
            {"json": {"section_type": "summary", "content_snapshot": "x"}},
            get_resume_service,
            _cross_user_resume_service,
        ),
        ("resume-item-patch", "patch", "/v1/product/resume-items/item-owned-by-a", {"json": {"title": "x"}}, get_resume_service, _cross_user_resume_service),
        ("resume-item-delete", "delete", "/v1/product/resume-items/item-owned-by-a", {}, get_resume_service, _cross_user_resume_service),
        (
            "resume-reorder",
            "post",
            "/v1/product/resumes/resume-owned-by-a/reorder",
            {"json": {"ordered_ids": ["item-owned-by-a"]}},
            get_resume_service,
            _cross_user_resume_service,
        ),
        ("artifact-get", "get", "/v1/product/artifacts/artifact-owned-by-a", {}, get_artifact_service, _cross_user_artifact_service),
        ("artifact-patch", "patch", "/v1/product/artifacts/artifact-owned-by-a", {"json": {"title": "x"}}, get_artifact_service, _cross_user_artifact_service),
        ("artifact-delete", "delete", "/v1/product/artifacts/artifact-owned-by-a", {}, get_artifact_service, _cross_user_artifact_service),
    ],
)
def test_cross_user_product_resources_return_not_found(
    client: TestClient,
    case_id: str,
    method: HttpMethod,
    path: str,
    kwargs: dict[str, object],
    service_override: object,
    service_factory: object,
) -> None:
    app.dependency_overrides[get_current_user_id] = _authenticated_user_id
    app.dependency_overrides[service_override] = service_factory
    app.dependency_overrides[get_preference_service] = _preference_service

    response = getattr(client, method)(path, **kwargs)

    assert response.status_code == 404, case_id


class _ThreadRow(dict[str, object]):
    pass


class _ThreadConnection:
    async def fetchrow(self, query: str, thread_id: str) -> _ThreadRow:
        return _ThreadRow({"id": thread_id, "user_id": "user-a"})


class _ThreadAcquireContext:
    async def __aenter__(self) -> _ThreadConnection:
        return _ThreadConnection()

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        return None


class _ThreadPool:
    def acquire(self) -> _ThreadAcquireContext:
        return _ThreadAcquireContext()


@pytest.mark.asyncio
async def test_cross_user_thread_helper_returns_forbidden() -> None:
    with pytest.raises(ForbiddenError) as exc_info:
        await _require_thread(_ThreadPool(), "thread-owned-by-a", "user-b")

    assert getattr(exc_info.value, "http_status", None) == 403


def test_cross_user_thread_discard_route_returns_forbidden(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.infra.db import connection

    app.dependency_overrides[get_current_user_id] = _authenticated_user_id
    monkeypatch.setattr(connection, "get_pool", lambda: _ThreadPool())

    response = client.post(
        "/v1/threads/thread-owned-by-a/discard",
        json={"turnId": "turn-1"},
    )

    assert response.status_code == 403
