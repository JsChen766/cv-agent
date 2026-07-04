from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel

from app.api.deps import get_current_user_id, get_jd_service
from app.api.response import ok, ok_list
from app.domain.jd.service import JdService

router = APIRouter(tags=["jd"])


class CreateJdBody(BaseModel):
    title: str
    raw_text: str
    company: str | None = None
    target_role: str | None = None
    # requirements may be supplied directly (e.g. from frontend parse);
    # Phase 6+ will use LLM extraction
    requirements: list[dict] | None = None


@router.get("/product/jds")
async def list_jds(
    request: Request,
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = Query(None),
    user_id: str = Depends(get_current_user_id),
    svc: JdService = Depends(get_jd_service),
):
    items, next_cursor = await svc.list_jds(user_id, limit=limit, cursor=cursor)
    return ok_list([_serialize(j) for j in items], next_cursor, request)


@router.post("/product/jds", status_code=201)
async def create_jd(
    body: CreateJdBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: JdService = Depends(get_jd_service),
):
    jd = await svc.create_jd(
        user_id,
        title=body.title,
        raw_text=body.raw_text,
        company=body.company,
        target_role=body.target_role,
        requirements=body.requirements,
    )
    return ok(_serialize(jd), request, status_code=201)


@router.get("/product/jds/{jd_id}")
async def get_jd(
    jd_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: JdService = Depends(get_jd_service),
):
    jd = await svc.get_jd(user_id, jd_id)
    return ok(_serialize(jd), request)


@router.delete("/product/jds/{jd_id}")
async def delete_jd(
    jd_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: JdService = Depends(get_jd_service),
):
    await svc.delete_jd(user_id, jd_id)
    return ok({"deleted": True}, request)


def _serialize(jd) -> dict:
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
            }
            for r in jd.requirements
        ],
        "createdAt": jd.created_at.isoformat(),
        "updatedAt": jd.updated_at.isoformat(),
    }
