"""Unified response envelope helpers."""

from __future__ import annotations

from collections.abc import Sequence

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from app.core.errors import AppError


def ok(data: object, request: Request, *, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=jsonable_encoder({
            "success": True,
            "data": data,
            "request_id": getattr(request.state, "request_id", ""),
        }),
    )


def ok_list(
    items: Sequence[object],
    next_cursor: str | None,
    request: Request,
    *,
    total: int | None = None,
) -> JSONResponse:
    data: dict[str, object] = {"items": items, "nextCursor": next_cursor}
    if total is not None:
        data["total"] = total
    content: dict[str, object] = {
        "success": True,
        "data": data,
        "request_id": getattr(request.state, "request_id", ""),
    }
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
