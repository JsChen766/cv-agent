"""Unit tests for the JD subgraph nodes."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.graphs.jd.nodes import jd_confirm_node, jd_persist_node, parse_requirements_node


# ── helpers ──────────────────────────────────────────────────────────────────


def _make_jd_record(jd_id: str = "jd-1", title: str = "Backend Engineer") -> Any:
    from app.domain.jd.models import JdRecord

    return JdRecord(
        id=jd_id,
        user_id="user-1",
        title=title,
        raw_text="Build APIs",
        requirements=[],
        source_thread_id=None,
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )


def _make_services(jd_record: Any) -> Any:
    from app.tools.base import ServiceContainer

    jd_service = MagicMock()
    jd_service.create_jd = AsyncMock(return_value=jd_record)
    return ServiceContainer.model_construct(
        experience=object(),
        jd=jd_service,
        resume=object(),
        artifact=object(),
        preference=object(),
        user=object(),
    )


# ── jd_confirm_node ───────────────────────────────────────────────────────────


async def test_jd_confirm_node_triggers_interrupt_and_returns_confirmed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resume_value = {"confirmed": True}
    monkeypatch.setattr("app.graphs.jd.nodes.interrupt", lambda payload: resume_value)

    state: dict[str, Any] = {
        "extracted_params": {
            "title": "Backend Engineer",
            "company": "Acme",
            "target_role": "Engineer",
            "raw_text": "Build APIs",
            "requirements": [
                {"id": "r-1", "text": "Python", "category": "skill", "importance": "high"}
            ],
        },
        "pending_sse_events": [],
    }

    result = await jd_confirm_node(state)

    assert result["_jd_confirmed"] is True
    assert result["_jd_candidate"]["title"] == "Backend Engineer"
    # interrupt SSE event appended
    events = result["pending_sse_events"]
    assert any(e.get("event") == "agent.interrupt" and e.get("type") == "jd_save" for e in events)


async def test_jd_confirm_node_triggers_interrupt_and_returns_discarded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resume_value = {"confirmed": False}
    monkeypatch.setattr("app.graphs.jd.nodes.interrupt", lambda payload: resume_value)

    state: dict[str, Any] = {
        "extracted_params": {
            "title": "Backend Engineer",
            "raw_text": "Build APIs",
            "requirements": [],
        },
        "pending_sse_events": [],
    }

    result = await jd_confirm_node(state)

    assert result["_jd_confirmed"] is False


async def test_jd_confirm_node_merges_candidate_override(monkeypatch: pytest.MonkeyPatch) -> None:
    resume_value = {"confirmed": True, "candidate": {"title": "Senior Backend Engineer"}}
    monkeypatch.setattr("app.graphs.jd.nodes.interrupt", lambda payload: resume_value)

    state: dict[str, Any] = {
        "extracted_params": {"title": "Backend Engineer", "raw_text": "x", "requirements": []},
        "pending_sse_events": [],
    }

    result = await jd_confirm_node(state)

    assert result["_jd_candidate"]["title"] == "Senior Backend Engineer"


# ── jd_persist_node ───────────────────────────────────────────────────────────


async def test_jd_persist_node_saves_when_confirmed() -> None:
    jd_record = _make_jd_record()
    services = _make_services(jd_record)
    config: dict[str, Any] = {"configurable": {"services": services}}

    state: dict[str, Any] = {
        "user_id": "user-1",
        "thread_id": "thread-abc",
        "_jd_confirmed": True,
        "_jd_candidate": {
            "title": "Backend Engineer",
            "company": "Acme",
            "target_role": None,
            "raw_text": "Build APIs",
            "requirements": [],
        },
        "extracted_params": {},
        "workspace": {},
        "pending_sse_events": [],
    }

    result = await jd_persist_node(state, config)

    services.jd.create_jd.assert_awaited_once()
    call_kwargs = services.jd.create_jd.call_args
    assert call_kwargs.kwargs["source_thread_id"] == "thread-abc"
    assert result["workspace"]["jd_id"] == "jd-1"
    assert "已加入 JD 匹配记录" in result["assistant_message"]
    events = result["pending_sse_events"]
    assert any(e.get("event") == "agent.completed" for e in events)


async def test_jd_persist_node_skips_db_when_discarded() -> None:
    jd_record = _make_jd_record()
    services = _make_services(jd_record)
    config: dict[str, Any] = {"configurable": {"services": services}}

    state: dict[str, Any] = {
        "user_id": "user-1",
        "thread_id": "thread-abc",
        "_jd_confirmed": False,
        "_jd_candidate": {"title": "x", "raw_text": "x", "requirements": []},
        "extracted_params": {},
        "workspace": {},
        "pending_sse_events": [],
    }

    result = await jd_persist_node(state, config)

    services.jd.create_jd.assert_not_awaited()
    assert "忽略" in result["assistant_message"]
    assert result.get("workspace", {}).get("jd_id") is None
