from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from pydantic import Field

from app.api.auth_utils import create_access_token
from app.api.deps import get_current_user, get_user_service
from app.api.response import ok
from app.api.schemas import StrictRequestModel
from app.domain.user.models import User
from app.domain.user.service import UserService

router = APIRouter(tags=["auth"])


class LoginRequest(StrictRequestModel):
    email: str = Field(min_length=1)
    password: str = Field(min_length=1)


class RegisterRequest(StrictRequestModel):
    email: str = Field(min_length=1)
    password: str = Field(min_length=1)


@router.post("/auth/register")
async def register(
    body: RegisterRequest,
    request: Request,
    svc: UserService = Depends(get_user_service),
) -> JSONResponse:
    user = await svc.register(body.email, body.password)
    token = create_access_token(user.id)
    response = ok({"userId": user.id, "email": user.email}, request, status_code=201)
    response.set_cookie(
        "access_token", token, httponly=True, samesite="lax", max_age=60 * 60 * 24 * 7
    )
    return response


@router.post("/auth/login")
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,  # noqa: ARG001 - kept for FastAPI signature compatibility
    svc: UserService = Depends(get_user_service),
) -> JSONResponse:
    user = await svc.authenticate(body.email, body.password)
    token = create_access_token(user.id)
    resp = ok({"userId": user.id, "email": user.email}, request)
    resp.set_cookie(
        "access_token", token, httponly=True, samesite="lax", max_age=60 * 60 * 24 * 7
    )
    return resp


@router.post("/auth/logout")
async def logout(request: Request) -> JSONResponse:
    resp = ok({"message": "Logged out"}, request)
    resp.delete_cookie("access_token")
    return resp


@router.get("/users/me")
async def me(request: Request, user: User = Depends(get_current_user)) -> JSONResponse:
    return ok({"id": user.id, "email": user.email}, request)
