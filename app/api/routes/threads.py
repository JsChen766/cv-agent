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
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from app.api.deps import build_service_container, get_current_user_id, pool_dep
from app.api.response import ok, ok_list
from app.core.errors import ForbiddenError, NotFoundError

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/threads", tags=["threads"])


# ── Schemas ────────────────────────────────────────────────────────────────────


class UpdateThreadRequest(BaseModel):
    title: str | None = None
    status: str | None = None  # active | archived | deleted


class ResumeRequest(BaseModel):
    turnId: str
    confirmedData: dict[str, Any] | None = None  # optional override passed back to graph


class DiscardRequest(BaseModel):
    turnId: str
    reason: str | None = None


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _require_thread(pool, thread_id: str, user_id: str) -> dict[str, Any]:
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
    return d


# ── Routes ─────────────────────────────────────────────────────────────────────


@router.get("")
async def list_threads(
    request: Request,
    limit: int = 20,
    cursor: str | None = None,
    user_id: str = Depends(get_current_user_id),
    pool=Depends(pool_dep),
):
    try:
        from app.infra.db.connection import get_pool as _get_pool
        from app.infra.db.helpers import cursor_decode

        _pool = _get_pool()
        params: list[Any] = [user_id, limit + 1]
        query = "SELECT * FROM threads WHERE user_id = $1 AND status != 'deleted'"
        if cursor:
            cursor_val = cursor_decode(cursor)
            query += " AND updated_at < $3"
            params.append(cursor_val)
        query += " ORDER BY updated_at DESC LIMIT $2"

        async with _pool.acquire() as conn:
            rows = await conn.fetch(query, *params)

        items = [dict(r) for r in rows[: limit]]
        next_cursor = None
        if len(rows) > limit:
            from app.infra.db.helpers import cursor_encode
            next_cursor = cursor_encode(str(rows[limit - 1]["updated_at"]))

        return ok_list(items, next_cursor, request)
    except RuntimeError:
        return ok_list([], None, request)


@router.get("/{thread_id}")
async def get_thread(
    thread_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool=Depends(pool_dep),
):
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
    pool=Depends(pool_dep),
):
    from app.infra.db.connection import get_pool as _get_pool
    _pool = _get_pool()
    await _require_thread(_pool, thread_id, user_id)

    updates: list[str] = []
    params: list[Any] = []
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
        return ok(dict(row), request)

    async with _pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM threads WHERE id = $1", thread_id)
    return ok(dict(row), request)


@router.post("/{thread_id}/resume")
async def resume_thread(
    thread_id: str,
    body: ResumeRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool=Depends(pool_dep),
):
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

    graph = get_graph(_get_checkpointer_or_none())
    configurable: dict[str, Any] = {"thread_id": thread_id}
    if _pool:
        configurable["services"] = build_service_container(_pool)
        configurable["pool"] = _pool
    config = {"configurable": configurable}

    resume_data = body.confirmedData or {"confirmed": True}

    try:
        final_state = await graph.ainvoke(Command(resume=resume_data), config=config)
        assistant_msg = final_state.get("assistant_message", "Done.")
        interrupt_payload = final_state.get("interrupt_payload")
    except Exception as exc:
        logger.exception("Resume error: %s", exc)
        assistant_msg = "An error occurred resuming the conversation."
        interrupt_payload = None

    return ok(
        _build_response(thread_id, body.turnId, assistant_msg, None, interrupt_payload),
        request,
    )


def _get_checkpointer_or_none():
    try:
        from app.infra.db.checkpointer import get_checkpointer

        return get_checkpointer()
    except RuntimeError:
        return None


@router.post("/{thread_id}/discard")
async def discard_thread(
    thread_id: str,
    body: DiscardRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool=Depends(pool_dep),
):
    """
    Discard a pending interrupt.  Optionally records rejection signal to PreferenceBank.
    """
    try:
        from app.infra.db.connection import get_pool as _get_pool
        _pool = _get_pool()
        await _require_thread(_pool, thread_id, user_id)

        if body.reason:
            # Record rejection signal for preference learning
            from app.domain.preference.service import PreferenceService
            from app.infra.db.repositories.preference_repo import PostgresPreferenceRepository
            from app.providers.factory import get_embedding_provider

            pref_repo = PostgresPreferenceRepository(_pool)
            pref_svc = PreferenceService(pref_repo)
            embed_provider = get_embedding_provider()
            embedding = await embed_provider.embed(body.reason)

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
