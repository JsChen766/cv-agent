from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field

from app.api.deps import (
    get_current_user_id,
    get_experience_service,
)
from app.api.response import ok, ok_list
from app.api.schemas import StrictRequestModel
from app.core.types import ExperienceCategory
from app.domain.experience.models import (
    Experience,
    ExperiencePatch,
    ExperienceRevision,
    ImportCandidate,
    ImportCandidateDraft,
)
from app.domain.experience.service import ExperienceService

router = APIRouter(tags=["experiences"])


# ── Request bodies ────────────────────────────────────────────────────────────


class CreateExperienceBody(StrictRequestModel):
    category: ExperienceCategory
    title: str = Field(min_length=1)
    content: str = Field(min_length=1)
    organization: str | None = None
    role: str | None = None
    location: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    tags: list[str] = Field(default_factory=list)


class UpdateExperienceBody(StrictRequestModel):
    title: str | None = None
    organization: str | None = None
    role: str | None = None
    location: str | None = None
    category: ExperienceCategory | None = None
    start_date: str | None = None
    end_date: str | None = None
    tags: list[str] | None = None

    def to_patch(self) -> ExperiencePatch:
        return ExperiencePatch(
            title=self.title,
            organization=self.organization,
            role=self.role,
            location=self.location,
            category=self.category,
            start_date=self.start_date,
            end_date=self.end_date,
            tags=self.tags,
        )


class AddRevisionBody(StrictRequestModel):
    content: str = Field(min_length=1)
    source: str = Field(default="manual", min_length=1)


class ImportCandidateBody(StrictRequestModel):
    category: ExperienceCategory
    title: str = Field(min_length=1)
    content: str = Field(min_length=1)
    organization: str | None = None
    role: str | None = None
    location: str | None = None

    def to_domain(self) -> ImportCandidateDraft:
        return ImportCandidateDraft(
            category=self.category,
            title=self.title,
            content=self.content,
            organization=self.organization,
            role=self.role,
            location=self.location,
        )


class ImportTextBody(StrictRequestModel):
    raw_text: str = Field(min_length=1)
    candidates: list[ImportCandidateBody] = Field(default_factory=list)


# ── Routes ────────────────────────────────────────────────────────────────────


@router.get("/product/experiences")
async def list_experiences(
    request: Request,
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = Query(None),
    category: ExperienceCategory | None = Query(None),
    tags: list[str] | None = Query(default=None),
    q: str | None = Query(None),
    user_id: str = Depends(get_current_user_id),
    svc: ExperienceService = Depends(get_experience_service),
) -> JSONResponse:
    items, next_cursor = await svc.list_experiences(
        user_id,
        limit=limit,
        cursor=cursor,
        category=category,
        tags=tags,
        q=q,
    )
    return ok_list(
        [_serialize_exp(e) for e in items],
        next_cursor,
        request,
    )


@router.post("/product/experiences", status_code=201)
async def create_experience(
    body: CreateExperienceBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ExperienceService = Depends(get_experience_service),
) -> JSONResponse:
    exp = await svc.create_experience(
        user_id,
        category=body.category,
        title=body.title,
        content=body.content,
        organization=body.organization,
        role=body.role,
        location=body.location,
        start_date=body.start_date,
        end_date=body.end_date,
        tags=body.tags,
    )
    return ok(_serialize_exp(exp), request, status_code=201)


@router.get("/product/experiences/{experience_id}")
async def get_experience(
    experience_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ExperienceService = Depends(get_experience_service),
) -> JSONResponse:
    exp = await svc.get_experience(user_id, experience_id)
    revisions = await svc.get_revisions(user_id, experience_id)
    data = _serialize_exp(exp)
    data["revisions"] = [_serialize_rev(r) for r in revisions]
    return ok(data, request)


@router.patch("/product/experiences/{experience_id}")
async def update_experience(
    experience_id: str,
    body: UpdateExperienceBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ExperienceService = Depends(get_experience_service),
) -> JSONResponse:
    exp = await svc.update_experience_meta(user_id, experience_id, body.to_patch())
    return ok(_serialize_exp(exp), request)


@router.delete("/product/experiences/{experience_id}", status_code=200)
async def archive_experience(
    experience_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ExperienceService = Depends(get_experience_service),
) -> JSONResponse:
    await svc.archive_experience(user_id, experience_id)
    return ok({"archived": True}, request)


@router.post("/product/experiences/{experience_id}/revisions", status_code=201)
async def add_revision(
    experience_id: str,
    body: AddRevisionBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ExperienceService = Depends(get_experience_service),
) -> JSONResponse:
    rev = await svc.add_revision(user_id, experience_id, body.content, body.source)
    return ok(_serialize_rev(rev), request, status_code=201)


# ── Import ────────────────────────────────────────────────────────────────────


@router.post("/product/import/text", status_code=201)
async def import_from_text(
    body: ImportTextBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ExperienceService = Depends(get_experience_service),
) -> JSONResponse:
    """
    Phase 5 version: caller must supply pre-parsed candidates.
    Phase 11 will wire this through the LangGraph experience_import subgraph.
    """
    job, candidates = await svc.start_import_from_text(
        user_id,
        body.raw_text,
        [candidate.to_domain() for candidate in body.candidates],
    )
    return ok(
        {
            "jobId": job.id,
            "candidates": [_serialize_candidate(c) for c in candidates],
        },
        request,
        status_code=201,
    )


@router.post("/product/import-candidates/{candidate_id}/accept", status_code=201)
async def accept_candidate(
    candidate_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ExperienceService = Depends(get_experience_service),
) -> JSONResponse:
    exp = await svc.accept_candidate(user_id, candidate_id)
    return ok(_serialize_exp(exp), request, status_code=201)


@router.post("/product/import-candidates/{candidate_id}/reject")
async def reject_candidate(
    candidate_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: ExperienceService = Depends(get_experience_service),
) -> JSONResponse:
    await svc.reject_candidate(user_id, candidate_id)
    return ok({"rejected": True}, request)


# ── Serialisers ───────────────────────────────────────────────────────────────


def _serialize_exp(exp: Experience) -> dict[str, object]:
    data: dict[str, object] = {
        "id": exp.id,
        "category": exp.category,
        "title": exp.title,
        "organization": exp.organization,
        "role": exp.role,
        "location": exp.location,
        "startDate": str(exp.start_date) if exp.start_date else None,
        "endDate": str(exp.end_date) if exp.end_date else None,
        "tags": exp.tags,
        "status": exp.status,
        "currentRevisionId": exp.current_revision_id,
        "createdAt": exp.created_at.isoformat(),
        "updatedAt": exp.updated_at.isoformat(),
    }
    if exp.current_revision:
        data["currentRevision"] = _serialize_rev(exp.current_revision)
    return data


def _serialize_rev(rev: ExperienceRevision) -> dict[str, object]:
    return {
        "id": rev.id,
        "experienceId": rev.experience_id,
        "content": rev.content,
        "source": rev.source,
        "revisionHash": rev.revision_hash,
        "factBankStatus": rev.factbank_status,
        "createdAt": rev.created_at.isoformat(),
    }


def _serialize_candidate(c: ImportCandidate) -> dict[str, object]:
    return {
        "id": c.id,
        "category": c.category,
        "title": c.title,
        "organization": c.organization,
        "role": c.role,
        "location": c.location,
        "content": c.content,
        "status": c.status,
    }
