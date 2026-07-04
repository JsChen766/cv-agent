"""
Synchronous file parsing utilities.

All functions are intentionally synchronous — they run in the main thread
or can be offloaded to a thread pool via asyncio.to_thread() if needed.
"""

from __future__ import annotations

import io


def parse_pdf(content: bytes) -> str:
    """Extract plain text from a PDF byte string."""
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(content))
        parts = []
        for page in reader.pages:
            text = page.extract_text()
            if text:
                parts.append(text.strip())
        return "\n\n".join(parts)
    except Exception as e:
        raise ValueError(f"PDF parsing failed: {e}") from e


def parse_docx(content: bytes) -> str:
    """Extract plain text from a .docx byte string."""
    try:
        from docx import Document
        doc = Document(io.BytesIO(content))
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        return "\n\n".join(paragraphs)
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
    if mime_type in (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/msword",
    ):
        return parse_docx(content)
    if mime_type in ("text/plain", "text/markdown"):
        return parse_txt(content)
    # Fallback: try as text
    try:
        return parse_txt(content)
    except ValueError:
        raise ValueError(f"Unsupported file type: {mime_type}")
