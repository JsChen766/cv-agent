"""
Workspace builder — resolves the active workspace context for a copilot turn.

The client can optionally pass workspace hints (jd_id, resume_id, etc.);
we validate they exist and the requesting user owns them, then return a
clean ActiveWorkspace dict to attach to the graph state.
"""

from __future__ import annotations

from typing import Any

from app.core.errors import ForbiddenError, NotFoundError
from app.memory.thread_state import ActiveWorkspace


async def build_workspace(
    user_id: str,
    hints: dict[str, Any],
    pool,
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

    if jd_id := hints.get("jd_id"):
        workspace["jd_id"] = await _validate_owned(pool, "jd_records", jd_id, user_id, "JD")

    if resume_id := hints.get("resume_id"):
        workspace["resume_id"] = await _validate_owned(pool, "resumes", resume_id, user_id, "Resume")

    if artifact_id := hints.get("artifact_id"):
        workspace["artifact_id"] = await _validate_owned(
            pool, "artifacts", artifact_id, user_id, "Artifact"
        )

    if exp_ids := hints.get("experience_ids"):
        validated = []
        for eid in exp_ids:
            validated.append(await _validate_owned(pool, "experiences", eid, user_id, "Experience"))
        workspace["experience_ids"] = validated

    return workspace


async def _validate_owned(pool, table: str, record_id: str, user_id: str, label: str) -> str:
    """Check record exists and belongs to user_id. Returns record_id."""
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
