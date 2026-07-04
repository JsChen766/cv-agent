from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel

from app.api.deps import get_current_user_id, get_resume_service
from app.api.response import ok, ok_list
from app.domain.resume.service import ResumeService

router = APIRouter(tags=["resumes"])


class CreateResumeBody(BaseModel):
    title: str
    target_role: str | None = None
    jd_id: str | None = None


class UpdateResumeBody(BaseModel):
    title: str | None = None
    target_role: str | None = None
    jd_id: str | None = None
    status: str | None = None


class AddItemBody(BaseModel):
    section_type: str
    title: str | None = None
    content_snapshot: str = ""
    order_index: int = 0
    source_experience_id: str | None = None


class UpdateItemBody(BaseModel):
    title: str | None = None
    content_snapshot: str | None = None
    order_index: int | None = None
    hidden: bool | None = None
    pinned: bool | None = None


class ReorderBody(BaseModel):
    ordered_ids: list[str]


@router.get("/product/resumes")
async def list_resumes(
    request: Request,
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = Query(None),
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
):
    items, next_cursor = await svc.list_resumes(user_id, limit=limit, cursor=cursor)
    return ok_list([_serialize(r) for r in items], next_cursor, request)


@router.post("/product/resumes", status_code=201)
async def create_resume(
    body: CreateResumeBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
):
    resume = await svc.create_resume(
        user_id, body.title, target_role=body.target_role, jd_id=body.jd_id
    )
    return ok(_serialize(resume), request, status_code=201)


@router.get("/product/resumes/{resume_id}")
async def get_resume(
    resume_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
):
    resume = await svc.get_resume(user_id, resume_id)
    return ok(_serialize_full(resume), request)


@router.patch("/product/resumes/{resume_id}")
async def update_resume(
    resume_id: str,
    body: UpdateResumeBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
):
    patch = body.model_dump(exclude_none=True)
    resume = await svc.update_resume(user_id, resume_id, patch)
    return ok(_serialize(resume), request)


@router.post("/product/resumes/{resume_id}/items", status_code=201)
async def add_item(
    resume_id: str,
    body: AddItemBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
):
    item = await svc.add_item(user_id, resume_id, body.model_dump())
    return ok(_serialize_item(item), request, status_code=201)


@router.patch("/product/resume-items/{item_id}")
async def update_item(
    item_id: str,
    body: UpdateItemBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
):
    # We don't verify resume_id ownership again here — item_id is sufficient
    # In production add a lookup to confirm item belongs to user's resume
    patch = body.model_dump(exclude_none=True)
    item = await svc.update_item(user_id, "any", item_id, patch)
    return ok(_serialize_item(item), request)


@router.delete("/product/resume-items/{item_id}")
async def delete_item(
    item_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
):
    await svc.delete_item(user_id, "any", item_id)
    return ok({"deleted": True}, request)


@router.post("/product/resumes/{resume_id}/reorder")
async def reorder_items(
    resume_id: str,
    body: ReorderBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
):
    items = await svc.reorder_items(user_id, resume_id, body.ordered_ids)
    return ok([_serialize_item(i) for i in items], request)


# ── Serialisers ───────────────────────────────────────────────────────────────

def _serialize(r) -> dict:
    return {
        "id": r.id,
        "title": r.title,
        "targetRole": r.target_role,
        "jdId": r.jd_id,
        "status": r.status,
        "createdAt": r.created_at.isoformat(),
        "updatedAt": r.updated_at.isoformat(),
    }


def _serialize_full(r) -> dict:
    d = _serialize(r)
    d["items"] = [_serialize_item(i) for i in r.items]
    d["variants"] = [_serialize_variant(v) for v in r.variants]
    return d


def _serialize_item(i) -> dict:
    return {
        "id": i.id,
        "resumeId": i.resume_id,
        "sectionType": i.section_type,
        "title": i.title,
        "contentSnapshot": i.content_snapshot,
        "orderIndex": i.order_index,
        "hidden": i.hidden,
        "pinned": i.pinned,
        "sourceExperienceId": i.source_experience_id,
        "updatedAt": i.updated_at.isoformat(),
    }


def _serialize_variant(v) -> dict:
    return {
        "id": v.id,
        "title": v.title,
        "content": v.content,
        "score": {
            "overall": v.score.overall,
            "relevance": v.score.relevance,
            "clarity": v.score.clarity,
            "evidenceStrength": v.score.evidence_strength,
            "quantifiedImpact": v.score.quantified_impact,
        },
        "evidenceSummary": [
            {
                "requirementId": e.requirement_id,
                "requirementText": e.requirement_text,
                "supportingClaims": e.supporting_claims,
                "matchScore": e.match_score,
            }
            for e in v.evidence_summary
        ],
        "riskSummary": [
            {"type": r.type, "text": r.text, "severity": r.severity}
            for r in v.risk_summary
        ],
        "missingInfo": v.missing_info,
        "createdAt": v.created_at.isoformat(),
    }
