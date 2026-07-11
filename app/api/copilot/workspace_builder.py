"""
Workspace builder — resolves the active workspace context for a copilot turn.

The client can optionally pass workspace hints (jd_id, resume_id, etc.);
we validate they exist and the requesting user owns them, then return a
clean ActiveWorkspace dict to attach to the graph state.
"""

from __future__ import annotations

from collections.abc import Mapping

import asyncpg

from app.core.errors import ForbiddenError, NotFoundError, ValidationError
from app.memory.thread_state import ActiveWorkspace


async def build_workspace(
    user_id: str,
    hints: Mapping[str, object],
    pool: asyncpg.Pool,
) -> ActiveWorkspace:
    """
    Validate workspace hints and return a clean ActiveWorkspace.

    hints may contain:
      - jd_id: str
      - resume_id: str
      - artifact_id: str
      - experience_ids: list[str]
    """
    workspace: ActiveWorkspace = {}

    jd_id = hints.get("jd_id")
    if isinstance(jd_id, str):
        workspace["jd_id"] = await _validate_owned(pool, "jd_records", jd_id, user_id, "JD")

    resume_id = hints.get("resume_id")
    if isinstance(resume_id, str):
        workspace["resume_id"] = await _validate_owned(pool, "resumes", resume_id, user_id, "Resume")

    artifact_id = hints.get("artifact_id")
    if isinstance(artifact_id, str):
        workspace["artifact_id"] = await _validate_owned(
            pool, "artifacts", artifact_id, user_id, "Artifact"
        )

    exp_ids = hints.get("experience_ids")
    if isinstance(exp_ids, list):
        validated: list[str] = []
        for eid in exp_ids:
            if isinstance(eid, str):
                validated.append(await _validate_owned(pool, "experiences", eid, user_id, "Experience"))
        workspace["experience_ids"] = validated

    return workspace


async def _validate_owned(
    pool: asyncpg.Pool, table: str, record_id: str, user_id: str, label: str
) -> str:
    """Check record exists and belongs to user_id. Returns record_id."""
    allowed_tables = {"jd_records", "resumes", "artifacts", "experiences"}
    if table not in allowed_tables:
        raise ValidationError(f"Unsupported workspace resource: {table}")
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT user_id FROM {table} WHERE id = $1",  # noqa: S608
            record_id,
        )
    if not row:
        raise NotFoundError(f"{label} '{record_id}' not found")
    if row["user_id"] != user_id:
        raise ForbiddenError(f"You do not own {label} '{record_id}'")
    return record_id
