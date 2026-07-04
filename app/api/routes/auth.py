from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, EmailStr

from app.api.auth_utils import create_access_token
from app.api.deps import get_current_user, get_user_service
from app.api.response import ok
from app.domain.user.service import UserService

router = APIRouter(tags=["auth"])


class LoginRequest(BaseModel):
    email: str
    password: str


class RegisterRequest(BaseModel):
    email: str
    password: str


@router.post("/auth/register")
async def register(
    body: RegisterRequest,
    request: Request,
    svc: UserService = Depends(get_user_service),
):
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
    response: Response,
    svc: UserService = Depends(get_user_service),
):
    user = await svc.authenticate(body.email, body.password)
    token = create_access_token(user.id)
    resp = ok({"userId": user.id, "email": user.email}, request)
    resp.set_cookie(
        "access_token", token, httponly=True, samesite="lax", max_age=60 * 60 * 24 * 7
    )
    return resp


@router.post("/auth/logout")
async def logout(request: Request):
    resp = ok({"message": "Logged out"}, request)
    resp.delete_cookie("access_token")
    return resp


@router.get("/users/me")
async def me(request: Request, user=Depends(get_current_user)):
    return ok({"id": user.id, "email": user.email}, request)
