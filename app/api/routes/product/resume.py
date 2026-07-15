from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field

from app.api.deps import get_current_user_id, get_resume_service
from app.api.response import ok, ok_list
from app.api.schemas import StrictRequestModel
from app.core.errors import ValidationError
from app.domain.resume.models import (
    Resume,
    ResumeItem,
    ResumeItemCreate,
    ResumeItemPatch,
    ResumePatch,
    ResumeSectionType,
    ResumeStatus,
    ResumeVariant,
)
from app.domain.resume.service import ResumeService

router = APIRouter(tags=["resumes"])


class CreateResumeBody(StrictRequestModel):
    title: str = Field(min_length=1)
    target_role: str | None = None
    jd_id: str | None = None


class UpdateResumeBody(StrictRequestModel):
    title: str | None = None
    target_role: str | None = None
    jd_id: str | None = None
    status: ResumeStatus | None = None

    def to_patch(self) -> ResumePatch:
        return ResumePatch(
            title=self.title,
            target_role=self.target_role,
            jd_id=self.jd_id,
            status=self.status,
        )


class AddItemBody(StrictRequestModel):
    section_type: ResumeSectionType
    title: str | None = None
    content_snapshot: str = ""
    order_index: int = Field(default=0, ge=0)
    source_experience_id: str | None = None

    def to_create(self) -> ResumeItemCreate:
        return ResumeItemCreate(
            section_type=self.section_type,
            title=self.title,
            content_snapshot=self.content_snapshot,
            order_index=self.order_index,
            source_experience_id=self.source_experience_id,
        )


class UpdateItemBody(StrictRequestModel):
    title: str | None = None
    content_snapshot: str | None = None
    order_index: int | None = Field(default=None, ge=0)
    hidden: bool | None = None
    pinned: bool | None = None

    def to_patch(self) -> ResumeItemPatch:
        return ResumeItemPatch(
            title=self.title,
            content_snapshot=self.content_snapshot,
            order_index=self.order_index,
            hidden=self.hidden,
            pinned=self.pinned,
        )


class ReorderBody(StrictRequestModel):
    ordered_ids: list[str] = Field(min_length=1)


class PatchStructuredBody(StrictRequestModel):
    operations: list[dict] = Field(min_length=1)


@router.get("/product/resumes")
async def list_resumes(
    request: Request,
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = Query(None),
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
) -> JSONResponse:
    items, next_cursor = await svc.list_resumes(user_id, limit=limit, cursor=cursor)
    return ok_list([_serialize(r) for r in items], next_cursor, request)


@router.post("/product/resumes", status_code=201)
async def create_resume(
    body: CreateResumeBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
) -> JSONResponse:
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
) -> JSONResponse:
    resume = await svc.get_resume(user_id, resume_id)
    return ok(_serialize_full(resume), request)


@router.patch("/product/resumes/{resume_id}")
async def update_resume(
    resume_id: str,
    body: UpdateResumeBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
) -> JSONResponse:
    resume = await svc.update_resume(user_id, resume_id, body.to_patch())
    return ok(_serialize(resume), request)


@router.post("/product/resumes/{resume_id}/items", status_code=201)
async def add_item(
    resume_id: str,
    body: AddItemBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
) -> JSONResponse:
    item = await svc.add_item(user_id, resume_id, body.to_create())
    return ok(_serialize_item(item), request, status_code=201)


@router.patch("/product/resume-items/{item_id}")
async def update_item(
    item_id: str,
    body: UpdateItemBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
) -> JSONResponse:
    item = await svc.update_item_by_id(user_id, item_id, body.to_patch())
    return ok(_serialize_item(item), request)


@router.delete("/product/resume-items/{item_id}")
async def delete_item(
    item_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
) -> JSONResponse:
    await svc.delete_item_by_id(user_id, item_id)
    return ok({"deleted": True}, request)


@router.post("/product/resumes/{resume_id}/reorder")
async def reorder_items(
    resume_id: str,
    body: ReorderBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
) -> JSONResponse:
    items = await svc.reorder_items(user_id, resume_id, body.ordered_ids)
    return ok([_serialize_item(i) for i in items], request)


@router.patch("/product/resumes/{resume_id}/variants/{variant_id}/structured")
async def patch_variant_structured(
    resume_id: str,
    variant_id: str,
    body: PatchStructuredBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ResumeService = Depends(get_resume_service),
) -> JSONResponse:
    try:
        variant = await svc.patch_variant(user_id, variant_id, body.operations)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    return ok(
        {
            "variantId": variant.id,
            "structured": variant.structured,
            "content": variant.content,
            "version": variant.version,
            "parentVariantId": variant.parent_variant_id,
        },
        request,
    )


# ── Serialisers ───────────────────────────────────────────────────────────────

def _serialize(r: Resume) -> dict[str, object]:
    return {
        "id": r.id,
        "title": r.title,
        "targetRole": r.target_role,
        "jdId": r.jd_id,
        "status": r.status,
        "createdAt": r.created_at.isoformat(),
        "updatedAt": r.updated_at.isoformat(),
    }


def _serialize_full(r: Resume) -> dict[str, object]:
    d = _serialize(r)
    d["items"] = [_serialize_item(i) for i in r.items]
    d["variants"] = [_serialize_variant(v) for v in r.variants]
    return d


def _serialize_item(i: ResumeItem) -> dict[str, object]:
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


def _serialize_variant(v: ResumeVariant) -> dict[str, object]:
    return {
        "id": v.id,
        "title": v.title,
        "content": v.content,
        "parentVariantId": v.parent_variant_id,
        "version": v.version,
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
