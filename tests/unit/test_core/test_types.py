"""Unit tests for core/types.py."""

from __future__ import annotations

from app.core.types import (
    ARTIFACT_PREFIX,
    EXP_PREFIX,
    JD_PREFIX,
    THREAD_PREFIX,
    USER_PREFIX,
    generate_id,
)


def test_generate_id_has_correct_prefix():
    for prefix in [USER_PREFIX, EXP_PREFIX, JD_PREFIX, THREAD_PREFIX, ARTIFACT_PREFIX]:
        id_ = generate_id(prefix)
        assert id_.startswith(prefix), f"Expected prefix {prefix}, got {id_}"


def test_generate_id_is_unique():
    ids = {generate_id(EXP_PREFIX) for _ in range(100)}
    assert len(ids) == 100


def test_generate_id_non_empty_suffix():
    id_ = generate_id("foo-")
    assert len(id_) > len("foo-")
