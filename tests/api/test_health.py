"""API-level tests using FastAPI TestClient (no database required)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app, raise_server_exceptions=False)


def test_health_returns_ok():
    resp = client.get("/v1/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "version" in data


def test_unauthenticated_me_returns_401():
    resp = client.get("/v1/users/me")
    assert resp.status_code == 401


def test_unauthenticated_chat_returns_401():
    resp = client.post("/v1/copilot/chat", json={"message": "hello"})
    assert resp.status_code == 401


def test_unauthenticated_threads_returns_401():
    resp = client.get("/v1/threads")
    assert resp.status_code == 401


def test_unauthenticated_experiences_returns_401():
    resp = client.get("/v1/product/experiences")
    assert resp.status_code == 401


def test_register_without_db_returns_502():
    """Without a DB pool, register returns 502 (DB unavailable)."""
    resp = client.post(
        "/v1/auth/register",
        json={"email": "test@example.com", "password": "secret123"},
    )
    # No DB in test env — expect 502 External Service Error
    assert resp.status_code == 502


def test_login_without_db_returns_502():
    resp = client.post(
        "/v1/auth/login",
        json={"email": "test@example.com", "password": "secret123"},
    )
    assert resp.status_code == 502
