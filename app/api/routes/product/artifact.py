from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field

from app.api.deps import get_artifact_service, get_current_user_id, get_preference_service
from app.api.response import ok, ok_list
from app.api.schemas import StrictRequestModel
from app.core.types import ArtifactType
from app.domain.artifact.models import Artifact
from app.domain.artifact.service import ArtifactService
from app.domain.preference.service import PreferenceService

router = APIRouter(tags=["artifacts"])


class UpdateArtifactBody(StrictRequestModel):
    title: str | None = Field(default=None, min_length=1)
    content: str | None = Field(default=None, min_length=1)


@router.get("/product/artifacts")
async def list_artifacts(
    request: Request,
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = Query(None),
    type: ArtifactType | None = Query(None),
    user_id: str = Depends(get_current_user_id),
    svc: ArtifactService = Depends(get_artifact_service),
) -> JSONResponse:
    items, next_cursor = await svc.list_artifacts(
        user_id, limit=limit, cursor=cursor, type=type
    )
    return ok_list([_serialize(a) for a in items], next_cursor, request)


@router.get("/product/artifacts/{artifact_id}")
async def get_artifact(
    artifact_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ArtifactService = Depends(get_artifact_service),
) -> JSONResponse:
    artifact = await svc.get_artifact(user_id, artifact_id)
    return ok(_serialize(artifact), request)


@router.patch("/product/artifacts/{artifact_id}")
async def update_artifact(
    artifact_id: str,
    body: UpdateArtifactBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ArtifactService = Depends(get_artifact_service),
    pref_svc: PreferenceService = Depends(get_preference_service),
) -> JSONResponse:
    old = await svc.get_artifact(user_id, artifact_id)
    patch: dict[str, object] = body.model_dump(exclude_none=True)
    artifact = await svc.update_artifact(user_id, artifact_id, patch)

    # Record edit diff signal for PreferenceBank
    content = patch.get("content")
    if isinstance(content, str) and old.content != content:
        await pref_svc.record_signal(
            user_id,
            signal_type="edit_diff",
            raw_content=f"BEFORE:\n{old.content[:500]}\n\nAFTER:\n{content[:500]}",
            context={"artifact_id": artifact_id, "artifact_type": artifact.type},
        )

    return ok(_serialize(artifact), request)


@router.delete("/product/artifacts/{artifact_id}")
async def delete_artifact(
    artifact_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ArtifactService = Depends(get_artifact_service),
) -> JSONResponse:
    await svc.delete_artifact(user_id, artifact_id)
    return ok({"deleted": True}, request)


def _serialize(a: Artifact) -> dict[str, object]:
    return {
        "id": a.id,
        "type": a.type,
        "title": a.title,
        "content": a.content,
        "structured": a.structured,
        "wordCount": a.word_count,
        "sourceJdId": a.source_jd_id,
        "sourceExperienceIds": a.source_experience_ids,
        "createdAt": a.created_at.isoformat(),
        "updatedAt": a.updated_at.isoformat(),
    }
