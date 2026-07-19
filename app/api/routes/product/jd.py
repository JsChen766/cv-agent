from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field

from app.api.deps import get_current_user_id, get_jd_service
from app.api.response import ok, ok_list
from app.api.schemas import StrictRequestModel
from app.domain.jd.models import JdRecord, JdRequirementDraft, JdRequirementImportance
from app.domain.jd.service import JdService

router = APIRouter(tags=["jd"])


class JdRequirementBody(StrictRequestModel):
    id: str | None = None
    text: str = Field(min_length=1)
    category: str = Field(default="skill", min_length=1)
    importance: JdRequirementImportance = "medium"
    keywords: tuple[str, ...] = ()
    weight: float | None = Field(default=None, ge=0.0, le=1.0)
    v2_importance: Literal["must_have", "preferred", "optional"] | None = None

    def to_draft(self) -> JdRequirementDraft:
        return JdRequirementDraft(
            id=self.id,
            text=self.text,
            category=self.category,
            importance=self.importance,
            keywords=self.keywords,
            weight=self.weight,
            v2_importance=self.v2_importance,
        )


class CreateJdBody(StrictRequestModel):
    title: str = Field(min_length=1)
    raw_text: str = Field(min_length=1)
    company: str | None = None
    target_role: str | None = None
    # requirements may be supplied directly (e.g. from frontend parse);
    # Phase 6+ will use LLM extraction
    requirements: list[JdRequirementBody] = Field(default_factory=list)


@router.get("/product/jds")
async def list_jds(
    request: Request,
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = Query(None),
    user_id: str = Depends(get_current_user_id),
    svc: JdService = Depends(get_jd_service),
) -> JSONResponse:
    items, next_cursor = await svc.list_jds(user_id, limit=limit, cursor=cursor)
    return ok_list([_serialize(j) for j in items], next_cursor, request)


@router.post("/product/jds", status_code=201)
async def create_jd(
    body: CreateJdBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: JdService = Depends(get_jd_service),
) -> JSONResponse:
    jd = await svc.create_jd(
        user_id,
        title=body.title,
        raw_text=body.raw_text,
        company=body.company,
        target_role=body.target_role,
        requirements=[r.to_draft() for r in body.requirements] if body.requirements else None,
    )
    return ok(_serialize(jd), request, status_code=201)


@router.get("/product/jds/{jd_id}")
async def get_jd(
    jd_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: JdService = Depends(get_jd_service),
) -> JSONResponse:
    jd = await svc.get_jd(user_id, jd_id)
    return ok(_serialize(jd), request)


@router.delete("/product/jds/{jd_id}")
async def delete_jd(
    jd_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: JdService = Depends(get_jd_service),
) -> JSONResponse:
    await svc.delete_jd(user_id, jd_id)
    return ok({"deleted": True}, request)


def _serialize(jd: JdRecord) -> dict[str, object]:
    return {
        "id": jd.id,
        "title": jd.title,
        "company": jd.company,
        "targetRole": jd.target_role,
        "rawText": jd.raw_text,
        "requirements": [
            {
                "id": r.id,
                "text": r.text,
                "category": r.category,
                "importance": r.importance,
                "keywords": list(r.keywords),
                "weight": r.weight,
                "v2Importance": r.v2_importance,
            }
            for r in jd.requirements
        ],
        "jdHash": jd.jd_hash,
        "requirementMapId": jd.requirement_map_id,
        "requirementsOrigin": jd.requirements_origin,
        "sourceThreadId": jd.source_thread_id,
        "createdAt": jd.created_at.isoformat(),
        "updatedAt": jd.updated_at.isoformat(),
    }
