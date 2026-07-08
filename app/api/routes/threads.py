"""
Thread management routes.

GET    /threads                  — list threads
GET    /threads/:id              — thread detail + messages
PATCH  /threads/:id              — update title / status
POST   /threads/:id/resume       — resume after interrupt (user confirmed)
POST   /threads/:id/discard      — discard interrupt (user cancelled)
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import cast

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from langchain_core.runnables import RunnableConfig
from pydantic import Field, JsonValue

from app.api.deps import build_service_container, get_current_user_id, pool_dep
from app.api.response import ok, ok_list
from app.api.schemas import StrictRequestModel
from app.core.errors import ConflictError, ExternalServiceError, ForbiddenError, NotFoundError
from app.core.types import ThreadStatus

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/threads", tags=["threads"])


# ── Schemas ────────────────────────────────────────────────────────────────────


class UpdateThreadRequest(StrictRequestModel):
    title: str | None = Field(default=None, min_length=1)
    status: ThreadStatus | None = None


class ResumeRequest(StrictRequestModel):
    turnId: str = Field(min_length=1)
    confirmedData: dict[str, JsonValue] | None = None


class DiscardRequest(StrictRequestModel):
    turnId: str = Field(min_length=1)
    reason: str | None = Field(default=None, min_length=1)


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _require_thread(
    pool: asyncpg.Pool, thread_id: str, user_id: str
) -> dict[str, object]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM threads WHERE id = $1",
            thread_id,
        )
    if not row:
        raise NotFoundError(f"Thread '{thread_id}' not found")
    d = dict(row)
    if d.get("user_id") != user_id:
        raise ForbiddenError("You do not own this thread")
    return cast("dict[str, object]", d)


# ── Routes ─────────────────────────────────────────────────────────────────────


@router.get("")
async def list_threads(
    request: Request,
    limit: int = Query(20, ge=1, le=100),
    cursor: datetime | None = Query(None),
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool = Depends(pool_dep),
) -> JSONResponse:
    try:
        from app.infra.db.connection import get_pool as _get_pool
        _pool = _get_pool()
        params: list[object] = [user_id, limit + 1]
        query = "SELECT * FROM threads WHERE user_id = $1 AND status != 'deleted'"
        if cursor:
            query += " AND updated_at < $3"
            params.append(cursor)
        query += " ORDER BY updated_at DESC LIMIT $2"

        async with _pool.acquire() as conn:
            rows = await conn.fetch(query, *params)

        items = [dict(r) for r in rows[: limit]]
        next_cursor = None
        if len(rows) > limit:
            updated_at = rows[limit - 1]["updated_at"]
            next_cursor = (
                updated_at.isoformat()
                if isinstance(updated_at, datetime)
                else str(updated_at)
            )

        return ok_list(items, next_cursor, request)
    except RuntimeError:
        return ok_list([], None, request)


@router.get("/{thread_id}")
async def get_thread(
    thread_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool = Depends(pool_dep),
) -> JSONResponse:
    try:
        from app.infra.db.connection import get_pool as _get_pool
        _pool = _get_pool()
        thread = await _require_thread(_pool, thread_id, user_id)

        async with _pool.acquire() as conn:
            messages = await conn.fetch(
                "SELECT * FROM thread_messages WHERE thread_id = $1 ORDER BY created_at ASC",
                thread_id,
            )
        msg_list = [dict(m) for m in messages]
    except RuntimeError:
        thread = {"id": thread_id, "title": "Conversation", "status": "active"}
        msg_list = []

    return ok({"thread": thread, "messages": msg_list, "workspace": {}}, request)


@router.patch("/{thread_id}")
async def update_thread(
    thread_id: str,
    body: UpdateThreadRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool = Depends(pool_dep),
) -> JSONResponse:
    from app.infra.db.connection import get_pool as _get_pool
    _pool = _get_pool()
    await _require_thread(_pool, thread_id, user_id)

    updates: list[str] = []
    params: list[object] = []
    idx = 1

    if body.title is not None:
        updates.append(f"title = ${idx}")
        params.append(body.title)
        idx += 1
    if body.status is not None:
        updates.append(f"status = ${idx}")
        params.append(body.status)
        idx += 1

    if updates:
        updates.append(f"updated_at = ${idx}")
        params.append(datetime.now(UTC))
        idx += 1
        params.append(thread_id)
        query = f"UPDATE threads SET {', '.join(updates)} WHERE id = ${idx} RETURNING *"  # noqa: S608
        async with _pool.acquire() as conn:
            row = await conn.fetchrow(query, *params)
        if row is None:
            raise ExternalServiceError("Failed to update thread")
        return ok(dict(row), request)

    async with _pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM threads WHERE id = $1", thread_id)
    if row is None:
        raise NotFoundError(f"Thread '{thread_id}' not found")
    return ok(dict(row), request)


@router.post("/{thread_id}/resume")
async def resume_thread(
    thread_id: str,
    body: ResumeRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool = Depends(pool_dep),
) -> JSONResponse:
    """
    Resume a suspended graph after user confirmation.
    Invokes the graph with Command(resume=...) to continue from the interrupt.
    """
    from langgraph.types import Command

    from app.api.routes.copilot import _build_response
    from app.graphs.main import get_graph

    _pool = None
    try:
        from app.infra.db.connection import get_pool as _get_pool
        _pool = _get_pool()
        await _require_thread(_pool, thread_id, user_id)
    except RuntimeError:
        pass

    checkpointer = _get_checkpointer_or_none()
    if checkpointer is None:
        raise ConflictError("Thread has no persisted pending interrupt to resume")

    graph = get_graph(checkpointer)
    configurable: dict[str, object] = {"thread_id": thread_id}
    if _pool:
        configurable["services"] = build_service_container(_pool)
        configurable["pool"] = _pool
    config: RunnableConfig = {"configurable": configurable}

    resume_data = body.confirmedData or {"confirmed": True}

    try:
        snapshot = await graph.aget_state(config)
    except Exception as exc:
        logger.exception("Resume state load error: %s", exc)
        raise ExternalServiceError("Could not load thread resume state") from exc

    if not getattr(snapshot, "next", ()):
        raise ConflictError("Thread has no pending interrupt to resume")

    try:
        final_state = await graph.ainvoke(Command(resume=resume_data), config=config)
    except Exception as exc:
        logger.exception("Resume error: %s", exc)
        raise ExternalServiceError("Graph resume failed") from exc

    assistant_msg = str(final_state.get("assistant_message") or "Done.")
    raw_interrupt = final_state.get("interrupt_payload")
    interrupt_payload = (
        cast("dict[str, JsonValue]", raw_interrupt) if isinstance(raw_interrupt, dict) else None
    )

    return ok(
        _build_response(thread_id, body.turnId, assistant_msg, None, interrupt_payload),
        request,
    )


def _get_checkpointer_or_none() -> object | None:
    try:
        from app.infra.db.checkpointer import get_checkpointer

        return cast("object", get_checkpointer())
    except RuntimeError:
        return None


@router.post("/{thread_id}/discard")
async def discard_thread(
    thread_id: str,
    body: DiscardRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool = Depends(pool_dep),
) -> JSONResponse:
    """
    Discard a pending interrupt.  Optionally records rejection signal to PreferenceBank.
    """
    _pool = None
    try:
        from app.infra.db.connection import get_pool as _get_pool
        _pool = _get_pool()
        await _require_thread(_pool, thread_id, user_id)
    except RuntimeError:
        _pool = None

    if _pool is not None and body.reason:
        try:
            from app.domain.preference.service import PreferenceService
            from app.infra.db.repositories.preference_repo import PostgresPreferenceRepository

            pref_repo = PostgresPreferenceRepository(_pool)
            pref_svc = PreferenceService(pref_repo)

            await pref_svc.record_signal(
                user_id,
                signal_type="rejection",
                raw_content=body.reason,
                context={
                    "source": "interrupt_discard",
                    "thread_id": thread_id,
                    "turn_id": body.turnId,
                },
            )
        except Exception as exc:
            logger.warning("Discard signal recording failed: %s", exc)

    return ok(
        {
            "threadId": thread_id,
            "turnId": body.turnId,
            "status": "discarded",
        },
        request,
    )
