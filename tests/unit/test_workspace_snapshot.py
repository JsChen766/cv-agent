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


def _single_variant() -> list[dict[str, object]]:
    return [{"id": "draft-1", "title": "Draft", "content": "# Resume"}]


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

    # build_workspace validates ids — patch it to pass through client_ws unchanged
    with (
        patch.object(
            PostgresThreadRepository,
            "get_workspace_snapshot",
            AsyncMock(return_value=snapshot),
        ),
        patch(
            "app.api.copilot.workspace_builder.build_workspace",
            AsyncMock(return_value={}),  # client sends nothing
        ),
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

    with (
        patch.object(
            PostgresThreadRepository, "get_workspace_snapshot", AsyncMock(return_value=snapshot)
        ),
        patch(
            "app.api.copilot.workspace_builder.build_workspace",
            AsyncMock(return_value={"resume_id": "resume-new"}),
        ),
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

    with (
        patch.object(
            PostgresThreadRepository,
            "get_workspace_snapshot",
            AsyncMock(side_effect=RuntimeError("db down")),
        ),
        patch(
            "app.api.copilot.workspace_builder.build_workspace",
            AsyncMock(return_value={"jd_id": "jd-1"}),
        ),
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
        "variants": _single_variant(),
        "quality_status": "passed",
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
        "variants": _single_variant(),
        "quality_status": "passed",
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
        "variants": _single_variant(),
        "quality_status": "passed",
    }
    config = {"configurable": {"services": services, "thread_repo": mock_thread_repo}}

    await persist_resume_draft_node(state, config)

    services.jd.create_or_update_from_raw_text.assert_not_awaited()


@pytest.mark.asyncio
async def test_persist_resume_draft_rejects_multiple_variants() -> None:
    from app.graphs.resume.nodes import persist_resume_draft_node

    services = _make_services()
    state: dict[str, object] = {
        "user_id": "user-1",
        "workspace": {"resume_id": "resume-1", "jd_id": "jd-1"},
        "quality_status": "passed",
        "variants": [*_single_variant(), {"id": "draft-2", "content": "# Other"}],
    }

    with pytest.raises(RuntimeError, match="one resume variant"):
        await persist_resume_draft_node(state, {"configurable": {"services": services}})

    services.resume.save_variant.assert_not_awaited()


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


# ── Router raw_jd_text extraction tests ──────────────────────────────────────


def test_heuristic_route_extracts_raw_jd_text_for_short_jd_resume_generation() -> None:
    """Short JD (<300 chars) routed to resume_generation must still set raw_jd_text.

    Regression for: short JDs never got their raw_jd_text captured, so jd_id
    was never promoted to jd_records and never written to the workspace snapshot.
    """
    from app.graphs.router import _heuristic_route

    short_jd_msg = (
        "请帮我生成简历。以下是JD: "
        "Python后端工程师，要求3年以上经验，熟悉FastAPI/Django，"
        "掌握PostgreSQL/Redis，有微服务经验优先。"
    )
    assert len(short_jd_msg) >= 80  # ensure fixture is in the right range

    result = _heuristic_route(short_jd_msg, {}, has_active_jd=False)

    assert result is not None
    assert "raw_jd_text" in result.extracted_params
    assert result.extracted_params["raw_jd_text"] == short_jd_msg


def test_heuristic_route_does_not_extract_raw_jd_text_when_jd_already_active() -> None:
    """When jd_id is in workspace, skip raw_jd_text extraction."""
    from app.graphs.router import _heuristic_route

    short_jd_msg = "根据以下岗位帮我生成简历: Python后端3年+，FastAPI，PostgreSQL，微服务经验。"

    result = _heuristic_route(short_jd_msg, {}, has_active_jd=True)

    assert result is not None
    assert "raw_jd_text" not in result.extracted_params


def test_heuristic_route_does_not_extract_raw_jd_text_for_very_short_messages() -> None:
    """Very short messages (<80 chars) without real JD content skip extraction."""
    from app.graphs.router import _heuristic_route

    short_msg = "帮我优化一下职位描述那部分简历"
    assert len(short_msg) < 80

    result = _heuristic_route(short_msg, {}, has_active_jd=False)

    # Either no match or matched but without raw_jd_text
    if result is not None and result.target_subgraph in {
        "resume_generation",
        "application_package",
    }:
        assert "raw_jd_text" not in result.extracted_params


# ── Router P2b: experience QA heuristic tests ────────────────────────────────


def test_heuristic_route_experience_qa_chinese_terms_route_to_open_ended() -> None:
    """Common Chinese experience-QA phrases must route to open_ended."""
    from app.graphs.router import _heuristic_route

    cases = [
        "根据我的经历帮我分析一下",
        "从我的经历来看我适合哪些岗位",
        "基于我的经历写一段介绍",
        "我的背景适合做产品经理吗",
        "我有哪些经历",
        "我的经历有哪些",
        "经历库里有什么",
        "我的工作经历是什么",
        "我的项目经历有哪些",
    ]
    for msg in cases:
        result = _heuristic_route(msg, {}, has_active_jd=False)
        assert result is not None, f"Expected a route for: {msg!r}"
        assert result.target_subgraph == "open_ended", (
            f"Expected open_ended for {msg!r}, got {result.target_subgraph!r}"
        )


def test_heuristic_route_experience_qa_english_terms_route_to_open_ended() -> None:
    """English experience-QA phrases must also route to open_ended."""
    from app.graphs.router import _heuristic_route

    cases = [
        "analyse my experience and suggest roles",
        "analyze my experience please",
        "based on my experience what jobs fit",
        "from my experience library what do I have",
    ]
    for msg in cases:
        result = _heuristic_route(msg, {}, has_active_jd=False)
        assert result is not None, f"Expected a route for: {msg!r}"
        assert result.target_subgraph == "open_ended", (
            f"Expected open_ended for {msg!r}, got {result.target_subgraph!r}"
        )


def test_heuristic_route_experience_qa_has_correct_context_hints() -> None:
    """Experience-QA route must include experiences and active_jd in context_hints."""
    from app.graphs.router import _heuristic_route

    result = _heuristic_route("根据我的经历推荐一下岗位", {}, has_active_jd=False)

    assert result is not None
    assert "experiences" in result.context_hints
    assert "active_jd" in result.context_hints


def test_heuristic_route_experience_qa_confidence_is_high() -> None:
    """Experience-QA route confidence must be >= 0.9."""
    from app.graphs.router import _heuristic_route

    result = _heuristic_route("我有哪些经历", {}, has_active_jd=False)

    assert result is not None
    assert result.confidence >= 0.9


def test_heuristic_route_save_intent_beats_experience_qa_terms() -> None:
    """When user asks to SAVE experience, route to experience_import — not open_ended.

    save-intent check runs before experience_qa_terms, so this must not regress.
    """
    from app.graphs.router import _heuristic_route

    msg = "帮我保存我的工作经历：2022年在字节跳动担任后端工程师，负责推荐系统开发。"
    result = _heuristic_route(msg, {}, has_active_jd=False)

    assert result is not None
    assert result.target_subgraph == "experience_import", (
        f"Expected experience_import, got {result.target_subgraph!r}"
    )


def test_heuristic_route_experience_qa_does_not_match_plain_experience_word() -> None:
    """Bare '经历' without qualifying prefix should not trigger experience_qa route.

    These messages should either match resume heuristic or fall through to LLM.
    """
    from app.graphs.router import _heuristic_route

    # A resume-generation request that happens to mention "经历" — should not be
    # hijacked by the experience_qa heuristic
    msg = "帮我生成一份简历，突出我的项目经历"
    result = _heuristic_route(msg, {}, has_active_jd=False)

    assert result is not None
    # Should be routed to resume_generation/application_package, NOT open_ended
    assert result.target_subgraph in {"resume_generation", "application_package"}, (
        f"Expected resume route, got {result.target_subgraph!r}"
    )
