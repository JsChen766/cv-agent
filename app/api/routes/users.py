from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from app.api.deps import (
    get_current_user_id,
    get_preference_service,
    get_user_service,
)
from app.api.response import ok
from app.domain.preference.service import PreferenceService
from app.domain.user.service import UserService

router = APIRouter(tags=["users"])


class UpdateProfileBody(BaseModel):
    full_name: str | None = None
    phone: str | None = None
    location: str | None = None
    linkedin_url: str | None = None
    github_url: str | None = None
    personal_website: str | None = None
    current_title: str | None = None
    current_company: str | None = None
    years_of_experience: int | None = None
    career_stage: str | None = None
    target_roles: list[str] | None = None
    target_industries: list[str] | None = None
    target_locations: list[str] | None = None
    preferred_language: str | None = None
    resume_style: str | None = None


class AddPreferenceBody(BaseModel):
    rule: str
    category: str
    scope: str = "global"


@router.get("/users/me/profile")
async def get_profile(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: UserService = Depends(get_user_service),
):
    profile = await svc.get_profile(user_id)
    return ok(_serialize_profile(profile), request)


@router.patch("/users/me/profile")
async def update_profile(
    body: UpdateProfileBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: UserService = Depends(get_user_service),
):
    patch = body.model_dump(exclude_none=True)
    profile = await svc.update_profile(user_id, patch)
    return ok(_serialize_profile(profile), request)


@router.get("/users/me/preferences")
async def list_preferences(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: PreferenceService = Depends(get_preference_service),
):
    prefs = await svc.get_active_preferences(user_id)
    return ok([_serialize_pref(p) for p in prefs], request)


@router.post("/users/me/preferences", status_code=201)
async def add_preference(
    body: AddPreferenceBody,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: PreferenceService = Depends(get_preference_service),
):
    pref = await svc.add_explicit_preference(
        user_id, rule=body.rule, category=body.category, scope=body.scope
    )
    return ok(_serialize_pref(pref), request, status_code=201)


@router.delete("/users/me/preferences/{preference_id}")
async def delete_preference(
    preference_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    svc: PreferenceService = Depends(get_preference_service),
):
    await svc.delete_preference(user_id, preference_id)
    return ok({"deleted": True}, request)


def _serialize_profile(p) -> dict:
    return {
        "fullName": p.full_name,
        "email": p.email,
        "phone": p.phone,
        "location": p.location,
        "linkedinUrl": p.linkedin_url,
        "githubUrl": p.github_url,
        "personalWebsite": p.personal_website,
        "currentTitle": p.current_title,
        "currentCompany": p.current_company,
        "yearsOfExperience": p.years_of_experience,
        "careerStage": p.career_stage,
        "targetRoles": p.target_roles,
        "targetIndustries": p.target_industries,
        "targetLocations": p.target_locations,
        "preferredLanguage": p.preferred_language,
        "resumeStyle": p.resume_style,
    }


def _serialize_pref(p) -> dict:
    return {
        "id": p.id,
        "rule": p.rule,
        "category": p.category,
        "source": p.source,
        "priority": p.priority,
        "confidence": p.confidence,
        "reinforcementCount": p.reinforcement_count,
        "scope": p.scope,
        "createdAt": p.created_at.isoformat(),
        "lastReinforcedAt": p.last_reinforced_at.isoformat(),
    }
