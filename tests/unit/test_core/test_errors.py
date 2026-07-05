"""Unit tests for core/errors.py."""

from __future__ import annotations

from app.core.errors import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
    ValidationError,
)


def test_not_found_error_status():
    err = NotFoundError("thing not found")
    assert err.http_status == 404
    assert err.retryable is False


def test_unauthorized_error_status():
    err = UnauthorizedError()
    assert err.http_status == 401


def test_forbidden_error_status():
    err = ForbiddenError()
    assert err.http_status == 403


def test_conflict_error_status():
    err = ConflictError("already exists")
    assert err.http_status == 409


def test_to_dict_contains_required_keys():
    err = NotFoundError("thing not found")
    d = err.to_dict()
    assert "code" in d
    assert "message" in d
    assert "retryable" in d


def test_validation_error_status():
    err = ValidationError("bad input")
    assert err.http_status == 422
