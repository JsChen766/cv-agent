"""
Copilot API routes.

POST /copilot/chat         — non-streaming chat
POST /copilot/chat/stream  — SSE streaming chat
POST /copilot/actions      — explicit product actions
POST /copilot/actions/stream — SSE streaming resume-generation action
GET  /copilot/sidebar      — sidebar summary data
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncGenerator, Mapping
from datetime import UTC, datetime
from typing import Literal, cast

import asyncpg
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from app.api.deps import build_service_container, get_current_user_id, pool_dep
from app.api.file_parsing import find_cached_parsed_text_for_upload, parse_file_for_request
from app.api.observability import (
    create_resume_trace,
    finish_trace_best_effort,
    inject_trace,
)
from app.api.response import ok
from app.api.schemas import StrictRequestModel
from app.api.sse import _build_initial_state, stream_graph_events
from app.core.errors import ExternalServiceError, NotFoundError, ValidationError
from app.core.events import format_sse
from app.core.types import THREAD_PREFIX, ArtifactType, generate_id
from app.graphs.state import MainState
from app.memory.thread_state import MessageDict
from app.tools.actions import capabilities as action_capabilities
from app.tools.actions.models import (
    ExportResumeInput,
    GenerateArtifactInput,
    OptimizeResumeItemInput,
    RewriteExperienceInput,
    VariantInput,
)
from app.tools.base import ServiceContainer

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/copilot", tags=["copilot"])

JsonObject = dict[str, JsonValue]
MAX_CHAT_UPLOAD_TEXT_CHARS = 80_000


# ── Request / Response schemas ─────────────────────────────────────────────────


class ResumeUploadState(StrictRequestModel):
    model_config = ConfigDict(extra="ignore")

    fileId: str | None = None
    id: str | None = None
    originalName: str | None = None
    fileName: str | None = None
    name: str | None = None
    mimeType: str | None = None


class ClientState(StrictRequestModel):
    model_config = ConfigDict(extra="ignore")

    locale: str = "zh-CN"
    activeJdId: str | None = None
    activeResumeId: str | None = None
    activeArtifactId: str | None = None
    activeExperienceIds: list[str] = Field(default_factory=list)
    activeThreadId: str | None = None
    activeFileId: str | None = None
    uploadedFileId: str | None = None
    resumeFileId: str | None = None
    fileId: str | None = None
    resumeUpload: ResumeUploadState | None = None
    intentSource: str | None = None
    sourceComponent: str | None = None
    requestedSubgraph: Literal["resume_generation"] | None = None
    editingScope: str | None = None
    requireReviewBeforeApply: bool | None = None


class ChatRequest(StrictRequestModel):
    threadId: str | None = None
    message: str = Field(min_length=1)
    clientState: ClientState = Field(default_factory=ClientState)


class AssistantMessage(BaseModel):
    id: str
    role: Literal["assistant"]
    content: str
    createdAt: str


class ChatResponseData(BaseModel):
    threadId: str
    turnId: str
    assistantMessage: AssistantMessage
    workspace: JsonObject = Field(default_factory=dict)
    nextActions: list[dict[str, JsonValue]] = Field(default_factory=list)
    suggestedPrompts: list[str] = Field(default_factory=list)
    interrupt: dict[str, JsonValue] | None = None


class ChatResponseEnvelope(BaseModel):
    success: bool
    data: ChatResponseData
    request_id: str


ActionType = Literal[
    "optimize_resume_item",
    "rewrite_experience",
    "generate_resume_from_jd",
    "accept_variant",
    "show_evidence",
    "generate_artifact",
    "export_resume",
]


class _ActionPayloadBase(StrictRequestModel):
    pass


class OptimizeResumeItemPayload(_ActionPayloadBase):
    resumeItemId: str = Field(min_length=1)
    instruction: str = ""


class RewriteExperiencePayload(_ActionPayloadBase):
    experienceId: str = Field(min_length=1)
    instruction: str = ""


class GenerateResumeFromJdPayload(_ActionPayloadBase):
    jdId: str = Field(min_length=1)


class VariantPayload(_ActionPayloadBase):
    variantId: str = Field(min_length=1)
    canvasMessageId: str | None = None


class GenerateArtifactPayload(_ActionPayloadBase):
    artifactType: ArtifactType
    instruction: str = ""


class ExportResumePayload(_ActionPayloadBase):
    resumeId: str = Field(min_length=1)


ParsedActionPayload = (
    OptimizeResumeItemPayload
    | RewriteExperiencePayload
    | GenerateResumeFromJdPayload
    | VariantPayload
    | GenerateArtifactPayload
    | ExportResumePayload
)


_ACTION_PAYLOAD_MODELS: dict[str, type[_ActionPayloadBase]] = {
    "optimize_resume_item": OptimizeResumeItemPayload,
    "rewrite_experience": RewriteExperiencePayload,
    "generate_resume_from_jd": GenerateResumeFromJdPayload,
    "accept_variant": VariantPayload,
    "show_evidence": VariantPayload,
    "generate_artifact": GenerateArtifactPayload,
    "export_resume": ExportResumePayload,
}


class ActionPayload(StrictRequestModel):
    type: ActionType
    payload: JsonObject = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_payload(self) -> ActionPayload:
        self.payload_model()
        return self

    def payload_model(self) -> ParsedActionPayload:
        model = _ACTION_PAYLOAD_MODELS[self.type]
        return cast("ParsedActionPayload", model.model_validate(self.payload))


class ActionRequest(StrictRequestModel):
    threadId: str | None = None
    action: ActionPayload
    clientState: ClientState = Field(default_factory=ClientState)


CHAT_RESPONSE_EXAMPLES = {
    "normal": {
        "summary": "普通回复",
        "value": {
            "success": True,
            "data": {
                "threadId": "thread_123",
                "turnId": "turn_123",
                "assistantMessage": {
                    "id": "msg_123",
                    "role": "assistant",
                    "content": "我已经整理好了你的经历信息。",
                    "createdAt": "2026-07-05T12:00:00+00:00",
                },
                "workspace": {"jd_id": "jd_123"},
                "nextActions": [],
                "suggestedPrompts": [],
                "interrupt": None,
            },
            "request_id": "req_123",
        },
    },
    "confirmationRequired": {
        "summary": "需要用户确认",
        "value": {
            "success": True,
            "data": {
                "threadId": "thread_123",
                "turnId": "turn_123",
                "assistantMessage": {
                    "id": "msg_124",
                    "role": "assistant",
                    "content": "",
                    "createdAt": "2026-07-05T12:00:00+00:00",
                },
                "workspace": {},
                "nextActions": [],
                "suggestedPrompts": [],
                "interrupt": {
                    "type": "confirm_action",
                    "message": "Please confirm before I run 'save_experience'.",
                    "tool": "save_experience",
                    "input": {"title": "Backend Engineer", "content": "..."},
                },
            },
            "request_id": "req_124",
        },
    },
}

SSE_STREAM_RESPONSES = {
    200: {
        "description": (
            "Server-Sent Events stream. Each chunk uses `event: <name>` and "
            "`data: <json>` lines. Frontend process display should primarily "
            "consume `agent.activity.updated`."
        ),
        "content": {
            "text/event-stream": {
                "schema": {
                    "type": "string",
                    "description": "SSE stream containing agent activity, tool, message, interrupt, completion, and failure events.",
                },
                "examples": {
                    "activity": {
                        "summary": "Agent process display event",
                        "value": (
                            "event: agent.activity.updated\n"
                            'data: {"event":"agent.activity.updated","thread_id":"thread_123","turn_id":"turn_123","sequence":1,'
                            '"timestamp":"2026-07-05T12:00:00+00:00","agent_role":"resume_writer","agent_label":"简历写手",'
                            '"status":"running","action":"正在生成内容草稿"}\n\n'
                        ),
                    },
                    "tool": {
                        "summary": "Tool call event",
                        "value": (
                            "event: agent.tool.started\n"
                            'data: {"event":"agent.tool.started","tool":"list_resumes","input":{"limit":1}}\n\n'
                        ),
                    },
                    "interrupt": {
                        "summary": "Confirmation interrupt event",
                        "value": (
                            "event: agent.interrupt\n"
                            'data: {"event":"agent.interrupt","type":"confirm_action","tool":"save_experience",'
                            '"message":"Please confirm before I run save_experience."}\n\n'
                        ),
                    },
                    "completed": {
                        "summary": "Stream completion event",
                        "value": 'event: agent.completed\ndata: {"event":"agent.completed"}\n\n',
                    },
                },
            }
        },
    }
}


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _get_or_create_thread(thread_id: str | None, user_id: str, pool: asyncpg.Pool) -> str:
    """Return existing thread_id or create a new thread row."""
    if thread_id:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id FROM threads WHERE id = $1 AND user_id = $2",
                thread_id,
                user_id,
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
            new_id,
            user_id,
            "New conversation",
        )
    return new_id


async def _persist_message(
    pool: asyncpg.Pool | None,
    *,
    thread_id: str,
    role: str,
    content: str,
    turn_id: str | None = None,
    metadata: dict[str, JsonValue] | None = None,
) -> str | None:
    """Persist a chat message into thread_messages so history can be re-loaded.

    Silent no-op if the pool is unavailable or the write fails, so a database
    hiccup never breaks the user-facing chat flow.
    """
    if pool is None:
        return None
    if not isinstance(content, str) or not content:
        return None
    meta: dict[str, JsonValue] = dict(metadata or {})
    if turn_id:
        meta.setdefault("turn_id", turn_id)
    try:
        message_id = generate_id("msg")
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO thread_messages (id, thread_id, role, content, metadata, created_at)
                VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
                """,
                message_id,
                thread_id,
                role,
                content,
                json.dumps(meta),
            )
            await conn.execute(
                "UPDATE threads SET updated_at = NOW() WHERE id = $1",
                thread_id,
            )
        return message_id
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to persist %s message for thread %s: %s", role, thread_id, exc)
        return None


def _resume_generation_user_message(raw_text: str) -> str:
    """Build the durable user turn shown when a JD starts a resume conversation."""
    return f"这是目标岗位的 JD：\n\n{raw_text.strip()}\n\n请根据以上 JD 生成一份针对性简历。"


def _resume_generation_thread_title(
    *,
    company: str | None,
    target_role: str | None,
    jd_title: str,
) -> str:
    subject = " · ".join(part.strip() for part in (company, target_role) if part and part.strip())
    if not subject:
        subject = jd_title.strip() or "目标岗位"
    return f"生成简历｜{subject}"[:80]


async def _set_thread_title(
    pool: asyncpg.Pool,
    *,
    thread_id: str,
    title: str,
) -> None:
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE threads SET title = $1, updated_at = NOW() WHERE id = $2",
                title,
                thread_id,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to update title for thread %s: %s", thread_id, exc)


def _resume_canvas_metadata(
    interrupt: Mapping[str, object] | None,
    workspace: Mapping[str, object] | None,
) -> dict[str, JsonValue] | None:
    """Build the durable, frontend-renderable representation of a resume canvas."""
    if not isinstance(interrupt, Mapping) or interrupt.get("type") not in {
        "resume_review",
        "application_package_review",
    }:
        return None
    # Prefer the new single-resume field (Layer 2). Fall back to legacy variants
    # array only if `resume` is absent — supports mid-migration payloads.
    raw_resume = interrupt.get("resume")
    raw_variants = interrupt.get("variants")

    variants: list[dict[str, JsonValue]] = []

    def _absorb(raw_variant: Mapping[str, object]) -> None:
        variant_id = raw_variant.get("id")
        content = raw_variant.get("content")
        if not isinstance(variant_id, str) or not isinstance(content, str):
            return
        variant: dict[str, JsonValue] = {"id": variant_id, "content": content}
        title = raw_variant.get("title")
        if isinstance(title, str):
            variant["title"] = title
        score = raw_variant.get("score")
        if isinstance(score, dict):
            variant["score"] = cast("JsonValue", score)
        structured = raw_variant.get("structured")
        if isinstance(structured, dict):
            variant["structured"] = cast("JsonValue", structured)
        variants.append(variant)

    if isinstance(raw_resume, Mapping):
        _absorb(raw_resume)
    elif isinstance(raw_variants, list):
        for raw_variant in raw_variants:
            if isinstance(raw_variant, Mapping):
                _absorb(raw_variant)

    if not variants:
        return None

    lookup_sources: list[Mapping[str, object]] = []
    if isinstance(raw_resume, Mapping):
        lookup_sources.append(raw_resume)
    if isinstance(raw_variants, list):
        lookup_sources.extend(
            raw_variant for raw_variant in raw_variants if isinstance(raw_variant, Mapping)
        )

    resume_id = workspace.get("resume_id") if isinstance(workspace, Mapping) else None
    if not isinstance(resume_id, str):
        candidate_ids = {
            src.get("resume_id") or src.get("resumeId")
            for src in lookup_sources
            if isinstance(src.get("resume_id") or src.get("resumeId"), str)
        }
        if len(candidate_ids) == 1:
            resume_id = next(iter(candidate_ids))
    selected_variant = variants[0]
    presentation: dict[str, JsonValue] = {
        "type": "resume_canvas",
        "schema_version": 1,
        "variant_ids": [variant["id"] for variant in variants],
        "variants": cast("JsonValue", variants),
        "selected_variant_id": selected_variant["id"],
        "content_snapshot": selected_variant["content"],
        "status": "reviewing",
    }
    if "structured" in selected_variant:
        presentation["structured_snapshot"] = selected_variant["structured"]
    if isinstance(resume_id, str):
        presentation["resume_id"] = resume_id
    if interrupt.get("type") == "application_package_review":
        deliverables = interrupt.get("deliverables")
        unsupported_requirements = interrupt.get("unsupported_requirements")
        if isinstance(deliverables, list):
            presentation["application_deliverables"] = cast("JsonValue", deliverables)
        if isinstance(unsupported_requirements, list):
            presentation["unsupported_requirements"] = cast("JsonValue", unsupported_requirements)
    return presentation


async def _persist_resume_canvas_message(
    pool: asyncpg.Pool | None,
    *,
    thread_id: str,
    turn_id: str,
    workspace: Mapping[str, object] | None,
    interrupt: Mapping[str, object] | None,
    content: str = "简历草稿已生成，可在画布中查看和编辑。",
) -> str | None:
    presentation = _resume_canvas_metadata(interrupt, workspace)
    if presentation is None:
        return None
    return await _persist_message(
        pool,
        thread_id=thread_id,
        role="assistant",
        content=content,
        turn_id=turn_id,
        metadata={"presentation": presentation},
    )


async def _mark_resume_canvas_accepted(
    pool: asyncpg.Pool | None,
    *,
    thread_id: str,
    variant_id: str,
    resume_item_id: str,
    canvas_message_id: str | None = None,
) -> None:
    """Mark the exact historical canvas as accepted without moving it in the timeline."""
    if pool is None:
        return
    try:
        async with pool.acquire() as conn:
            if canvas_message_id:
                row = await conn.fetchrow(
                    "SELECT id, metadata FROM thread_messages WHERE id = $1 AND thread_id = $2",
                    canvas_message_id,
                    thread_id,
                )
            else:
                row = await conn.fetchrow(
                    """
                    SELECT id, metadata FROM thread_messages
                    WHERE thread_id = $1
                      AND role = 'assistant'
                      AND metadata->'presentation'->>'type' = 'resume_canvas'
                      AND metadata->'presentation'->'variant_ids' ? $2
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    thread_id,
                    variant_id,
                )
            if row is None:
                return
            metadata = row["metadata"]
            if not isinstance(metadata, dict):
                metadata = json.loads(metadata) if isinstance(metadata, str) else {}
            presentation = metadata.get("presentation")
            if not isinstance(presentation, dict) or presentation.get("type") != "resume_canvas":
                return
            variant_ids = presentation.get("variant_ids")
            if not isinstance(variant_ids, list) or variant_id not in variant_ids:
                return
            presentation.update(
                {
                    "status": "accepted",
                    "selected_variant_id": variant_id,
                    "resume_item_id": resume_item_id,
                }
            )
            metadata["presentation"] = presentation
            await conn.execute(
                "UPDATE thread_messages SET metadata = $1::jsonb WHERE id = $2 AND thread_id = $3",
                json.dumps(metadata),
                row["id"],
                thread_id,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to mark resume canvas accepted in thread %s: %s", thread_id, exc)


def _workspace_from_client_state(cs: ClientState) -> JsonObject:
    workspace: JsonObject = {}
    if cs.activeJdId:
        workspace["jd_id"] = cs.activeJdId
    if cs.activeResumeId:
        workspace["resume_id"] = cs.activeResumeId
    if cs.activeArtifactId:
        workspace["artifact_id"] = cs.activeArtifactId
    if cs.activeExperienceIds:
        workspace["experience_ids"] = cast("JsonValue", cs.activeExperienceIds)
    upload_file_id = _upload_file_id_from_client_state(cs)
    if upload_file_id:
        workspace["file_id"] = upload_file_id
        workspace["uploaded_file_id"] = upload_file_id
        if cs.resumeFileId:
            workspace["resume_file_id"] = cs.resumeFileId
    return workspace


async def _verified_workspace_from_client_state(
    cs: ClientState,
    user_id: str,
    pool: asyncpg.Pool,
) -> JsonObject:
    """Validate every persisted workspace reference while preserving upload hints."""
    from app.api.copilot.workspace_builder import build_workspace

    raw = _workspace_from_client_state(cs)
    verified = cast("JsonObject", await build_workspace(user_id, raw, pool))
    for key in ("file_id", "uploaded_file_id", "resume_file_id"):
        value = raw.get(key)
        if isinstance(value, str):
            verified[key] = value
    return verified


def _upload_file_id_from_client_state(cs: ClientState) -> str | None:
    upload = cs.resumeUpload
    if upload is not None:
        for value in (upload.fileId, upload.id):
            if value:
                return value
    for value in (cs.resumeFileId, cs.uploadedFileId, cs.activeFileId, cs.fileId):
        if value:
            return value
    return None


def _upload_original_name_from_client_state(cs: ClientState) -> str | None:
    upload = cs.resumeUpload
    if upload is None:
        return None
    for value in (upload.originalName, upload.fileName, upload.name):
        if value:
            return value
    return None


async def _reject_if_pending_interrupt(graph: object, config: RunnableConfig) -> None:
    """Do not let a new message implicitly consume a confirmation request."""
    from app.api.interrupts import pending_interrupt_from_snapshot
    from app.core.errors import ConflictError

    aget_state = getattr(graph, "aget_state", None)
    if not callable(aget_state):
        return
    try:
        snapshot = await aget_state(config)
    except Exception as exc:
        logger.warning("Pending interrupt state load failed: %s", exc)
        return
    if pending_interrupt_from_snapshot(snapshot) is not None:
        raise ConflictError(
            "Thread has a pending confirmation; resume or discard it before sending a new message",
            code="pending_interrupt_exists",
        )


async def _merged_workspace(
    cs: ClientState,
    user_id: str,
    thread_id: str,
    pool: asyncpg.Pool | None,
) -> JsonObject:
    """Three-way workspace merge: persisted snapshot ← client_state ← (nothing yet).

    Priority (highest wins):
      1. client_state explicit ids (non-None values)
      2. persisted workspace_snapshot from threads table
    Keys absent from client_state are preserved from the snapshot ("never drop").
    """
    if pool is None:
        return _workspace_from_client_state(cs)

    from app.infra.db.repositories.thread_repo import PostgresThreadRepository

    thread_repo = PostgresThreadRepository(pool)
    try:
        snapshot = await thread_repo.get_workspace_snapshot(thread_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to load workspace snapshot for thread %s: %s", thread_id, exc)
        snapshot = {}

    client_ws = await _verified_workspace_from_client_state(cs, user_id, pool)
    # Start from persisted snapshot, overlay with client's explicit values.
    # _verified_workspace_from_client_state only sets keys for non-None client fields,
    # so missing client fields never overwrite the snapshot.
    return cast("JsonObject", {**snapshot, **client_ws})


async def _build_chat_initial_state(
    *,
    thread_id: str,
    user_id: str,
    message: str,
    client_state: ClientState,
    turn_id: str,
    pool: asyncpg.Pool | None,
) -> MainState:
    workspace = await _merged_workspace(client_state, user_id, thread_id, pool)

    # Load recent conversation history plus the durable rolling summary.
    historical: list[dict[str, object]] = []
    rolling_summary: str | None = None
    turn_count = 1
    if pool:
        try:
            historical, rolling_summary, turn_count = await _load_thread_memory(
                pool,
                thread_id,
            )
        except Exception as exc:
            logger.warning("Failed to load thread history: %s", exc)

    current_msg: dict[str, object] = {"role": "user", "content": message, "turn_id": turn_id}
    messages = [*historical, current_msg]

    initial_state = _build_initial_state(thread_id, user_id, messages, workspace, turn_id)
    initial_state["rolling_summary"] = rolling_summary
    initial_state["turn_count"] = turn_count
    if client_state.requestedSubgraph == "resume_generation":
        initial_state["routing_hint"] = "resume_generation"
    upload_params = await _upload_extracted_params(client_state, user_id, pool)
    if upload_params:
        initial_state["extracted_params"] = upload_params
        initial_state["context_hints"] = ["uploaded_resume", "profile"]
    editing_scope = client_state.editingScope
    if editing_scope:
        initial_state["editing_scope"] = editing_scope
    if client_state.requireReviewBeforeApply:
        initial_state["require_review_before_apply"] = True
    return initial_state


async def _load_thread_memory(
    pool: asyncpg.Pool,
    thread_id: str,
) -> tuple[list[dict[str, object]], str | None, int]:
    """Load only unsummarized history and incrementally compact it when needed."""
    from app.memory.rolling_summary import maybe_compress

    async with pool.acquire() as conn:
        thread_row = await conn.fetchrow(
            "SELECT rolling_summary, summarized_message_count, turn_count FROM threads WHERE id=$1",
            thread_id,
        )
        if thread_row is None:
            return [], None, 1
        summarized_count = max(0, int(thread_row["summarized_message_count"] or 0))
        rows = await conn.fetch(
            "SELECT role, content FROM thread_messages "
            "WHERE thread_id=$1 ORDER BY created_at ASC OFFSET $2",
            thread_id,
            summarized_count,
        )

    existing_summary = (
        thread_row["rolling_summary"] if isinstance(thread_row["rolling_summary"], str) else None
    )
    unsummarized: list[MessageDict] = [
        {"role": row["role"], "content": row["content"], "turn_id": None}
        for row in rows
        if row["role"] in {"user", "assistant"}
    ]
    try:
        summary, recent = await maybe_compress(unsummarized, existing_summary)
    except Exception as exc:
        logger.warning("Rolling summary generation failed for thread %s: %s", thread_id, exc)
        summary, recent = existing_summary, unsummarized[-20:]
    newly_summarized = len(unsummarized) - len(recent)
    next_summarized_count = summarized_count + newly_summarized

    current_turn_count = max(0, int(thread_row["turn_count"] or 0))
    try:
        async with pool.acquire() as conn:
            updated_turn_count = await conn.fetchval(
                "UPDATE threads SET rolling_summary=$1, summarized_message_count=$2, "
                "turn_count=turn_count+1, updated_at=NOW() WHERE id=$3 RETURNING turn_count",
                summary,
                next_summarized_count,
                thread_id,
            )
    except Exception as exc:
        logger.warning("Rolling memory persistence failed for thread %s: %s", thread_id, exc)
        updated_turn_count = current_turn_count + 1

    historical = [dict(message) for message in recent[-20:]]
    return historical, summary, int(updated_turn_count or 1)


async def _upload_extracted_params(
    cs: ClientState,
    user_id: str,
    pool: asyncpg.Pool | None,
) -> JsonObject | None:
    file_id = _upload_file_id_from_client_state(cs)
    if not file_id:
        return None
    if pool is None:
        raise ExternalServiceError(
            "Uploaded file cannot be read because the database is unavailable"
        )

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM uploaded_files WHERE id=$1 AND user_id=$2",
            file_id,
            user_id,
        )
    if not row:
        raise NotFoundError(f"File not found: {file_id}")

    record = dict(row)
    raw_parsed_text = record.get("parsed_text")
    if isinstance(raw_parsed_text, str) and raw_parsed_text.strip():
        parsed_text = raw_parsed_text
    else:
        from app.infra.files.storage import get_storage

        storage = get_storage()
        content = await storage.get(str(record["storage_path"]))
        parsed_text = None
        if record.get("size_bytes") is not None:
            async with pool.acquire() as conn:
                parsed_text = await find_cached_parsed_text_for_upload(
                    conn=conn,
                    storage=storage,
                    user_id=user_id,
                    file_id=file_id,
                    filename=str(record["filename"]),
                    mime_type=str(record["mime_type"]),
                    size_bytes=int(record["size_bytes"]),
                    content=content,
                )
        if parsed_text is None:
            parsed_text = await parse_file_for_request(content, str(record["mime_type"]))
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE uploaded_files SET parsed_text=$1 WHERE id=$2",
                parsed_text,
                file_id,
            )

    parsed_text = (parsed_text or "").strip()
    truncated = len(parsed_text) > MAX_CHAT_UPLOAD_TEXT_CHARS
    if truncated:
        parsed_text = parsed_text[:MAX_CHAT_UPLOAD_TEXT_CHARS]
    original_name = _upload_original_name_from_client_state(cs) or record.get("filename")

    params: JsonObject = {
        "raw_text": parsed_text,
        "source": "uploaded_file",
        "file_id": file_id,
        "uploaded_file_id": file_id,
        "truncated": truncated,
    }
    if isinstance(original_name, str) and original_name:
        params["original_name"] = original_name
    mime_type = record.get("mime_type")
    if isinstance(mime_type, str) and mime_type:
        params["mime_type"] = mime_type
    return params


def _build_response(
    thread_id: str,
    turn_id: str,
    assistant_message: str,
    workspace: JsonObject | None = None,
    interrupt: JsonObject | None = None,
    assistant_message_id: str | None = None,
) -> dict[str, object]:
    return {
        "threadId": thread_id,
        "turnId": turn_id,
        "assistantMessage": {
            "id": assistant_message_id or generate_id("msg"),
            "role": "assistant",
            "content": assistant_message or "",
            "createdAt": datetime.now(UTC).isoformat(),
        },
        "workspace": workspace or {},
        "nextActions": [],
        "suggestedPrompts": [],
        "interrupt": interrupt,
    }


def _require_action_pool(pool: asyncpg.Pool | None) -> asyncpg.Pool:
    if pool is not None:
        return pool
    try:
        from app.infra.db.connection import get_pool as _get_pool

        return _get_pool()
    except RuntimeError as exc:
        raise ExternalServiceError("Database unavailable") from exc


async def _prepare_action_context(
    body: ActionRequest,
    user_id: str,
    pool: asyncpg.Pool | None,
) -> tuple[str, str, JsonObject, ServiceContainer, RunnableConfig]:
    checked_pool = _require_action_pool(pool)
    thread_id = await _get_or_create_thread(body.threadId, user_id, checked_pool)
    turn_id = generate_id("turn")
    workspace = await _verified_workspace_from_client_state(
        body.clientState,
        user_id,
        checked_pool,
    )
    services = build_service_container(checked_pool)
    from app.infra.db.repositories.thread_repo import PostgresThreadRepository

    config: RunnableConfig = {
        "configurable": {
            "thread_id": thread_id,
            "services": services,
            "pool": checked_pool,
            "thread_repo": PostgresThreadRepository(checked_pool),
        }
    }
    return thread_id, turn_id, workspace, services, config


def _extract_interrupt_payload(final_state: object) -> JsonObject | None:
    if not isinstance(final_state, dict):
        return None
    raw_interrupt = final_state.get("interrupt_payload")
    if isinstance(raw_interrupt, dict):
        return cast("JsonObject", raw_interrupt)
    interrupts = final_state.get("__interrupt__")
    if not isinstance(interrupts, (list, tuple)) or not interrupts:
        return None
    value = getattr(interrupts[0], "value", None)
    if isinstance(value, dict):
        return cast("JsonObject", value)
    return None


def _final_assistant_message(final_state: object, fallback: str) -> str:
    if isinstance(final_state, dict):
        message = final_state.get("assistant_message")
        if isinstance(message, str) and message:
            return message
    return fallback


# ── Routes ─────────────────────────────────────────────────────────────────────


@router.post(
    "/chat",
    response_model=ChatResponseEnvelope,
    responses={200: {"content": {"application/json": {"examples": CHAT_RESPONSE_EXAMPLES}}}},
)
async def chat(
    body: ChatRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool = Depends(pool_dep),
) -> JSONResponse:
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
    initial_state = await _build_chat_initial_state(
        thread_id=thread_id,
        user_id=user_id,
        message=body.message,
        client_state=body.clientState,
        turn_id=turn_id,
        pool=_pool,
    )
    configurable: dict[str, object] = {"thread_id": thread_id}
    services: ServiceContainer | None = None
    if _pool:
        from app.infra.db.repositories.thread_repo import PostgresThreadRepository

        services = build_service_container(_pool)
        configurable["services"] = services
        configurable["pool"] = _pool
        configurable["thread_repo"] = PostgresThreadRepository(_pool)
    _cp = _get_checkpointer_or_none()
    if _cp is not None:
        configurable["checkpointer"] = _cp
    config: RunnableConfig = {"configurable": configurable}
    recorder = create_resume_trace(
        request_id=getattr(request.state, "request_id", None),
        thread_id=thread_id,
        turn_id=turn_id,
        trigger="chat",
    )
    inject_trace(config, recorder)
    if recorder is not None:
        initial_state["observability_run_id"] = recorder.run_id

    await _persist_message(
        _pool,
        thread_id=thread_id,
        role="user",
        content=body.message,
        turn_id=turn_id,
    )

    try:
        graph = get_graph(_get_checkpointer_or_none())
        await _reject_if_pending_interrupt(graph, config)
        final_state = await graph.ainvoke(initial_state, config=config)
    except Exception as exc:
        await finish_trace_best_effort(
            recorder,
            user_id=user_id,
            service=services.resume_observability if services is not None else None,
            status="failed",
            error_code="graph_execution_failed",
        )
        logger.exception("Graph error: %s", exc)
        raise ExternalServiceError("Graph execution failed") from exc

    assistant_msg = str(final_state.get("assistant_message") or "Done.")
    interrupt_payload = _extract_interrupt_payload(final_state)
    response_workspace = (
        cast("JsonObject", final_state.get("workspace"))
        if isinstance(final_state.get("workspace"), dict)
        else cast("JsonObject", initial_state.get("workspace", {}))
    )

    canvas_message_id = await _persist_resume_canvas_message(
        _pool,
        thread_id=thread_id,
        turn_id=turn_id,
        workspace=response_workspace,
        interrupt=interrupt_payload,
        content=assistant_msg or "简历草稿已生成，可在画布中查看和编辑。",
    )
    if canvas_message_id and interrupt_payload is not None:
        interrupt_payload["canvas_message_id"] = canvas_message_id
    assistant_message_id = canvas_message_id
    if canvas_message_id is None:
        assistant_message_id = await _persist_message(
            _pool,
            thread_id=thread_id,
            role="assistant",
            content=assistant_msg,
            turn_id=turn_id,
            metadata={"interrupt": bool(interrupt_payload)},
        )

    await finish_trace_best_effort(
        recorder,
        user_id=user_id,
        service=services.resume_observability if services is not None else None,
        status="interrupted" if interrupt_payload is not None else "completed",
    )

    return ok(
        _build_response(
            thread_id,
            turn_id,
            assistant_msg,
            response_workspace,
            interrupt_payload,
            assistant_message_id,
        ),
        request,
    )


@router.post(
    "/chat/stream",
    response_class=StreamingResponse,
    responses=SSE_STREAM_RESPONSES,  # type: ignore[arg-type]
)
async def chat_stream(
    body: ChatRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool = Depends(pool_dep),
) -> StreamingResponse:
    """SSE streaming chat."""
    from app.graphs.main import get_graph
    from app.infra.db.connection import get_pool as _get_pool

    _pool = None
    try:
        _pool = _get_pool()
        thread_id = await _get_or_create_thread(body.threadId, user_id, _pool)
    except RuntimeError:
        thread_id = body.threadId or generate_id(THREAD_PREFIX)

    turn_id = generate_id("turn")
    initial_state = await _build_chat_initial_state(
        thread_id=thread_id,
        user_id=user_id,
        message=body.message,
        client_state=body.clientState,
        turn_id=turn_id,
        pool=_pool,
    )
    configurable: dict[str, object] = {"thread_id": thread_id}
    services: ServiceContainer | None = None
    if _pool:
        from app.infra.db.repositories.thread_repo import PostgresThreadRepository

        services = build_service_container(_pool)
        configurable["services"] = services
        configurable["pool"] = _pool
        configurable["thread_repo"] = PostgresThreadRepository(_pool)
    _cp2 = _get_checkpointer_or_none()
    if _cp2 is not None:
        configurable["checkpointer"] = _cp2
    config: RunnableConfig = {"configurable": configurable}
    recorder = create_resume_trace(
        request_id=getattr(request.state, "request_id", None),
        thread_id=thread_id,
        turn_id=turn_id,
        trigger="chat_stream",
    )
    inject_trace(config, recorder)
    if recorder is not None:
        initial_state["observability_run_id"] = recorder.run_id

    graph = get_graph(_get_checkpointer_or_none())
    await _reject_if_pending_interrupt(graph, config)

    await _persist_message(
        _pool,
        thread_id=thread_id,
        role="user",
        content=body.message,
        turn_id=turn_id,
    )

    async def _stream_with_persistence() -> AsyncGenerator[str, None]:
        assistant_saved = False
        trace_finished = False
        last_completed_content: str = ""
        try:
            async for chunk in stream_graph_events(graph, initial_state, config):
                try:
                    # Chunk format: "event: <name>\ndata: <json>\n\n"
                    data_line = None
                    for line in chunk.splitlines():
                        if line.startswith("data:"):
                            data_line = line[len("data:") :].strip()
                            break
                    if not data_line:
                        yield chunk
                        continue
                    payload = json.loads(data_line)
                    evt = payload.get("event")
                    if evt == "agent.message.completed":
                        last_completed_content = str(payload.get("content") or "")
                    if not assistant_saved and evt == "agent.completed":
                        response = payload.get("response")
                        response = response if isinstance(response, dict) else {}
                        assistant_message = response.get("assistantMessage")
                        assistant_message = (
                            assistant_message if isinstance(assistant_message, dict) else {}
                        )
                        content = str(assistant_message.get("content") or "")
                        interrupt = response.get("interrupt")
                        workspace = response.get("workspace")
                        canvas_message_id = await _persist_resume_canvas_message(
                            _pool,
                            thread_id=thread_id,
                            turn_id=turn_id,
                            workspace=workspace
                            if isinstance(workspace, dict)
                            else initial_state.get("workspace"),
                            interrupt=interrupt if isinstance(interrupt, dict) else None,
                            content=content or "简历草稿已生成，可在画布中查看和编辑。",
                        )
                        if canvas_message_id is None:
                            canvas_message_id = await _persist_message(
                                _pool,
                                thread_id=thread_id,
                                role="assistant",
                                content=content,
                                turn_id=turn_id,
                                metadata={"interrupt": bool(interrupt)},
                            )
                        if canvas_message_id:
                            assistant_message["id"] = canvas_message_id
                            chunk = format_sse(payload)
                        assistant_saved = True
                    elif not assistant_saved and evt == "agent.interrupt":
                        interrupt = payload.get("data")
                        canvas_message_id = await _persist_resume_canvas_message(
                            _pool,
                            thread_id=thread_id,
                            turn_id=turn_id,
                            workspace=initial_state.get("workspace"),
                            interrupt=interrupt if isinstance(interrupt, dict) else None,
                        )
                        if canvas_message_id and isinstance(interrupt, dict):
                            interrupt["canvas_message_id"] = canvas_message_id
                            chunk = format_sse(payload)
                        assistant_saved = True
                    elif not assistant_saved and evt == "agent.failed":
                        err = payload.get("error") or {}
                        await _persist_message(
                            _pool,
                            thread_id=thread_id,
                            role="assistant",
                            content=str(err.get("message") or "Agent failed"),
                            turn_id=turn_id,
                            metadata={"error": True},
                        )
                        assistant_saved = True
                    if not trace_finished and evt in {
                        "agent.completed",
                        "agent.interrupt",
                        "agent.failed",
                    }:
                        status = {
                            "agent.completed": "completed",
                            "agent.interrupt": "interrupted",
                            "agent.failed": "failed",
                        }[evt]
                        await finish_trace_best_effort(
                            recorder,
                            user_id=user_id,
                            service=(
                                services.resume_observability if services is not None else None
                            ),
                            status=cast("Literal['completed', 'interrupted', 'failed']", status),
                            error_code=("graph_stream_failed" if evt == "agent.failed" else None),
                        )
                        trace_finished = True
                except Exception as exc:  # noqa: BLE001
                    logger.warning("SSE persistence hook failed: %s", exc)
                yield chunk
        except GeneratorExit:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("Stream ended with exception for thread %s: %s", thread_id, exc)
        finally:
            if not trace_finished:
                await finish_trace_best_effort(
                    recorder,
                    user_id=user_id,
                    service=services.resume_observability if services is not None else None,
                    status="cancelled",
                    error_code="client_cancelled",
                )
            if not assistant_saved and last_completed_content:
                try:
                    await _persist_message(
                        _pool,
                        thread_id=thread_id,
                        role="assistant",
                        content=last_completed_content,
                        turn_id=turn_id,
                        metadata={"saved_in_finally": True},
                    )
                    logger.info(
                        "Saved assistant message in finally block for thread %s "
                        "(stream ended early)",
                        thread_id,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "Finally-block message persistence failed for thread %s: %s",
                        thread_id,
                        exc,
                    )

    return StreamingResponse(
        _stream_with_persistence(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def _get_checkpointer_or_none() -> object | None:
    try:
        from app.infra.db.checkpointer import get_checkpointer

        return cast("object", get_checkpointer())
    except RuntimeError:
        return None


@router.post("/actions")
async def product_action(
    body: ActionRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool | None = Depends(pool_dep),
) -> JSONResponse:
    """
    Explicit product action endpoint.
    Runs supported product actions through deterministic graph branches.
    """
    payload = body.action.payload_model()
    if isinstance(payload, GenerateResumeFromJdPayload):
        return await _run_generate_resume_from_jd_action(body, payload, request, user_id, pool)
    if isinstance(payload, OptimizeResumeItemPayload):
        return await _run_optimize_resume_item_action(body, payload, request, user_id, pool)
    if isinstance(payload, RewriteExperiencePayload):
        return await _run_rewrite_experience_action(body, payload, request, user_id, pool)
    if isinstance(payload, VariantPayload) and body.action.type == "accept_variant":
        return await _run_accept_variant_action(body, payload, request, user_id, pool)
    if isinstance(payload, VariantPayload) and body.action.type == "show_evidence":
        return await _run_show_evidence_action(body, payload, request, user_id, pool)
    if isinstance(payload, GenerateArtifactPayload):
        return await _run_generate_artifact_action(body, payload, request, user_id, pool)
    if isinstance(payload, ExportResumePayload):
        return await _run_export_resume_action(body, payload, request, user_id, pool)

    raise ValidationError(f"Action '{body.action.type}' is not implemented yet")


@router.post(
    "/actions/stream",
    response_class=StreamingResponse,
    responses=SSE_STREAM_RESPONSES,  # type: ignore[arg-type]
)
async def product_action_stream(
    body: ActionRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool | None = Depends(pool_dep),
) -> StreamingResponse:
    """Stream the long-running JD-to-resume action without changing its graph branch."""
    payload = body.action.payload_model()
    if not isinstance(payload, GenerateResumeFromJdPayload):
        raise ValidationError(
            f"Action '{body.action.type}' does not support streaming"
        )
    return await _run_generate_resume_from_jd_action_stream(
        body,
        payload,
        request,
        user_id,
        pool,
    )


async def _run_generate_resume_from_jd_action(
    body: ActionRequest,
    payload: GenerateResumeFromJdPayload,
    request: Request,
    user_id: str,
    pool: asyncpg.Pool | None,
) -> JSONResponse:
    from app.graphs.main import get_graph

    action_pool = _require_action_pool(pool)
    thread_id, turn_id, workspace, services, graph_config = await _prepare_action_context(
        body, user_id, action_pool
    )
    recorder = create_resume_trace(
        request_id=getattr(request.state, "request_id", None),
        thread_id=thread_id,
        turn_id=turn_id,
        trigger="product_action",
    )
    inject_trace(graph_config, recorder)
    jd = await services.jd.get_jd(user_id, payload.jdId)
    if body.clientState.activeResumeId:
        resume = await services.resume.get_resume(user_id, body.clientState.activeResumeId)
    else:
        title = f"Resume for {jd.target_role or jd.title}"
        resume = await services.resume.create_resume(
            user_id,
            title,
            target_role=jd.target_role,
            jd_id=jd.id,
        )
    workspace["jd_id"] = jd.id
    workspace["resume_id"] = resume.id

    instruction = _resume_generation_user_message(jd.raw_text)
    if body.threadId is None:
        await _set_thread_title(
            action_pool,
            thread_id=thread_id,
            title=_resume_generation_thread_title(
                company=jd.company,
                target_role=jd.target_role,
                jd_title=jd.title,
            ),
        )
        await _persist_message(
            action_pool,
            thread_id=thread_id,
            role="user",
            content=instruction,
            turn_id=turn_id,
            metadata={"source": "jd_match_detail", "jd_id": jd.id},
        )

    initial_state = _build_initial_state(
        thread_id,
        user_id,
        [{"role": "user", "content": instruction, "turn_id": turn_id}],
        workspace,
        turn_id,
    )
    # Keep the existing Product Action response/interrupt contract while the
    # application graph internally delegates resume work to the shared subgraph.
    initial_state["target_subgraph"] = "application_package"
    initial_state["intent_description"] = instruction
    if recorder is not None:
        initial_state["observability_run_id"] = recorder.run_id

    try:
        graph = get_graph(_get_checkpointer_or_none())
        final_state = await graph.ainvoke(initial_state, config=graph_config)
    except Exception as exc:
        await finish_trace_best_effort(
            recorder,
            user_id=user_id,
            service=services.resume_observability,
            status="failed",
            error_code="product_action_failed",
        )
        logger.exception("Generate resume from JD action failed: %s", exc)
        raise ExternalServiceError("Generate resume from JD action failed") from exc

    interrupt_payload = _extract_interrupt_payload(final_state)
    assistant_message = _final_assistant_message(
        final_state,
        "I've generated a resume variant for review.",
    )
    canvas_message_id = await _persist_resume_canvas_message(
        action_pool,
        thread_id=thread_id,
        turn_id=turn_id,
        workspace=workspace,
        interrupt=interrupt_payload,
        content=assistant_message,
    )
    assistant_message_id = canvas_message_id
    if assistant_message_id is None:
        assistant_message_id = await _persist_message(
            action_pool,
            thread_id=thread_id,
            role="assistant",
            content=assistant_message,
            turn_id=turn_id,
            metadata={"interrupt": bool(interrupt_payload)},
        )
    if canvas_message_id and interrupt_payload is not None:
        interrupt_payload["canvas_message_id"] = canvas_message_id
    await finish_trace_best_effort(
        recorder,
        user_id=user_id,
        service=services.resume_observability,
        status="interrupted" if interrupt_payload is not None else "completed",
    )
    return ok(
        _build_response(
            thread_id,
            turn_id,
            assistant_message,
            workspace,
            interrupt_payload,
            assistant_message_id,
        ),
        request,
    )


async def _run_generate_resume_from_jd_action_stream(
    body: ActionRequest,
    payload: GenerateResumeFromJdPayload,
    request: Request,
    user_id: str,
    pool: asyncpg.Pool | None,
) -> StreamingResponse:
    """SSE equivalent of the existing generate_resume_from_jd product action."""
    from app.graphs.main import get_graph

    action_pool = _require_action_pool(pool)
    thread_id, turn_id, workspace, services, graph_config = await _prepare_action_context(
        body,
        user_id,
        action_pool,
    )
    recorder = create_resume_trace(
        request_id=getattr(request.state, "request_id", None),
        thread_id=thread_id,
        turn_id=turn_id,
        trigger="product_action",
    )
    inject_trace(graph_config, recorder)
    jd = await services.jd.get_jd(user_id, payload.jdId)
    if body.clientState.activeResumeId:
        resume = await services.resume.get_resume(user_id, body.clientState.activeResumeId)
    else:
        title = f"Resume for {jd.target_role or jd.title}"
        resume = await services.resume.create_resume(
            user_id,
            title,
            target_role=jd.target_role,
            jd_id=jd.id,
        )
    workspace["jd_id"] = jd.id
    workspace["resume_id"] = resume.id

    instruction = _resume_generation_user_message(jd.raw_text)
    if body.threadId is None:
        await _set_thread_title(
            action_pool,
            thread_id=thread_id,
            title=_resume_generation_thread_title(
                company=jd.company,
                target_role=jd.target_role,
                jd_title=jd.title,
            ),
        )
        await _persist_message(
            action_pool,
            thread_id=thread_id,
            role="user",
            content=instruction,
            turn_id=turn_id,
            metadata={"source": "jd_match_detail", "jd_id": jd.id},
        )

    initial_state = _build_initial_state(
        thread_id,
        user_id,
        [{"role": "user", "content": instruction, "turn_id": turn_id}],
        workspace,
        turn_id,
    )
    initial_state["target_subgraph"] = "application_package"
    initial_state["intent_description"] = instruction
    if recorder is not None:
        initial_state["observability_run_id"] = recorder.run_id

    graph = get_graph(_get_checkpointer_or_none())
    await _reject_if_pending_interrupt(graph, graph_config)

    async def _stream_with_persistence() -> AsyncGenerator[str, None]:
        assistant_saved = False
        trace_finished = False
        try:
            async for chunk in stream_graph_events(graph, initial_state, graph_config):
                try:
                    data_line = next(
                        (
                            line[len("data:") :].strip()
                            for line in chunk.splitlines()
                            if line.startswith("data:")
                        ),
                        None,
                    )
                    if not data_line:
                        yield chunk
                        continue
                    event_payload = json.loads(data_line)
                    event_type = event_payload.get("event")
                    if not assistant_saved and event_type == "agent.completed":
                        response = event_payload.get("response")
                        response = response if isinstance(response, dict) else {}
                        assistant_message = response.get("assistantMessage")
                        assistant_message = (
                            assistant_message if isinstance(assistant_message, dict) else {}
                        )
                        content = str(assistant_message.get("content") or "")
                        interrupt = response.get("interrupt")
                        response_workspace = response.get("workspace")
                        canvas_message_id = await _persist_resume_canvas_message(
                            action_pool,
                            thread_id=thread_id,
                            turn_id=turn_id,
                            workspace=(
                                response_workspace
                                if isinstance(response_workspace, dict)
                                else workspace
                            ),
                            interrupt=interrupt if isinstance(interrupt, dict) else None,
                            content=content or "简历草稿已生成，可在画布中查看和编辑。",
                        )
                        if canvas_message_id is None:
                            canvas_message_id = await _persist_message(
                                action_pool,
                                thread_id=thread_id,
                                role="assistant",
                                content=content,
                                turn_id=turn_id,
                                metadata={"interrupt": bool(interrupt)},
                            )
                        if canvas_message_id:
                            assistant_message["id"] = canvas_message_id
                            chunk = format_sse(event_payload)
                        assistant_saved = True
                    elif not assistant_saved and event_type == "agent.interrupt":
                        interrupt = event_payload.get("data")
                        interrupt_workspace = (
                            interrupt.get("workspace")
                            if isinstance(interrupt, dict)
                            else None
                        )
                        canvas_message_id = await _persist_resume_canvas_message(
                            action_pool,
                            thread_id=thread_id,
                            turn_id=turn_id,
                            workspace=(
                                interrupt_workspace
                                if isinstance(interrupt_workspace, dict)
                                else workspace
                            ),
                            interrupt=interrupt if isinstance(interrupt, dict) else None,
                        )
                        if canvas_message_id and isinstance(interrupt, dict):
                            interrupt["canvas_message_id"] = canvas_message_id
                            chunk = format_sse(event_payload)
                        assistant_saved = True
                    elif not assistant_saved and event_type == "agent.failed":
                        error = event_payload.get("error") or {}
                        await _persist_message(
                            action_pool,
                            thread_id=thread_id,
                            role="assistant",
                            content=str(error.get("message") or "Agent failed"),
                            turn_id=turn_id,
                            metadata={"error": True},
                        )
                        assistant_saved = True

                    if not trace_finished and event_type in {
                        "agent.completed",
                        "agent.interrupt",
                        "agent.failed",
                    }:
                        status = {
                            "agent.completed": "completed",
                            "agent.interrupt": "interrupted",
                            "agent.failed": "failed",
                        }[event_type]
                        await finish_trace_best_effort(
                            recorder,
                            user_id=user_id,
                            service=services.resume_observability,
                            status=cast(
                                "Literal['completed', 'interrupted', 'failed']",
                                status,
                            ),
                            error_code=(
                                "product_action_stream_failed"
                                if event_type == "agent.failed"
                                else None
                            ),
                        )
                        trace_finished = True
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Action SSE persistence hook failed: %s", exc)
                yield chunk
        except GeneratorExit:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Action stream ended with exception for thread %s: %s",
                thread_id,
                exc,
            )
        finally:
            if not trace_finished:
                await finish_trace_best_effort(
                    recorder,
                    user_id=user_id,
                    service=services.resume_observability,
                    status="cancelled",
                    error_code="client_cancelled",
                )

    return StreamingResponse(
        _stream_with_persistence(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


async def _run_optimize_resume_item_action(
    body: ActionRequest,
    payload: OptimizeResumeItemPayload,
    request: Request,
    user_id: str,
    pool: asyncpg.Pool | None,
) -> JSONResponse:
    thread_id, turn_id, workspace, services, _graph_config = await _prepare_action_context(
        body, user_id, pool
    )
    result = await action_capabilities.optimize_resume_item(
        services,
        user_id,
        OptimizeResumeItemInput.model_validate(payload.model_dump()),
        base_workspace=workspace,
    )

    return ok(
        _build_response(
            thread_id,
            turn_id,
            result.message,
            result.workspace,
            result.interrupt,
        ),
        request,
    )


async def _run_rewrite_experience_action(
    body: ActionRequest,
    payload: RewriteExperiencePayload,
    request: Request,
    user_id: str,
    pool: asyncpg.Pool | None,
) -> JSONResponse:
    thread_id, turn_id, workspace, services, _graph_config = await _prepare_action_context(
        body, user_id, pool
    )
    result = await action_capabilities.rewrite_experience(
        services,
        user_id,
        RewriteExperienceInput.model_validate(payload.model_dump()),
        base_workspace=workspace,
    )

    return ok(
        _build_response(
            thread_id,
            turn_id,
            result.message,
            result.workspace,
            result.interrupt,
        ),
        request,
    )


async def _run_accept_variant_action(
    body: ActionRequest,
    payload: VariantPayload,
    request: Request,
    user_id: str,
    pool: asyncpg.Pool | None,
) -> JSONResponse:
    thread_id, turn_id, workspace, services, _graph_config = await _prepare_action_context(
        body, user_id, pool
    )
    result = await action_capabilities.accept_variant(
        services,
        user_id,
        VariantInput(variantId=payload.variantId),
        base_workspace=workspace,
    )
    resume_item_id = result.workspace.get("resume_item_id")
    if isinstance(resume_item_id, str):
        await _mark_resume_canvas_accepted(
            _require_action_pool(pool),
            thread_id=thread_id,
            variant_id=payload.variantId,
            resume_item_id=resume_item_id,
            canvas_message_id=payload.canvasMessageId,
        )

    return ok(
        _build_response(
            thread_id,
            turn_id,
            result.message,
            result.workspace,
            result.interrupt,
        ),
        request,
    )


async def _run_show_evidence_action(
    body: ActionRequest,
    payload: VariantPayload,
    request: Request,
    user_id: str,
    pool: asyncpg.Pool | None,
) -> JSONResponse:
    thread_id, turn_id, workspace, services, _graph_config = await _prepare_action_context(
        body, user_id, pool
    )
    result = await action_capabilities.show_evidence(
        services,
        user_id,
        VariantInput.model_validate(payload.model_dump()),
        base_workspace=workspace,
    )

    return ok(
        _build_response(
            thread_id,
            turn_id,
            result.message,
            result.workspace,
            result.interrupt,
        ),
        request,
    )


async def _run_generate_artifact_action(
    body: ActionRequest,
    payload: GenerateArtifactPayload,
    request: Request,
    user_id: str,
    pool: asyncpg.Pool | None,
) -> JSONResponse:
    thread_id, turn_id, workspace, services, _graph_config = await _prepare_action_context(
        body, user_id, pool
    )
    result = await action_capabilities.generate_artifact(
        services,
        user_id,
        GenerateArtifactInput.model_validate(payload.model_dump()),
        base_workspace=workspace,
    )

    return ok(
        _build_response(
            thread_id,
            turn_id,
            result.message,
            result.workspace,
            result.interrupt,
        ),
        request,
    )


async def _run_export_resume_action(
    body: ActionRequest,
    payload: ExportResumePayload,
    request: Request,
    user_id: str,
    pool: asyncpg.Pool | None,
) -> JSONResponse:
    thread_id, turn_id, workspace, services, _graph_config = await _prepare_action_context(
        body, user_id, pool
    )
    result = await action_capabilities.export_resume(
        services,
        user_id,
        ExportResumeInput.model_validate(payload.model_dump()),
        base_workspace=workspace,
    )
    return ok(
        _build_response(
            thread_id,
            turn_id,
            result.message,
            result.workspace,
            result.interrupt,
        ),
        request,
    )


@router.get("/sidebar")
async def sidebar(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool = Depends(pool_dep),
) -> JSONResponse:
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
                "SELECT id, title, organization FROM experiences WHERE user_id = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT 5",
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

        def _row(record: Mapping[str, object]) -> dict[str, object]:
            return dict(record)

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
