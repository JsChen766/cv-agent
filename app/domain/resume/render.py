"""Deterministic markdown rendering from resume structured data.

Single source of truth — graphs layer imports from here, domain service also
uses this directly. No framework dependencies.
"""

from __future__ import annotations


def render_structured_to_markdown(structured: dict[str, object]) -> str:
    """Render a resume structured dict to markdown. Deterministic; no LLM."""
    lines: list[str] = []
    contact = structured.get("contact")
    if isinstance(contact, dict):
        header_bits = [
            str(contact.get(k)) for k in ("name", "email", "phone", "location") if contact.get(k)
        ]
        if header_bits:
            lines.append(" · ".join(header_bits))
            lines.append("")

    sections = structured.get("sections") or []
    if not isinstance(sections, list):
        return "\n".join(lines).strip()

    for section in sections:
        if not isinstance(section, dict):
            continue
        heading = section.get("heading") or ""
        lines.append(f"## {heading}".rstrip())
        lines.append("")
        items = section.get("items") or []
        section_type = section.get("type")
        for item in items:
            if not isinstance(item, dict):
                continue
            header_parts: list[str] = []
            title = item.get("title")
            organization = item.get("organization")
            role = item.get("role")
            if title:
                header_parts.append(f"**{title}**")
            if organization:
                header_parts.append(str(organization))
            if role:
                header_parts.append(str(role))
            date_range = _format_date_range(item.get("start_date"), item.get("end_date"))
            if header_parts or date_range:
                header_line = " · ".join(header_parts)
                if date_range:
                    header_line = (
                        f"{header_line}    _{date_range}_" if header_line else f"_{date_range}_"
                    )
                lines.append(header_line)
            raw_text = item.get("raw_text")
            if isinstance(raw_text, str) and raw_text.strip():
                lines.append(raw_text.strip())
            bullets = item.get("bullets") or []
            for bullet in bullets:
                if isinstance(bullet, dict) and bullet.get("text"):
                    lines.append(f"- {bullet['text']}")
            if section_type in ("experience", "project", "education", "other"):
                lines.append("")
        if not lines or lines[-1] != "":
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _format_date_range(start: object, end: object) -> str:
    s = str(start).strip() if isinstance(start, str) and start.strip() else ""
    e = str(end).strip() if isinstance(end, str) and end.strip() else ""
    if not s and not e:
        return ""
    if s and e:
        return f"{s} – {e}"
    return s or e
