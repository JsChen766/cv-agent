from __future__ import annotations

import asyncio

import asyncpg
from fastapi import APIRouter, Depends, Request, UploadFile
from fastapi import File as FastAPIFile

from app.api.deps import get_current_user_id, pool_dep
from app.api.response import ok
from app.core.types import FILE_PREFIX, generate_id
from app.infra.files.parser import parse_file
from app.infra.files.storage import get_storage

router = APIRouter(tags=["files"])

ALLOWED_MIME_TYPES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "text/plain",
    "text/markdown",
}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB


@router.post("/files/upload", status_code=201)
async def upload_file(
    request: Request,
    file: UploadFile = FastAPIFile(...),
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool = Depends(pool_dep),
):
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        from app.core.errors import ValidationError
        raise ValidationError("File exceeds 10 MB limit")

    mime_type = file.content_type or "application/octet-stream"
    if mime_type not in ALLOWED_MIME_TYPES:
        from app.core.errors import ValidationError
        raise ValidationError(f"Unsupported file type: {mime_type}")

    storage = get_storage()
    file_id = generate_id(FILE_PREFIX)
    path = await storage.save(content, file_id + "_" + (file.filename or "upload"), user_id)

    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO uploaded_files (id, user_id, filename, mime_type, size_bytes, storage_path)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            file_id, user_id, file.filename, mime_type, len(content), path,
        )

    return ok(
        {
            "fileId": file_id,
            "filename": file.filename,
            "mimeType": mime_type,
            "sizeBytes": len(content),
        },
        request,
        status_code=201,
    )


@router.post("/files/{file_id}/parse")
async def parse_uploaded_file(
    file_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool = Depends(pool_dep),
):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM uploaded_files WHERE id=$1 AND user_id=$2", file_id, user_id
        )
    if not row:
        from app.core.errors import NotFoundError
        raise NotFoundError(f"File not found: {file_id}")

    storage = get_storage()
    content = await storage.get(row["storage_path"])

    # Run synchronous parsing in thread pool
    parsed_text = await asyncio.to_thread(parse_file, content, row["mime_type"])

    # Cache parsed text
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE uploaded_files SET parsed_text=$1 WHERE id=$2",
            parsed_text, file_id,
        )

    return ok(
        {"fileId": file_id, "parsedText": parsed_text, "charCount": len(parsed_text)},
        request,
    )
