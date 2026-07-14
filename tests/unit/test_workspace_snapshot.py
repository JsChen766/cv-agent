"""Unit tests for Phase 1 — workspace snapshot persistence and three-way merge."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.tools.base import ServiceContainer


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_jd(jd_id: str = "jd-1") -> SimpleNamespace:
    return SimpleNamespace(id=jd_id, raw_text="Python backend role", title="Backend Engineer")


def _make_resume(resume_id: str = "resume-1") -> SimpleNamespace:
    return SimpleNamespace(id=resume_id, title="AI Generated Resume")


def _make_services(
    *,
    jd_id: str = "jd-1",
    resume_id: str = "resume-1",
    jd_raw_text: str = "Python backend role",
) -> ServiceContainer:
    jd = SimpleNamespace(id=jd_id, raw_text=jd_raw_text, title="Backend Engineer")
    resume = SimpleNamespace(id=resume_id, title="AI Generated Resume")
    return ServiceContainer.model_construct(
        jd=SimpleNamespace(
            get_jd=AsyncMock(return_value=jd),
            create_or_update_from_raw_text=AsyncMock(return_value=jd),
        ),
        resume=SimpleNamespace(
            create_resume=AsyncMock(return_value=resume),
            get_resume=AsyncMock(return_value=resume),
            save_variant=AsyncMock(
                return_value=SimpleNamespace(
                    id="variant-1",
                    model_dump=lambda mode=None: {"id": "variant-1"},
                )
            ),
        ),
        experience=MagicMock(),
        artifact=MagicMock(),
        preference=MagicMock(),
        user=MagicMock(),
    )


# ── _merged_workspace tests ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_merged_workspace_no_pool_falls_back_to_client_state() -> None:
    """Without a pool, _merged_workspace must still return client state."""
    from app.api.routes.copilot import ClientState, _merged_workspace

    cs = ClientState(activeJdId="jd-42")
    result = await _merged_workspace(cs, "user-1", "thread-1", pool=None)
    assert result["jd_id"] == "jd-42"


@pytest.mark.asyncio
async def test_merged_workspace_never_drops_snapshot_key_when_client_is_silent() -> None:
    """
    Turn 1 builds resume-1 → snapshot has resume_id=resume-1.
    Turn 2 client sends no activeResumeId → workspace must still contain resume-1.
    """
    from app.api.routes.copilot import ClientState, _merged_workspace
    from app.infra.db.repositories.thread_repo import PostgresThreadRepository

    mock_pool = MagicMock()
    snapshot = {"resume_id": "resume-1", "jd_id": "jd-1"}

    with patch.object(
        PostgresThreadRepository, "get_workspace_snapshot", AsyncMock(return_value=snapshot)
    ):
        # build_workspace validates ids — patch it to pass through client_ws unchanged
        with patch(
            "app.api.copilot.workspace_builder.build_workspace",
            AsyncMock(return_value={}),  # client sends nothing
        ):
            cs = ClientState()  # no activeResumeId, no activeJdId
            result = await _merged_workspace(cs, "user-1", "thread-1", pool=mock_pool)

    assert result["resume_id"] == "resume-1"
    assert result["jd_id"] == "jd-1"


@pytest.mark.asyncio
async def test_merged_workspace_client_override_wins_over_snapshot() -> None:
    """Client explicitly sends a new activeResumeId → it overrides snapshot."""
    from app.api.routes.copilot import ClientState, _merged_workspace
    from app.infra.db.repositories.thread_repo import PostgresThreadRepository

    mock_pool = MagicMock()
    snapshot = {"resume_id": "resume-old"}

    with patch.object(
        PostgresThreadRepository, "get_workspace_snapshot", AsyncMock(return_value=snapshot)
    ):
        with patch(
            "app.api.copilot.workspace_builder.build_workspace",
            AsyncMock(return_value={"resume_id": "resume-new"}),
        ):
            cs = ClientState(activeResumeId="resume-new")
            result = await _merged_workspace(cs, "user-1", "thread-1", pool=mock_pool)

    assert result["resume_id"] == "resume-new"


@pytest.mark.asyncio
async def test_merged_workspace_snapshot_failure_is_non_fatal() -> None:
    """If snapshot read fails, fall back to client_state only (don't crash)."""
    from app.api.routes.copilot import ClientState, _merged_workspace
    from app.infra.db.repositories.thread_repo import PostgresThreadRepository

    mock_pool = MagicMock()

    with patch.object(
        PostgresThreadRepository,
        "get_workspace_snapshot",
        AsyncMock(side_effect=RuntimeError("db down")),
    ):
        with patch(
            "app.api.copilot.workspace_builder.build_workspace",
            AsyncMock(return_value={"jd_id": "jd-1"}),
        ):
            cs = ClientState(activeJdId="jd-1")
            result = await _merged_workspace(cs, "user-1", "thread-1", pool=mock_pool)

    assert result["jd_id"] == "jd-1"


# ── persist_resume_draft_node tests ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_persist_resume_draft_promotes_raw_jd_text_to_jd_records() -> None:
    """
    Turn 1: raw_jd_text present, workspace.jd_id absent.
    persist_resume_draft_node must create a JD record and write jd_id to snapshot.
    """
    from app.graphs.resume.nodes import persist_resume_draft_node

    services = _make_services(jd_id="jd-created")
    mock_thread_repo = MagicMock()
    mock_thread_repo.update_workspace_snapshot = AsyncMock()

    state: dict[str, object] = {
        "user_id": "user-1",
        "thread_id": "thread-1",
        "workspace": {},  # no jd_id
        "extracted_params": {"raw_jd_text": "Python backend role description"},
        "variants": [],
    }
    # Pass mock thread_repo directly in configurable — mirrors how production wires it
    config = {"configurable": {"services": services, "thread_repo": mock_thread_repo}}

    result = await persist_resume_draft_node(state, config)

    # JD should have been created
    services.jd.create_or_update_from_raw_text.assert_awaited_once()
    # workspace should carry the new jd_id
    assert result["workspace"]["jd_id"] == "jd-created"
    # snapshot must be updated
    mock_thread_repo.update_workspace_snapshot.assert_awaited_once()
    snapshot_delta = mock_thread_repo.update_workspace_snapshot.call_args.args[1]
    assert snapshot_delta.get("jd_id") == "jd-created"


@pytest.mark.asyncio
async def test_persist_resume_draft_writes_resume_id_to_snapshot() -> None:
    """When resume is newly created, resume_id must be persisted to snapshot."""
    from app.graphs.resume.nodes import persist_resume_draft_node

    services = _make_services(resume_id="resume-new")
    mock_thread_repo = MagicMock()
    mock_thread_repo.update_workspace_snapshot = AsyncMock()

    state: dict[str, object] = {
        "user_id": "user-1",
        "thread_id": "thread-1",
        "workspace": {"jd_id": "jd-1"},  # no resume_id
        "extracted_params": {},
        "variants": [],
    }
    config = {"configurable": {"services": services, "thread_repo": mock_thread_repo}}

    result = await persist_resume_draft_node(state, config)

    assert result["workspace"]["resume_id"] == "resume-new"
    snapshot_delta = mock_thread_repo.update_workspace_snapshot.call_args.args[1]
    assert snapshot_delta.get("resume_id") == "resume-new"


@pytest.mark.asyncio
async def test_persist_resume_draft_does_not_promote_raw_jd_when_jd_id_exists() -> None:
    """If workspace already has jd_id, skip creating a new JD record."""
    from app.graphs.resume.nodes import persist_resume_draft_node

    services = _make_services()
    mock_thread_repo = MagicMock()
    mock_thread_repo.update_workspace_snapshot = AsyncMock()

    state: dict[str, object] = {
        "user_id": "user-1",
        "thread_id": "thread-1",
        "workspace": {"jd_id": "jd-existing"},
        "extracted_params": {"raw_jd_text": "Some raw JD"},
        "variants": [],
    }
    config = {"configurable": {"services": services, "thread_repo": mock_thread_repo}}

    await persist_resume_draft_node(state, config)

    services.jd.create_or_update_from_raw_text.assert_not_awaited()


# ── PostgresThreadRepository unit tests ───────────────────────────────────────


@pytest.mark.asyncio
async def test_thread_repo_get_workspace_snapshot_returns_empty_dict_for_unknown_thread() -> None:
    from app.infra.db.repositories.thread_repo import PostgresThreadRepository

    mock_pool = MagicMock()
    mock_conn = AsyncMock()
    mock_conn.fetchrow = AsyncMock(return_value=None)
    mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

    repo = PostgresThreadRepository(mock_pool)
    result = await repo.get_workspace_snapshot("nonexistent-thread")
    assert result == {}


@pytest.mark.asyncio
async def test_thread_repo_update_workspace_snapshot_executes_merge_sql() -> None:
    from app.infra.db.repositories.thread_repo import PostgresThreadRepository

    mock_pool = MagicMock()
    mock_conn = AsyncMock()
    mock_conn.execute = AsyncMock()
    mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

    repo = PostgresThreadRepository(mock_pool)
    await repo.update_workspace_snapshot("thread-1", {"resume_id": "resume-1"})

    mock_conn.execute.assert_awaited_once()
    sql_arg = mock_conn.execute.call_args.args[0]
    assert "||" in sql_arg  # JSONB concatenation operator
    # delta is passed as a plain dict (not json.dumps) — codec handles serialization
    delta_arg = mock_conn.execute.call_args.args[1]
    assert delta_arg == {"resume_id": "resume-1"}
