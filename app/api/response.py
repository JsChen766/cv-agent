"""Unified response envelope helpers."""

from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from app.core.errors import AppError


def ok(data: Any, request: Request, *, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=jsonable_encoder({
            "success": True,
            "data": data,
            "request_id": getattr(request.state, "request_id", ""),
        }),
    )


def ok_list(
    items: list,
    next_cursor: str | None,
    request: Request,
    *,
    total: int | None = None,
) -> JSONResponse:
    content: dict[str, Any] = {
        "success": True,
        "data": {"items": items, "nextCursor": next_cursor},
        "request_id": getattr(request.state, "request_id", ""),
    }
    if total is not None:
        content["data"]["total"] = total
    return JSONResponse(content=jsonable_encoder(content))


def err(exc: AppError, request: Request) -> JSONResponse:
    return JSONResponse(
        status_code=exc.http_status,
        content=jsonable_encoder({
            "success": False,
            "error": exc.to_dict(),
            "request_id": getattr(request.state, "request_id", ""),
        }),
    )
