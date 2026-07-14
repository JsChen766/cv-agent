from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import Field

from app.api.auth_utils import (
    create_access_token,
    decode_access_token,
    hash_token,
    token_expiry,
    validate_password_strength,
)
from app.api.deps import (
    _extract_token,
    get_current_session_id,
    get_current_user,
    get_current_user_id,
    get_user_service,
)
from app.core.errors import UnauthorizedError
from app.api.response import ok
from app.api.schemas import StrictRequestModel
from app.domain.user.models import User
from app.domain.user.service import UserService

router = APIRouter(tags=["auth"])


def _set_access_cookie(response: JSONResponse, token: str) -> None:
    from app.core.config import settings

    response.set_cookie(
        "access_token",
        token,
        httponly=True,
        secure=settings.environment == "production",
        samesite="lax",
        max_age=settings.access_token_expire_minutes * 60,
        path="/",
    )


async def _issue_session(svc: UserService, user_id: str) -> str:
    """Mint a JWT bound to a new user_sessions row and return the token string."""
    session_id = str(uuid.uuid4())
    token = create_access_token(user_id, session_id=session_id)
    await svc.create_session(
        session_id=session_id,
        user_id=user_id,
        token_hash=hash_token(token),
        expires_at=token_expiry(),
    )
    return token


class LoginRequest(StrictRequestModel):
    email: str = Field(min_length=1)
    password: str = Field(min_length=1)


class RegisterRequest(StrictRequestModel):
    email: str = Field(min_length=1)
    password: str = Field(min_length=1)


class ChangePasswordRequest(StrictRequestModel):
    current_password: str = Field(min_length=1)
    new_password: str = Field(min_length=1)


@router.post("/auth/register")
async def register(
    body: RegisterRequest,
    request: Request,
    svc: UserService = Depends(get_user_service),
) -> JSONResponse:
    validate_password_strength(body.password)
    user = await svc.register(body.email, body.password)
    token = await _issue_session(svc, user.id)
    response = ok({"userId": user.id, "email": user.email}, request, status_code=201)
    _set_access_cookie(response, token)
    return response


@router.post("/auth/login")
async def login(
    body: LoginRequest,
    request: Request,
    svc: UserService = Depends(get_user_service),
) -> JSONResponse:
    user = await svc.authenticate(body.email, body.password)
    token = await _issue_session(svc, user.id)
    resp = ok({"userId": user.id, "email": user.email}, request)
    _set_access_cookie(resp, token)
    return resp


@router.post("/auth/logout")
async def logout(
    request: Request,
    token: str | None = Depends(_extract_token),
    svc: UserService = Depends(get_user_service),
) -> JSONResponse:
    """Best-effort logout — clears cookie even if the token is already invalid.

    We deliberately do NOT enforce a valid session here so users can always
    escape a bad-state cookie (e.g. revoked-elsewhere token) without needing
    to re-authenticate first.
    """
    if token is not None:
        try:
            user_id, session_id = decode_access_token(token)
        except UnauthorizedError:
            user_id, session_id = None, None
        if user_id and session_id:
            await svc.delete_session(session_id, user_id)
    resp = ok({"message": "Logged out"}, request)
    resp.delete_cookie("access_token", path="/")
    return resp


@router.post("/auth/logout-everywhere")
async def logout_everywhere(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    session_id: str | None = Depends(get_current_session_id),
    svc: UserService = Depends(get_user_service),
) -> JSONResponse:
    """Revoke every session for the current user (including this one).

    After the call succeeds the caller's cookie is cleared as well.
    """
    revoked = await svc.delete_all_sessions(user_id)
    resp = ok({"message": "All sessions revoked", "revoked": revoked}, request)
    resp.delete_cookie("access_token", path="/")
    return resp


@router.post("/auth/change-password")
async def change_password(
    body: ChangePasswordRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    session_id: str | None = Depends(get_current_session_id),
    svc: UserService = Depends(get_user_service),
) -> JSONResponse:
    """Rotate the user's password and revoke every OTHER session.

    The current session is preserved so the caller stays logged in; all other
    devices are forcibly signed out.
    """
    validate_password_strength(body.new_password)
    await svc.change_password(user_id, body.current_password, body.new_password)
    revoked = await svc.delete_all_sessions(user_id, except_session_id=session_id)
    return ok(
        {"message": "Password updated", "revoked_other_sessions": revoked},
        request,
    )


@router.get("/users/me")
async def me(request: Request, user: User = Depends(get_current_user)) -> JSONResponse:
    return ok({"id": user.id, "email": user.email}, request)
