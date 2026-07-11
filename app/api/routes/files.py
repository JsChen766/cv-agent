from __future__ import annotations

import io
import logging
import zipfile

import asyncpg
from fastapi import APIRouter, Depends, Request, UploadFile
from fastapi import File as FastAPIFile
from fastapi.responses import JSONResponse

from app.api.deps import get_current_user_id, pool_dep
from app.api.file_parsing import parse_file_for_request
from app.api.response import ok
from app.core.types import FILE_PREFIX, generate_id
from app.infra.files.storage import get_storage

router = APIRouter(tags=["files"])
logger = logging.getLogger(__name__)

ALLOWED_MIME_TYPES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/markdown",
    "application/octet-stream",
}

EXTENSION_MIME_MAP: dict[str, str] = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain",
    ".md": "text/markdown",
}

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
MAX_DOCX_UNCOMPRESSED_SIZE = 50 * 1024 * 1024
MAX_DOCX_MEMBERS = 10_000


def _validate_file_content(content: bytes, mime_type: str) -> None:
    """Reject obvious extension/MIME spoofing before invoking a heavy parser."""
    if mime_type == "application/pdf" and not content.startswith(b"%PDF-"):
        from app.core.errors import ValidationError

        raise ValidationError("文件内容不是有效的 PDF")
    if (
        mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ):
        from app.core.errors import ValidationError

        buffer = io.BytesIO(content)
        if not zipfile.is_zipfile(buffer):
            raise ValidationError("文件内容不是有效的 DOCX")
        buffer.seek(0)
        with zipfile.ZipFile(buffer) as archive:
            members = archive.infolist()
            uncompressed_size = sum(member.file_size for member in members)
        if len(members) > MAX_DOCX_MEMBERS or uncompressed_size > MAX_DOCX_UNCOMPRESSED_SIZE:
            raise ValidationError("DOCX 解压后内容过大")


@router.post("/files/upload", status_code=201)
async def upload_file(
    request: Request,
    file: UploadFile = FastAPIFile(...),
    user_id: str = Depends(get_current_user_id),
    pool: asyncpg.Pool = Depends(pool_dep),
) -> JSONResponse:
    content = await file.read(MAX_FILE_SIZE + 1)
    if len(content) > MAX_FILE_SIZE:
        from app.core.errors import ValidationError
        raise ValidationError("File exceeds 10 MB limit")

    mime_type = file.content_type or "application/octet-stream"
    if mime_type not in ALLOWED_MIME_TYPES:
        from app.core.errors import ValidationError
        raise ValidationError(f"Unsupported file type: {mime_type}")

    if mime_type == "application/octet-stream":
        ext = (
            f".{(file.filename or '').rsplit('.', 1)[-1].lower()}"
            if (file.filename and '.' in file.filename)
            else ""
        )
        inferred = EXTENSION_MIME_MAP.get(ext)
        if inferred:
            mime_type = inferred
        else:
            from app.core.errors import ValidationError

            raise ValidationError("Unsupported file type")

    _validate_file_content(content, mime_type)

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
) -> JSONResponse:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM uploaded_files WHERE id=$1 AND user_id=$2", file_id, user_id
        )
    if not row:
        from app.core.errors import NotFoundError
        raise NotFoundError(f"File not found: {file_id}")

    record = dict(row)
    raw_parsed_text = record.get("parsed_text")
    if isinstance(raw_parsed_text, str) and raw_parsed_text.strip():
        parsed_text = raw_parsed_text
        logger.info(
            "file_parse_cache_hit",
            extra={
                "file_id": file_id,
                "mime_type": record.get("mime_type"),
                "size_bytes": record.get("size_bytes"),
                "char_count": len(parsed_text),
            },
        )
        return ok(
            {"fileId": file_id, "parsedText": parsed_text, "charCount": len(parsed_text)},
            request,
        )

    storage = get_storage()
    content = await storage.get(record["storage_path"])

    # Keep this on the shared helper path used by Copilot's cache-miss fallback,
    # so both endpoints expose identical timeout and validation behaviour.
    parsed_text = await parse_file_for_request(content, record["mime_type"])

    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE uploaded_files SET parsed_text=$1 WHERE id=$2",
            parsed_text, file_id,
        )
    logger.info(
        "file_parse_completed",
        extra={
            "file_id": file_id,
            "mime_type": record.get("mime_type"),
            "size_bytes": record.get("size_bytes"),
            "char_count": len(parsed_text),
        },
    )

    return ok(
        {"fileId": file_id, "parsedText": parsed_text, "charCount": len(parsed_text)},
        request,
    )
