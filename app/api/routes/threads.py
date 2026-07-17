"""
Thread management routes.

GET    /threads                  — list threads
GET    /threads/:id              — thread detail + messages
PATCH  /threads/:id              — update title / status
POST   /threads/:id/resume       — resume after interrupt (user confirmed)
POST   /threads/:id/discard      — discard interrupt (user cancelled)
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import cast

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from langchain_core.runnables import RunnableConfig
from pydantic import Field, JsonValue, model_validator

from app.api.deps import build_service_container, get_current_user_id, pool_dep
from app.api.interrupts import PendingInterrupt, pending_interrupt_from_snapshot
from app.api.response import ok, ok_list
from app.api.schemas import StrictRequestModel
from app.core.errors import (
    ConflictError,
    ExternalServiceError,
    ForbiddenError,
    NotFoundError,
    ValidationError,
)
from app.core.types import ThreadStatus
from app.domain.resume.models import ResumeItemPatch, ResumeVariantPatch

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/threads", tags=["threads"])


# ── Schemas ────────────────────────────────────────────────────────────────────


class UpdateThreadRequest(StrictRequestModel):
    title: str | None = Field(default=None, min_length=1)
    status: ThreadStatus | None = None


class ResumeRequest(StrictRequestModel):
    turnId: str = Field(min_length=1)
    interruptId: str | None = Field(default=None, min_length=1)
    confirmedData: dict[str, JsonValue] | None = None


class DiscardRequest(StrictRequestModel):
    turnId: str = Field(min_length=1)
    interruptId: str | None = Field(default=None, min_length=1)
    reason: str | None = Field(default=None, min_length=1)


class SaveResumeCanvasRequest(StrictRequestModel):
    selectedVariantId: str = Field(min_length=1)
    structured: dict[str, JsonValue] | None = None
    content: str | None = Field(default=None, min_length=1)
    title: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def require_resume_source(self) -> SaveResumeCanvasRequest:
        if self.structured is None and self.content is None:
            raise ValueError("Either structured or content is required")
        return self


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _require_thread(pool: asyncpg.Pool, thread_id: str, user_id: str) -> dict[str, object]:
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


def _decode_metadata(raw_metadata: object) -> dict[str, object]:
    if isinstance(raw_metadata, dict):
        return dict(raw_metadata)
    if isinstance(raw_metadata, str):
        import json

        try:
            decoded = json.loads(raw_metadata)
        except Exception:
            return {}
        return decoded if isinstance(decoded, dict) else {}
    return {}


def _resume_canvas_references(metadata: dict[str, object]) -> tuple[set[str], str | None]:
    presentation = metadata.get("presentation")
    if not isinstance(presentation, dict) or presentation.get("type") != "resume_canvas":
        return set(), None
    raw_variant_ids = presentation.get("variant_ids")
    variant_ids = (
        {value for value in raw_variant_ids if isinstance(value, str)}
        if isinstance(raw_variant_ids, list)
        else set()
    )
    variants = presentation.get("variants")
    if isinstance(variants, list):
        variant_ids.update(
            variant["id"]
            for variant in variants
            if isinstance(variant, dict) and isinstance(variant.get("id"), str)
        )
    resume_item_id = presentation.get("resume_item_id")
    return variant_ids, resume_item_id if isinstance(resume_item_id, str) else None


def _hydrate_resume_canvas_resume_id(
    metadata: dict[str, object],
    *,
    variant_resume_ids: dict[str, str],
    item_resume_ids: dict[str, str],
) -> str | None:
    """Recover a historical canvas's resume ID from durable product records."""
    presentation = metadata.get("presentation")
    if not isinstance(presentation, dict) or presentation.get("type") != "resume_canvas":
        return None
    existing = presentation.get("resume_id")
    if isinstance(existing, str) and existing:
        return existing

    variant_ids, resume_item_id = _resume_canvas_references(metadata)
    candidates = {
        variant_resume_ids[variant_id]
        for variant_id in variant_ids
        if variant_id in variant_resume_ids
    }
    if resume_item_id in item_resume_ids:
        candidates.add(item_resume_ids[resume_item_id])
    if len(candidates) != 1:
        return None

    resume_id = next(iter(candidates))
    presentation["resume_id"] = resume_id
    return resume_id


def _pending_interrupt_or_conflict(
    snapshot: object | None,
    *,
    turn_id: str,
    interrupt_id: str | None,
) -> PendingInterrupt:
    pending = pending_interrupt_from_snapshot(snapshot)
    if pending is None:
        raise ConflictError("Thread has no pending interrupt", code="no_pending_interrupt")
    if pending.turn_id != turn_id:
        raise ConflictError(
            "This confirmation belongs to an older turn",
            code="stale_interrupt_operation",
        )
    if interrupt_id is not None and pending.interrupt_id != interrupt_id:
        raise ConflictError(
            "This confirmation belongs to an older interrupt",
            code="stale_interrupt_operation",
        )
    if pending.interrupt_id is None:
        raise ConflictError(
            "Pending interrupt has no stable identifier", code="invalid_pending_interrupt"
        )
    return pending


async def _completed_interrupt_operation(
    pool: asyncpg.Pool | None,
    *,
    thread_id: str,
    turn_id: str,
    action: str,
) -> dict[str, JsonValue] | None:
    if pool is None:
        return None
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT response FROM thread_interrupt_operations "
            "WHERE thread_id = $1 AND turn_id = $2 AND action = $3 AND status = 'completed' "
            "ORDER BY completed_at DESC LIMIT 1",
            thread_id,
            turn_id,
            action,
        )
    if row is None:
        return None
    response = _decode_metadata(row["response"])
    return cast("dict[str, JsonValue]", response) if response else None


async def _claim_interrupt_operation(
    pool: asyncpg.Pool | None,
    *,
    thread_id: str,
    turn_id: str,
    interrupt_id: str,
    action: str,
) -> dict[str, JsonValue] | None:
    """Claim the thread operation once; completed retries return their first response."""
    if pool is None:
        return None
    async with pool.acquire() as conn:
        inserted = await conn.fetchrow(
            "INSERT INTO thread_interrupt_operations "
            "(thread_id, turn_id, interrupt_id, action, status) "
            "VALUES ($1, $2, $3, $4, 'in_progress') "
            "ON CONFLICT DO NOTHING RETURNING thread_id",
            thread_id,
            turn_id,
            interrupt_id,
            action,
        )
        if inserted is not None:
            return None
        row = await conn.fetchrow(
            "SELECT status, response FROM thread_interrupt_operations "
            "WHERE thread_id = $1 AND turn_id = $2 AND interrupt_id = $3 AND action = $4",
            thread_id,
            turn_id,
            interrupt_id,
            action,
        )
        if row is not None and row["status"] == "completed":
            response = _decode_metadata(row["response"])
            return cast("dict[str, JsonValue]", response)
    raise ConflictError(
        "An interrupt operation is already in progress for this thread; retry shortly",
        code="interrupt_operation_in_progress",
        retryable=True,
    )


async def _complete_interrupt_operation(
    pool: asyncpg.Pool | None,
    *,
    thread_id: str,
    turn_id: str,
    interrupt_id: str,
    action: str,
    response: dict[str, JsonValue],
) -> None:
    if pool is None:
        return
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE thread_interrupt_operations "
            "SET status = 'completed', response = $5::jsonb, completed_at = NOW() "
            "WHERE thread_id = $1 AND turn_id = $2 AND interrupt_id = $3 AND action = $4",
            thread_id,
            turn_id,
            interrupt_id,
            action,
            json.dumps(response),
        )


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

        items = [dict(r) for r in rows[:limit]]
        next_cursor = None
        if len(rows) > limit:
            updated_at = rows[limit - 1]["updated_at"]
            next_cursor = (
                updated_at.isoformat() if isinstance(updated_at, datetime) else str(updated_at)
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
        raw_thread = await _require_thread(_pool, thread_id, user_id)

        async with _pool.acquire() as conn:
            msg_rows = await conn.fetch(
                "SELECT id, role, content, metadata, created_at FROM thread_messages "
                "WHERE thread_id = $1 ORDER BY created_at ASC",
                thread_id,
            )
            canvas_variant_ids: set[str] = set()
            canvas_item_ids: set[str] = set()
            for message_row in msg_rows:
                variant_ids, resume_item_id = _resume_canvas_references(
                    _decode_metadata(message_row["metadata"])
                )
                canvas_variant_ids.update(variant_ids)
                if resume_item_id:
                    canvas_item_ids.add(resume_item_id)
            variant_resume_rows = (
                await conn.fetch(
                    "SELECT id, resume_id FROM resume_variants WHERE id = ANY($1::text[])",
                    list(canvas_variant_ids),
                )
                if canvas_variant_ids
                else []
            )
            item_resume_rows = (
                await conn.fetch(
                    "SELECT id, resume_id FROM resume_items WHERE id = ANY($1::text[])",
                    list(canvas_item_ids),
                )
                if canvas_item_ids
                else []
            )
            variant_resume_ids = {
                str(row["id"]): str(row["resume_id"]) for row in variant_resume_rows
            }
            item_resume_ids = {str(row["id"]): str(row["resume_id"]) for row in item_resume_rows}
            # Recover workspace: latest artifact, latest JD linked to this thread,
            # latest resume linked to this thread.
            artifact_row = await conn.fetchrow(
                "SELECT id, type, title FROM artifacts WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1",
                thread_id,
            )
            jd_row = await conn.fetchrow(
                "SELECT id FROM jd_records WHERE source_thread_id = $1 ORDER BY created_at DESC LIMIT 1",
                thread_id,
            )

    except RuntimeError:
        raw_thread = {"id": thread_id, "title": "Conversation", "status": "active"}
        msg_rows = []
        artifact_row = None
        jd_row = None
        variant_resume_ids = {}
        item_resume_ids = {}

    # Normalise thread fields to camelCase for frontend.
    created_at = raw_thread.get("created_at")
    updated_at = raw_thread.get("updated_at")
    thread_out = {
        "id": raw_thread.get("id"),
        "title": raw_thread.get("title"),
        "status": raw_thread.get("status"),
        "createdAt": created_at.isoformat()
        if isinstance(created_at, datetime)
        else str(created_at or ""),
        "updatedAt": updated_at.isoformat()
        if isinstance(updated_at, datetime)
        else str(updated_at or ""),
    }

    # Normalise messages.
    messages_out = []
    latest_resume_id: str | None = None
    for row in msg_rows:
        msg_created = row["created_at"]
        meta = _decode_metadata(row["metadata"])
        canvas_resume_id = _hydrate_resume_canvas_resume_id(
            meta,
            variant_resume_ids=variant_resume_ids,
            item_resume_ids=item_resume_ids,
        )
        if canvas_resume_id:
            latest_resume_id = canvas_resume_id
        turn_id = meta.get("turn_id")
        messages_out.append(
            {
                "id": row["id"],
                "role": row["role"],
                "content": row["content"],
                "metadata": meta,
                "turnId": turn_id,
                "createdAt": msg_created.isoformat()
                if isinstance(msg_created, datetime)
                else str(msg_created or ""),
            }
        )

    # Build workspace from DB relationships.
    workspace: dict[str, object] = {}
    if artifact_row:
        workspace["artifact_id"] = artifact_row["id"]
        workspace["artifact_type"] = artifact_row["type"]
        workspace["artifact_title"] = artifact_row["title"]
    if jd_row:
        workspace["jd_id"] = jd_row["id"]
    if latest_resume_id:
        workspace["resume_id"] = latest_resume_id

    # Try to recover pending interrupt from the graph checkpointer.
    interrupt_payload = None
    checkpointer = _get_checkpointer_or_none()
    if checkpointer is not None:
        from app.graphs.main import get_graph

        graph = get_graph(checkpointer)
        cfg: RunnableConfig = {"configurable": {"thread_id": thread_id}}
        try:
            snapshot = await graph.aget_state(cfg)
            from app.api.interrupts import pending_interrupt_from_snapshot

            pending = pending_interrupt_from_snapshot(snapshot)
            if pending is not None:
                interrupt_payload = pending.payload
        except Exception:
            pass

    return ok(
        {
            "thread": thread_out,
            "messages": messages_out,
            "workspace": workspace,
            "interrupt": interrupt_payload,
        },
        request,
    )


@router.patch("/{thread_id}/messages/{message_id}/resume-canvas")
async def save_resume_canvas(
    thread_id: str,
    message_id: str,
    body: SaveResumeCanvasRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool | None = Depends(pool_dep),
) -> JSONResponse:
    """Persist an edited resume canvas without changing its place in the chat timeline."""
    import json

    if pool is None:
        raise ExternalServiceError("Database unavailable")
    checked_pool = pool
    await _require_thread(checked_pool, thread_id, user_id)
    async with checked_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT metadata FROM thread_messages WHERE id = $1 AND thread_id = $2",
            message_id,
            thread_id,
        )
    if row is None:
        raise NotFoundError(f"Message '{message_id}' not found")

    metadata = _decode_metadata(row["metadata"])
    presentation = metadata.get("presentation")
    if not isinstance(presentation, dict) or presentation.get("type") != "resume_canvas":
        raise NotFoundError(f"Resume canvas '{message_id}' not found")
    variants = presentation.get("variants")
    if not isinstance(variants, list):
        raise NotFoundError(f"Resume canvas '{message_id}' has no editable variants")
    variant = next(
        (
            item
            for item in variants
            if isinstance(item, dict) and item.get("id") == body.selectedVariantId
        ),
        None,
    )
    if not isinstance(variant, dict):
        raise NotFoundError(f"Resume variant '{body.selectedVariantId}' is not in this canvas")

    services = build_service_container(checked_pool)
    try:
        if body.structured is not None:
            updated_variant = await services.resume.save_variant_structure(
                user_id,
                body.selectedVariantId,
                dict(body.structured),
                title=body.title,
            )
        else:
            # Compatibility path for clients released before structured canvas saves.
            updated_variant = await services.resume.update_variant(
                user_id,
                body.selectedVariantId,
                ResumeVariantPatch(title=body.title, content=body.content),
            )
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    resume_item_id = presentation.get("resume_item_id")
    if isinstance(resume_item_id, str):
        await services.resume.update_item_by_id(
            user_id,
            resume_item_id,
            ResumeItemPatch(
                title=updated_variant.title,
                content_snapshot=updated_variant.content,
            ),
        )

    variant["content"] = updated_variant.content
    variant["title"] = updated_variant.title
    variant["structured"] = updated_variant.structured
    selected_resume = presentation.get("resume")
    if isinstance(selected_resume, dict) and selected_resume.get("id") == updated_variant.id:
        selected_resume["content"] = updated_variant.content
        selected_resume["title"] = updated_variant.title
        selected_resume["structured"] = updated_variant.structured
    presentation["selected_variant_id"] = updated_variant.id
    presentation["content_snapshot"] = updated_variant.content
    presentation["structured_snapshot"] = updated_variant.structured
    presentation["status"] = "edited"
    metadata["presentation"] = presentation
    async with checked_pool.acquire() as conn:
        await conn.execute(
            "UPDATE thread_messages SET metadata = $1::jsonb WHERE id = $2 AND thread_id = $3",
            json.dumps(metadata),
            message_id,
            thread_id,
        )

    return ok(
        {
            "messageId": message_id,
            "presentation": presentation,
        },
        request,
    )


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

    from app.api.routes.copilot import _build_response, _extract_interrupt_payload
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

    completed = await _completed_interrupt_operation(
        _pool,
        thread_id=thread_id,
        turn_id=body.turnId,
        action="resume",
    )
    if completed is not None:
        return ok(completed, request)

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

    pending = _pending_interrupt_or_conflict(
        snapshot,
        turn_id=body.turnId,
        interrupt_id=body.interruptId,
    )
    pending_interrupt_id = cast("str", pending.interrupt_id)
    claimed = await _claim_interrupt_operation(
        _pool,
        thread_id=thread_id,
        turn_id=body.turnId,
        interrupt_id=pending_interrupt_id,
        action="resume",
    )
    if claimed is not None:
        return ok(claimed, request)

    try:
        final_state = await graph.ainvoke(Command(resume=resume_data), config=config)
    except Exception as exc:
        logger.exception("Resume error: %s", exc)
        raise ExternalServiceError("Graph resume failed") from exc

    assistant_msg = str(final_state.get("assistant_message") or "Done.")
    extracted_interrupt = _extract_interrupt_payload(final_state)
    interrupt_payload = (
        extracted_interrupt if isinstance(extracted_interrupt, dict) else None
    )
    workspace = (
        cast("dict[str, JsonValue]", final_state.get("workspace"))
        if isinstance(final_state.get("workspace"), dict)
        else None
    )

    if (
        _pool is not None
        and pending.payload.get("type") == "resume_review"
        and resume_data.get("action") in {"accept", "confirm"}
        and isinstance(workspace, dict)
    ):
        from app.api.routes.copilot import _mark_resume_canvas_accepted

        selected = resume_data.get("selected_variant_id") or resume_data.get("variant_id")
        resume_item_id = workspace.get("resume_item_id")
        canvas_message_id = resume_data.get("canvas_message_id")
        if isinstance(selected, str) and isinstance(resume_item_id, str):
            await _mark_resume_canvas_accepted(
                _pool,
                thread_id=thread_id,
                variant_id=selected,
                resume_item_id=resume_item_id,
                canvas_message_id=(
                    canvas_message_id if isinstance(canvas_message_id, str) else None
                ),
            )

    if _pool is not None and not interrupt_payload:
        from app.api.routes.copilot import _persist_message

        await _persist_message(
            _pool,
            thread_id=thread_id,
            role="assistant",
            content=assistant_msg,
            turn_id=body.turnId,
            metadata={"resumed": True},
        )

    response = cast(
        "dict[str, JsonValue]",
        _build_response(thread_id, body.turnId, assistant_msg, workspace, interrupt_payload),
    )
    await _complete_interrupt_operation(
        _pool,
        thread_id=thread_id,
        turn_id=body.turnId,
        interrupt_id=pending_interrupt_id,
        action="resume",
        response=response,
    )
    return ok(response, request)


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

    checkpointer = _get_checkpointer_or_none()
    if checkpointer is None:
        raise ConflictError("Thread has no persisted pending interrupt to discard")

    completed = await _completed_interrupt_operation(
        _pool,
        thread_id=thread_id,
        turn_id=body.turnId,
        action="discard",
    )
    if completed is not None:
        return ok(completed, request)

    from app.graphs.main import get_graph

    graph = get_graph(checkpointer)
    configurable: dict[str, object] = {"thread_id": thread_id}
    if _pool:
        configurable["pool"] = _pool
        configurable["services"] = build_service_container(_pool)
    cfg: RunnableConfig = {"configurable": configurable}
    try:
        snapshot = await graph.aget_state(cfg)
    except Exception as exc:
        logger.exception("Discard state load error: %s", exc)
        raise ExternalServiceError("Could not load thread discard state") from exc
    pending = _pending_interrupt_or_conflict(
        snapshot,
        turn_id=body.turnId,
        interrupt_id=body.interruptId,
    )
    pending_interrupt_id = cast("str", pending.interrupt_id)
    claimed = await _claim_interrupt_operation(
        _pool,
        thread_id=thread_id,
        turn_id=body.turnId,
        interrupt_id=pending_interrupt_id,
        action="discard",
    )
    if claimed is not None:
        return ok(claimed, request)

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

    from langgraph.types import Command

    try:
        await graph.ainvoke(Command(resume={"action": "discard"}), config=cfg)
    except Exception as exc:
        logger.exception("Discard error: %s", exc)
        raise ExternalServiceError("Graph discard failed") from exc

    response: dict[str, JsonValue] = {
        "threadId": thread_id,
        "turnId": body.turnId,
        "status": "discarded",
    }
    await _complete_interrupt_operation(
        _pool,
        thread_id=thread_id,
        turn_id=body.turnId,
        interrupt_id=pending_interrupt_id,
        action="discard",
        response=response,
    )
    return ok(response, request)
