"""
Synchronous file parsing utilities.

All functions are intentionally synchronous — they run in the main thread
or can be offloaded to a thread pool via asyncio.to_thread() if needed.
"""

from __future__ import annotations

import io
from collections.abc import Callable
from typing import Any

_PdfReader: type[Any] | None = None
_Document: Callable[[Any], Any] | None = None


def _get_pdf_reader() -> type[Any]:
    global _PdfReader
    if _PdfReader is None:
        from pypdf import PdfReader

        _PdfReader = PdfReader
    return _PdfReader


def _get_docx_document() -> Callable[[Any], Any]:
    global _Document
    if _Document is None:
        from docx import Document

        _Document = Document
    return _Document


def warm_file_parsers() -> None:
    """Import parser backends before the first user parse request."""
    _get_pdf_reader()
    _get_docx_document()


def parse_pdf(content: bytes) -> str:
    """Extract plain text from a PDF byte string."""
    try:
        PdfReader = _get_pdf_reader()
        reader = PdfReader(io.BytesIO(content))
        parts = []
        for page in reader.pages:
            text = page.extract_text()
            if text:
                parts.append(text.strip())
        return "\n\n".join(parts)
    except TimeoutError:
        raise
    except Exception as e:
        raise ValueError(f"PDF parsing failed: {e}") from e


def parse_docx(content: bytes) -> str:
    """Extract plain text from a .docx byte string."""
    try:
        Document = _get_docx_document()
        doc = Document(io.BytesIO(content))
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        return "\n\n".join(paragraphs)
    except TimeoutError:
        raise
    except Exception as e:
        raise ValueError(f"DOCX parsing failed: {e}") from e


def parse_txt(content: bytes) -> str:
    """Decode a plain text file."""
    for encoding in ("utf-8", "gbk", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("Could not decode text file with any supported encoding")


def parse_file(content: bytes, mime_type: str) -> str:
    """Unified entry point — dispatches by MIME type."""
    mime_type = mime_type.lower()
    if mime_type == "application/pdf":
        return parse_pdf(content)
    if mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return parse_docx(content)
    if mime_type in ("text/plain", "text/markdown"):
        return parse_txt(content)
    # Fallback: try as text
    try:
        return parse_txt(content)
    except ValueError as exc:
        raise ValueError(f"Unsupported file type: {mime_type}") from exc
