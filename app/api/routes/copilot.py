"""
Copilot API routes.

POST /copilot/chat         — non-streaming chat
POST /copilot/chat/stream  — SSE streaming chat
POST /copilot/actions      — explicit product actions
GET  /copilot/sidebar      — sidebar summary data
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.api.deps import get_current_user_id, pool_dep
from app.api.response import ok
from app.api.sse import _build_initial_state, stream_graph_events
from app.core.types import THREAD_PREFIX, generate_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/copilot", tags=["copilot"])


# ── Request / Response schemas ─────────────────────────────────────────────────


class ClientState(BaseModel):
    locale: str = "zh-CN"
    activeJdId: str | None = None
    activeResumeId: str | None = None
    activeArtifactId: str | None = None
    activeExperienceIds: list[str] = []


class ChatRequest(BaseModel):
    threadId: str | None = None
    message: str
    clientState: ClientState = ClientState()


class ActionPayload(BaseModel):
    type: str
    payload: dict[str, Any] = {}


class ActionRequest(BaseModel):
    threadId: str | None = None
    action: ActionPayload
    clientState: ClientState = ClientState()


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _get_or_create_thread(thread_id: str | None, user_id: str, pool) -> str:
    """Return existing thread_id or create a new thread row."""
    if thread_id:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id FROM threads WHERE id = $1 AND user_id = $2",
                thread_id, user_id,
            )
        if row:
            return thread_id
    # Create new thread
    new_id = generate_id(THREAD_PREFIX)
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO threads (id, user_id, title, status, created_at, updated_at)
            VALUES ($1, $2, $3, 'active', NOW(), NOW())
            ON CONFLICT DO NOTHING
            """,
            new_id, user_id, "New conversation",
        )
    return new_id


def _workspace_from_client_state(cs: ClientState) -> dict[str, Any]:
    workspace: dict[str, Any] = {}
    if cs.activeJdId:
        workspace["jd_id"] = cs.activeJdId
    if cs.activeResumeId:
        workspace["resume_id"] = cs.activeResumeId
    if cs.activeArtifactId:
        workspace["artifact_id"] = cs.activeArtifactId
    if cs.activeExperienceIds:
        workspace["experience_ids"] = cs.activeExperienceIds
    return workspace


def _build_response(
    thread_id: str,
    turn_id: str,
    assistant_message: str,
    workspace: dict[str, Any] | None = None,
    interrupt: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "threadId": thread_id,
        "turnId": turn_id,
        "assistantMessage": {
            "id": generate_id("msg"),
            "role": "assistant",
            "content": assistant_message or "",
            "createdAt": datetime.now(timezone.utc).isoformat(),
        },
        "workspace": workspace or {},
        "nextActions": [],
        "suggestedPrompts": [],
        "interrupt": interrupt,
    }


# ── Routes ─────────────────────────────────────────────────────────────────────


@router.post("/chat")
async def chat(
    body: ChatRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool=Depends(pool_dep),
):
    """Non-streaming chat — runs graph synchronously and returns final response."""
    from app.graphs.main import get_graph
    from app.infra.db.connection import get_pool as _get_pool

    try:
        _pool = _get_pool()
    except RuntimeError:
        _pool = None

    thread_id = body.threadId
    if _pool:
        thread_id = await _get_or_create_thread(body.threadId, user_id, _pool)
    else:
        thread_id = body.threadId or generate_id(THREAD_PREFIX)

    turn_id = generate_id("turn")
    workspace = _workspace_from_client_state(body.clientState)
    initial_state = _build_initial_state(thread_id, user_id, body.message, workspace, turn_id)
    config = {"configurable": {"thread_id": thread_id}}

    try:
        graph = get_graph()
        final_state = await graph.ainvoke(initial_state, config=config)
        assistant_msg = final_state.get("assistant_message", "Done.")
        interrupt_payload = final_state.get("interrupt_payload")
    except Exception as exc:
        logger.exception("Graph error: %s", exc)
        assistant_msg = "An error occurred. Please try again."
        interrupt_payload = None

    return ok(
        _build_response(thread_id, turn_id, assistant_msg, workspace, interrupt_payload),
        request,
    )


@router.post("/chat/stream")
async def chat_stream(
    body: ChatRequest,
    user_id: str = Depends(get_current_user_id),
    pool=Depends(pool_dep),
):
    """SSE streaming chat."""
    from app.graphs.main import get_graph
    from app.infra.db.connection import get_pool as _get_pool

    try:
        _pool = _get_pool()
        thread_id = await _get_or_create_thread(body.threadId, user_id, _pool)
    except RuntimeError:
        thread_id = body.threadId or generate_id(THREAD_PREFIX)

    turn_id = generate_id("turn")
    workspace = _workspace_from_client_state(body.clientState)
    initial_state = _build_initial_state(thread_id, user_id, body.message, workspace, turn_id)
    config = {"configurable": {"thread_id": thread_id}}

    graph = get_graph()

    return StreamingResponse(
        stream_graph_events(graph, initial_state, config),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/actions")
async def product_action(
    body: ActionRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool=Depends(pool_dep),
):
    """
    Explicit product action endpoint.
    Translates the action into a natural-language message and routes through the graph.
    """
    action_messages = {
        "optimize_resume_item": "Please optimize resume item {resumeItemId}. {instruction}",
        "rewrite_experience": "Please rewrite experience {experienceId}. Instruction: {instruction}",
        "generate_resume_from_jd": "Generate a resume targeting JD {jdId}.",
        "accept_variant": "Accept variant {variantId} and save it as the active resume.",
        "show_evidence": "Show evidence for variant {variantId}.",
        "generate_artifact": "Generate a {artifactType} artifact. {instruction}",
        "export_resume": "Export resume {resumeId}.",
    }

    template = action_messages.get(body.action.type, "Perform action: {type}")
    message = template.format(type=body.action.type, **body.action.payload)

    # Re-use the chat endpoint logic
    chat_body = ChatRequest(
        threadId=body.threadId,
        message=message,
        clientState=body.clientState,
    )
    return await chat(chat_body, request, user_id, pool)


@router.get("/sidebar")
async def sidebar(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool=Depends(pool_dep),
):
    """Return sidebar summary: recent threads, experiences, JDs, resumes, artifacts."""
    try:
        from app.infra.db.connection import get_pool as _get_pool
        _pool = _get_pool()

        async with _pool.acquire() as conn:
            threads = await conn.fetch(
                "SELECT id, title, updated_at FROM threads WHERE user_id = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT 10",
                user_id,
            )
            experiences = await conn.fetch(
                "SELECT id, title, organization FROM experiences WHERE user_id = $1 AND is_archived = false ORDER BY updated_at DESC LIMIT 5",
                user_id,
            )
            jds = await conn.fetch(
                "SELECT id, title, company FROM jd_records WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5",
                user_id,
            )
            resumes = await conn.fetch(
                "SELECT id, title FROM resumes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 5",
                user_id,
            )
            artifacts = await conn.fetch(
                "SELECT id, type, title FROM artifacts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5",
                user_id,
            )

        def _row(r):
            return dict(r)

        return ok(
            {
                "recentThreads": [_row(r) for r in threads],
                "recentExperiences": [_row(r) for r in experiences],
                "recentJds": [_row(r) for r in jds],
                "recentResumes": [_row(r) for r in resumes],
                "recentArtifacts": [_row(r) for r in artifacts],
            },
            request,
        )
    except RuntimeError:
        return ok(
            {
                "recentThreads": [],
                "recentExperiences": [],
                "recentJds": [],
                "recentResumes": [],
                "recentArtifacts": [],
            },
            request,
        )
