"""Pure functions for deterministic patch operations on resume structured data.

No framework dependencies. Input: structured dict + list of operations.
Output: new structured dict or raises ValueError on invalid operation.

All mutations are performed on a deep-copied structure so the caller's
original is never modified.
"""

from __future__ import annotations

import copy
import uuid
from typing import Any


def apply_patch_operations(
    structured: dict[str, Any],
    operations: list[dict[str, Any]],
) -> dict[str, Any]:
    """Apply a batch of patch operations to structured resume data.

    Operations are applied sequentially. Any failure raises ValueError and
    the caller should treat the whole batch as failed (atomic at service layer).

    Returns a new structured dict; input is not mutated.
    """
    result = copy.deepcopy(structured)
    for op in operations:
        result = _apply_one(result, op)
    return result


# ── Dispatch ──────────────────────────────────────────────────────────────────


def _apply_one(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    op_type = op.get("op")
    handlers = {
        "replace_contact_field": _op_replace_contact_field,
        "replace_bullet": _op_replace_bullet,
        "delete_bullet": _op_delete_bullet,
        "add_bullet": _op_add_bullet,
        "reorder_bullets": _op_reorder_bullets,
        "replace_item_field": _op_replace_item_field,
        "delete_item": _op_delete_item,
        "add_item": _op_add_item,
        "reorder_items": _op_reorder_items,
        "replace_section_field": _op_replace_section_field,
        "delete_section": _op_delete_section,
        "add_section": _op_add_section,
        "reorder_sections": _op_reorder_sections,
    }
    handler = handlers.get(op_type or "")
    if handler is None:
        raise ValueError(f"Unknown op type: {op_type!r}")
    return handler(structured, op)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _find_section(structured: dict[str, Any], section_id: str) -> dict[str, Any]:
    for sec in structured.get("sections") or []:
        if isinstance(sec, dict) and sec.get("id") == section_id:
            return sec
    raise ValueError(f"section_id not found: {section_id!r}")


def _find_item(structured: dict[str, Any], item_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return (section, item) pair."""
    for sec in structured.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        for item in sec.get("items") or []:
            if isinstance(item, dict) and item.get("id") == item_id:
                return sec, item
    raise ValueError(f"item_id not found: {item_id!r}")


def _find_bullet(
    structured: dict[str, Any], bullet_id: str
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Return (section, item, bullet) triple."""
    for sec in structured.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        for item in sec.get("items") or []:
            if not isinstance(item, dict):
                continue
            for bullet in item.get("bullets") or []:
                if isinstance(bullet, dict) and bullet.get("id") == bullet_id:
                    return sec, item, bullet
    raise ValueError(f"bullet_id not found: {bullet_id!r}")


def _new_bullet_id() -> str:
    return f"bul-{uuid.uuid4()}"


def _new_item_id() -> str:
    return f"item-{uuid.uuid4()}"


def _new_section_id() -> str:
    return f"sec-{uuid.uuid4()}"


def _with_new_nested_ids(item_data: dict[str, Any]) -> dict[str, Any]:
    item = copy.deepcopy(item_data)
    item["id"] = _new_item_id()
    bullets = item.get("bullets")
    if isinstance(bullets, list):
        for bullet in bullets:
            if isinstance(bullet, dict):
                bullet["id"] = _new_bullet_id()
    return item


# ── Op implementations ────────────────────────────────────────────────────────

_CONTACT_ALLOWED_FIELDS = frozenset({"name", "email", "phone", "location", "linkedin"})


def _op_replace_contact_field(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    field = op["field"]
    if field not in _CONTACT_ALLOWED_FIELDS:
        raise ValueError(f"replace_contact_field: field {field!r} not allowed")
    contact = structured.get("contact")
    if not isinstance(contact, dict):
        contact = {}
        structured["contact"] = contact
    contact[field] = op.get("value")
    return structured


def _op_replace_bullet(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    bullet_id = op["bullet_id"]
    text = op["text"]
    _sec, _item, bullet = _find_bullet(structured, bullet_id)
    bullet["text"] = text
    return structured


def _op_delete_bullet(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    bullet_id = op["bullet_id"]
    for sec in structured.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        for item in sec.get("items") or []:
            if not isinstance(item, dict):
                continue
            bullets = item.get("bullets") or []
            new_bullets = [b for b in bullets if b.get("id") != bullet_id]
            if len(new_bullets) < len(bullets):
                item["bullets"] = new_bullets
                return structured
    raise ValueError(f"bullet_id not found: {bullet_id!r}")


def _op_add_bullet(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    item_id = op["item_id"]
    text = op["text"]
    after_bullet_id = op.get("after_bullet_id")
    _sec, item = _find_item(structured, item_id)
    bullets: list[dict[str, Any]] = item.setdefault("bullets", [])
    new_bullet = {"id": _new_bullet_id(), "text": text}
    if after_bullet_id is None:
        bullets.append(new_bullet)
    else:
        idx = next((i for i, b in enumerate(bullets) if b.get("id") == after_bullet_id), None)
        if idx is None:
            raise ValueError(f"after_bullet_id not found: {after_bullet_id!r}")
        bullets.insert(idx + 1, new_bullet)
    return structured


def _op_reorder_bullets(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    item_id = op["item_id"]
    bullet_ids: list[str] = op["bullet_ids"]
    _sec, item = _find_item(structured, item_id)
    if len(bullet_ids) != len(set(bullet_ids)):
        raise ValueError("reorder_bullets contains duplicate ids")
    existing = item.get("bullets") or []
    existing_ids = {b["id"] for b in existing if isinstance(b, dict) and "id" in b}
    incoming_ids = set(bullet_ids)
    if incoming_ids != existing_ids:
        missing = existing_ids - incoming_ids
        extra = incoming_ids - existing_ids
        parts = []
        if missing:
            parts.append(f"missing ids: {missing}")
        if extra:
            parts.append(f"extra ids: {extra}")
        raise ValueError(f"reorder_bullets id mismatch — {'; '.join(parts)}")
    bullet_map = {b["id"]: b for b in existing if isinstance(b, dict)}
    item["bullets"] = [bullet_map[bid] for bid in bullet_ids]
    return structured


_ITEM_ALLOWED_FIELDS = frozenset(
    {"title", "organization", "role", "location", "start_date", "end_date", "raw_text"}
)


def _op_replace_item_field(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    item_id = op["item_id"]
    field = op["field"]
    value = op["value"]
    if field not in _ITEM_ALLOWED_FIELDS:
        raise ValueError(f"replace_item_field: field {field!r} not allowed")
    _sec, item = _find_item(structured, item_id)
    item[field] = value
    return structured


def _op_delete_item(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    item_id = op["item_id"]
    for sec in structured.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        items = sec.get("items") or []
        new_items = [it for it in items if it.get("id") != item_id]
        if len(new_items) < len(items):
            sec["items"] = new_items
            return structured
    raise ValueError(f"item_id not found: {item_id!r}")


def _op_add_item(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    section_id = op["section_id"]
    item_data: dict[str, Any] = op["item"]
    after_item_id = op.get("after_item_id")
    sec = _find_section(structured, section_id)
    items: list[dict[str, Any]] = sec.setdefault("items", [])
    new_item = _with_new_nested_ids(item_data)
    if after_item_id is None:
        items.append(new_item)
    else:
        idx = next((i for i, it in enumerate(items) if it.get("id") == after_item_id), None)
        if idx is None:
            raise ValueError(f"after_item_id not found: {after_item_id!r}")
        items.insert(idx + 1, new_item)
    return structured


def _op_reorder_items(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    section_id = op["section_id"]
    item_ids: list[str] = op["item_ids"]
    sec = _find_section(structured, section_id)
    if len(item_ids) != len(set(item_ids)):
        raise ValueError("reorder_items contains duplicate ids")
    existing = sec.get("items") or []
    existing_ids = {it["id"] for it in existing if isinstance(it, dict) and "id" in it}
    incoming_ids = set(item_ids)
    if incoming_ids != existing_ids:
        missing = existing_ids - incoming_ids
        extra = incoming_ids - existing_ids
        parts = []
        if missing:
            parts.append(f"missing ids: {missing}")
        if extra:
            parts.append(f"extra ids: {extra}")
        raise ValueError(f"reorder_items id mismatch — {'; '.join(parts)}")
    item_map = {it["id"]: it for it in existing if isinstance(it, dict)}
    sec["items"] = [item_map[iid] for iid in item_ids]
    return structured


_SECTION_ALLOWED_FIELDS = frozenset({"heading"})


def _op_replace_section_field(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    section_id = op["section_id"]
    field = op["field"]
    value = op["value"]
    if field not in _SECTION_ALLOWED_FIELDS:
        raise ValueError(f"replace_section_field: field {field!r} not allowed")
    sec = _find_section(structured, section_id)
    sec[field] = value
    return structured


def _op_delete_section(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    section_id = op["section_id"]
    sections = structured.get("sections") or []
    new_sections = [
        section
        for section in sections
        if not isinstance(section, dict) or section.get("id") != section_id
    ]
    if len(new_sections) == len(sections):
        raise ValueError(f"section_id not found: {section_id!r}")
    structured["sections"] = new_sections
    return structured


def _op_add_section(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    section_data = copy.deepcopy(op["section"])
    if not isinstance(section_data, dict):
        raise ValueError("add_section: section must be an object")
    if section_data.get("type") not in {
        "summary",
        "education",
        "experience",
        "project",
        "skills",
        "other",
    }:
        raise ValueError("add_section: invalid section type")
    after_section_id = op.get("after_section_id")
    sections: list[dict[str, Any]] = structured.setdefault("sections", [])
    section_data["id"] = _new_section_id()
    raw_items = section_data.get("items")
    section_data["items"] = (
        [_with_new_nested_ids(item) for item in raw_items if isinstance(item, dict)]
        if isinstance(raw_items, list)
        else []
    )
    if after_section_id is None:
        sections.append(section_data)
    else:
        idx = next(
            (i for i, section in enumerate(sections) if section.get("id") == after_section_id),
            None,
        )
        if idx is None:
            raise ValueError(f"after_section_id not found: {after_section_id!r}")
        sections.insert(idx + 1, section_data)
    return structured


def _op_reorder_sections(structured: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    section_ids: list[str] = op["section_ids"]
    sections = structured.get("sections") or []
    if len(section_ids) != len(set(section_ids)):
        raise ValueError("reorder_sections contains duplicate ids")
    existing_ids = {s["id"] for s in sections if isinstance(s, dict) and "id" in s}
    incoming_ids = set(section_ids)
    if incoming_ids != existing_ids:
        missing = existing_ids - incoming_ids
        extra = incoming_ids - existing_ids
        parts = []
        if missing:
            parts.append(f"missing ids: {missing}")
        if extra:
            parts.append(f"extra ids: {extra}")
        raise ValueError(f"reorder_sections id mismatch — {'; '.join(parts)}")
    sec_map = {s["id"]: s for s in sections if isinstance(s, dict)}
    structured["sections"] = [sec_map[sid] for sid in section_ids]
    return structured
