"""Unit tests for Phase 2 — deterministic canvas patch engine.

All tests are domain-layer only: no database, no HTTP, no LLM.
"""

from __future__ import annotations

import copy
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.domain.resume.models import ResumeVariant, ScoreBreakdown
from app.domain.resume.patch import apply_patch_operations
from app.domain.resume.service import ResumeService


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _make_structured() -> dict:
    """Minimal but representative resume structured dict."""
    return {
        "contact": {"name": "Alice", "email": "alice@example.com"},
        "sections": [
            {
                "id": "sec-001",
                "type": "experience",
                "heading": "Work Experience",
                "items": [
                    {
                        "id": "item-001",
                        "title": "Engineer",
                        "organization": "WEEX",
                        "role": "Backend",
                        "start_date": "2021-01",
                        "end_date": "2023-06",
                        "raw_text": "",
                        "bullets": [
                            {"id": "bul-001", "text": "Built pipelines"},
                            {"id": "bul-002", "text": "Wrote SQL scripts"},
                            {"id": "bul-003", "text": "Led team of 5"},
                        ],
                    },
                    {
                        "id": "item-002",
                        "title": "Intern",
                        "organization": "Startup",
                        "role": "Frontend",
                        "start_date": "2020-06",
                        "end_date": "2020-12",
                        "raw_text": "",
                        "bullets": [
                            {"id": "bul-004", "text": "Built UI components"},
                        ],
                    },
                ],
            },
            {
                "id": "sec-002",
                "type": "education",
                "heading": "Education",
                "items": [
                    {
                        "id": "item-003",
                        "title": "B.Sc. Computer Science",
                        "organization": "MIT",
                        "start_date": "2017-09",
                        "end_date": "2021-06",
                        "raw_text": "",
                        "bullets": [],
                    }
                ],
            },
        ],
    }


def _all_ids(structured: dict) -> set[str]:
    ids: set[str] = set()
    for sec in structured.get("sections") or []:
        ids.add(sec["id"])
        for item in sec.get("items") or []:
            ids.add(item["id"])
            for bul in item.get("bullets") or []:
                ids.add(bul["id"])
    return ids


# ── replace_bullet ─────────────────────────────────────────────────────────────

def test_replace_bullet_happy_path() -> None:
    s = _make_structured()
    result = apply_patch_operations(s, [
        {"op": "replace_bullet", "bullet_id": "bul-002", "text": "Optimized 500k-row SQL scripts"}
    ])
    bullets = result["sections"][0]["items"][0]["bullets"]
    texts = {b["id"]: b["text"] for b in bullets}
    assert texts["bul-002"] == "Optimized 500k-row SQL scripts"
    assert texts["bul-001"] == "Built pipelines"
    assert texts["bul-003"] == "Led team of 5"


def test_replace_bullet_id_stability() -> None:
    s = _make_structured()
    original_ids = _all_ids(s)
    result = apply_patch_operations(s, [
        {"op": "replace_bullet", "bullet_id": "bul-001", "text": "Changed text"}
    ])
    assert _all_ids(result) == original_ids


def test_replace_bullet_unknown_id_raises() -> None:
    s = _make_structured()
    with pytest.raises(ValueError, match="bullet_id not found"):
        apply_patch_operations(s, [
            {"op": "replace_bullet", "bullet_id": "bul-nonexistent", "text": "x"}
        ])


# ── delete_bullet ──────────────────────────────────────────────────────────────

def test_delete_bullet_happy_path() -> None:
    s = _make_structured()
    result = apply_patch_operations(s, [
        {"op": "delete_bullet", "bullet_id": "bul-002"}
    ])
    bullets = result["sections"][0]["items"][0]["bullets"]
    assert len(bullets) == 2
    assert all(b["id"] != "bul-002" for b in bullets)


def test_delete_bullet_unknown_id_raises() -> None:
    s = _make_structured()
    with pytest.raises(ValueError, match="bullet_id not found"):
        apply_patch_operations(s, [{"op": "delete_bullet", "bullet_id": "bul-xyz"}])


# ── add_bullet ─────────────────────────────────────────────────────────────────

def test_add_bullet_at_end() -> None:
    s = _make_structured()
    result = apply_patch_operations(s, [
        {"op": "add_bullet", "item_id": "item-001", "text": "New bullet"}
    ])
    bullets = result["sections"][0]["items"][0]["bullets"]
    assert bullets[-1]["text"] == "New bullet"
    assert bullets[-1]["id"].startswith("bul-")
    assert len(bullets) == 4


def test_add_bullet_after_specific() -> None:
    s = _make_structured()
    result = apply_patch_operations(s, [
        {
            "op": "add_bullet",
            "item_id": "item-001",
            "text": "Inserted",
            "after_bullet_id": "bul-001",
        }
    ])
    bullets = result["sections"][0]["items"][0]["bullets"]
    assert bullets[1]["text"] == "Inserted"
    assert bullets[0]["id"] == "bul-001"
    assert bullets[2]["id"] == "bul-002"


def test_add_bullet_unknown_after_raises() -> None:
    s = _make_structured()
    with pytest.raises(ValueError, match="after_bullet_id not found"):
        apply_patch_operations(s, [
            {"op": "add_bullet", "item_id": "item-001", "text": "x", "after_bullet_id": "bul-zzz"}
        ])


# ── reorder_bullets ────────────────────────────────────────────────────────────

def test_reorder_bullets_happy_path() -> None:
    s = _make_structured()
    result = apply_patch_operations(s, [
        {
            "op": "reorder_bullets",
            "item_id": "item-001",
            "bullet_ids": ["bul-003", "bul-001", "bul-002"],
        }
    ])
    bullets = result["sections"][0]["items"][0]["bullets"]
    assert [b["id"] for b in bullets] == ["bul-003", "bul-001", "bul-002"]


def test_reorder_bullets_missing_id_raises() -> None:
    s = _make_structured()
    with pytest.raises(ValueError, match="reorder_bullets id mismatch"):
        apply_patch_operations(s, [
            {
                "op": "reorder_bullets",
                "item_id": "item-001",
                "bullet_ids": ["bul-001", "bul-002"],  # missing bul-003
            }
        ])


def test_reorder_bullets_extra_id_raises() -> None:
    s = _make_structured()
    with pytest.raises(ValueError, match="reorder_bullets id mismatch"):
        apply_patch_operations(s, [
            {
                "op": "reorder_bullets",
                "item_id": "item-001",
                "bullet_ids": ["bul-001", "bul-002", "bul-003", "bul-ghost"],
            }
        ])


def test_reorder_bullets_duplicate_id_raises() -> None:
    s = _make_structured()
    with pytest.raises(ValueError, match="duplicate"):
        apply_patch_operations(s, [
            {
                "op": "reorder_bullets",
                "item_id": "item-001",
                "bullet_ids": ["bul-001", "bul-001", "bul-002"],
            }
        ])


# ── replace_item_field ─────────────────────────────────────────────────────────

def test_replace_item_field_title() -> None:
    s = _make_structured()
    result = apply_patch_operations(s, [
        {"op": "replace_item_field", "item_id": "item-001", "field": "title", "value": "Senior Eng"}
    ])
    item = result["sections"][0]["items"][0]
    assert item["title"] == "Senior Eng"


def test_replace_item_field_unknown_field_raises() -> None:
    s = _make_structured()
    with pytest.raises(ValueError, match="not allowed"):
        apply_patch_operations(s, [
            {"op": "replace_item_field", "item_id": "item-001", "field": "id", "value": "hacked"}
        ])


def test_replace_item_field_unknown_item_raises() -> None:
    s = _make_structured()
    with pytest.raises(ValueError, match="item_id not found"):
        apply_patch_operations(s, [
            {"op": "replace_item_field", "item_id": "item-zzz", "field": "title", "value": "x"}
        ])


# ── delete_item ────────────────────────────────────────────────────────────────

def test_delete_item_happy_path() -> None:
    s = _make_structured()
    result = apply_patch_operations(s, [{"op": "delete_item", "item_id": "item-002"}])
    items = result["sections"][0]["items"]
    assert len(items) == 1
    assert items[0]["id"] == "item-001"


def test_delete_item_unknown_raises() -> None:
    s = _make_structured()
    with pytest.raises(ValueError, match="item_id not found"):
        apply_patch_operations(s, [{"op": "delete_item", "item_id": "item-zzz"}])


# ── add_item ───────────────────────────────────────────────────────────────────

def test_add_item_at_end() -> None:
    s = _make_structured()
    result = apply_patch_operations(s, [
        {
            "op": "add_item",
            "section_id": "sec-001",
            "item": {"title": "Freelancer", "organization": "Self"},
        }
    ])
    items = result["sections"][0]["items"]
    assert len(items) == 3
    new = items[-1]
    assert new["title"] == "Freelancer"
    assert new["id"].startswith("item-")


def test_add_item_preserves_original_ids() -> None:
    s = _make_structured()
    original_ids = _all_ids(s)
    result = apply_patch_operations(s, [
        {"op": "add_item", "section_id": "sec-001", "item": {"title": "New"}}
    ])
    new_ids = _all_ids(result)
    assert original_ids.issubset(new_ids)
    assert len(new_ids) == len(original_ids) + 1


# ── reorder_items ──────────────────────────────────────────────────────────────

def test_reorder_items_happy_path() -> None:
    s = _make_structured()
    result = apply_patch_operations(s, [
        {"op": "reorder_items", "section_id": "sec-001", "item_ids": ["item-002", "item-001"]}
    ])
    items = result["sections"][0]["items"]
    assert [it["id"] for it in items] == ["item-002", "item-001"]


def test_reorder_items_mismatch_raises() -> None:
    s = _make_structured()
    with pytest.raises(ValueError, match="reorder_items id mismatch"):
        apply_patch_operations(s, [
            {"op": "reorder_items", "section_id": "sec-001", "item_ids": ["item-001"]}
        ])


# ── replace_section_field ──────────────────────────────────────────────────────

def test_replace_section_field_heading() -> None:
    s = _make_structured()
    result = apply_patch_operations(s, [
        {"op": "replace_section_field", "section_id": "sec-001", "field": "heading", "value": "Experience"}
    ])
    assert result["sections"][0]["heading"] == "Experience"


def test_replace_section_field_unknown_field_raises() -> None:
    s = _make_structured()
    with pytest.raises(ValueError, match="not allowed"):
        apply_patch_operations(s, [
            {"op": "replace_section_field", "section_id": "sec-001", "field": "type", "value": "x"}
        ])


# ── reorder_sections ───────────────────────────────────────────────────────────

def test_reorder_sections_happy_path() -> None:
    s = _make_structured()
    result = apply_patch_operations(s, [
        {"op": "reorder_sections", "section_ids": ["sec-002", "sec-001"]}
    ])
    assert [sec["id"] for sec in result["sections"]] == ["sec-002", "sec-001"]


def test_reorder_sections_mismatch_raises() -> None:
    s = _make_structured()
    with pytest.raises(ValueError, match="reorder_sections id mismatch"):
        apply_patch_operations(s, [
            {"op": "reorder_sections", "section_ids": ["sec-001"]}
        ])


# ── unknown op ─────────────────────────────────────────────────────────────────

def test_unknown_op_raises() -> None:
    s = _make_structured()
    with pytest.raises(ValueError, match="Unknown op type"):
        apply_patch_operations(s, [{"op": "teleport_bullet", "bullet_id": "bul-001"}])


# ── atomicity: mid-batch failure leaves structured unchanged ──────────────────

def test_batch_atomicity_failure_does_not_mutate_original() -> None:
    s = _make_structured()
    original = copy.deepcopy(s)
    with pytest.raises(ValueError):
        apply_patch_operations(s, [
            {"op": "replace_bullet", "bullet_id": "bul-001", "text": "Changed"},
            {"op": "replace_bullet", "bullet_id": "bul-NONEXISTENT", "text": "Bad"},
        ])
    # apply_patch_operations deep-copies, so s itself is unchanged
    assert s == original


# ── id stability: change 1 bullet, all other ids intact ───────────────────────

def test_id_stability_after_replace_bullet() -> None:
    s = _make_structured()
    all_ids_before = _all_ids(s)
    result = apply_patch_operations(s, [
        {"op": "replace_bullet", "bullet_id": "bul-001", "text": "Updated"}
    ])
    all_ids_after = _all_ids(result)
    assert all_ids_before == all_ids_after


# ── service layer: patch_variant delegates correctly ──────────────────────────

@pytest.mark.asyncio
async def test_service_patch_variant_delegates_to_repo() -> None:
    structured = _make_structured()
    now = datetime.now()
    source_variant = ResumeVariant(
        id="variant-src",
        resume_id="resume-1",
        title="Draft",
        content="old content",
        structured=structured,
        created_at=now,
    )
    new_variant = ResumeVariant(
        id="variant-new",
        resume_id="resume-1",
        title="Draft",
        content="new content",
        structured={},
        parent_variant_id="variant-src",
        version=2,
        created_at=now,
    )

    repo = MagicMock()
    repo.get = AsyncMock(return_value=MagicMock(
        id="resume-1", user_id="user-1", title="R", items=[], variants=[],
        created_at=now, updated_at=now,
        target_role=None, jd_id=None, status="draft"
    ))
    repo.get_variant = AsyncMock(return_value=source_variant)
    repo.patch_variant_structured = AsyncMock(return_value=new_variant)

    svc = ResumeService(repo)
    result = await svc.patch_variant(
        user_id="user-1",
        variant_id="variant-src",
        operations=[{"op": "replace_bullet", "bullet_id": "bul-001", "text": "Changed"}],
    )

    assert result.id == "variant-new"
    assert result.parent_variant_id == "variant-src"
    assert result.version == 2
    repo.patch_variant_structured.assert_called_once()
    call_kwargs = repo.patch_variant_structured.call_args
    assert call_kwargs.kwargs["parent_variant_id"] == "variant-src"


@pytest.mark.asyncio
async def test_service_patch_variant_raises_on_bad_op() -> None:
    structured = _make_structured()
    now = datetime.now()
    source_variant = ResumeVariant(
        id="variant-src",
        resume_id="resume-1",
        title="Draft",
        content="old",
        structured=structured,
        created_at=now,
    )

    repo = MagicMock()
    repo.get = AsyncMock(return_value=MagicMock(
        id="resume-1", user_id="user-1", title="R", items=[], variants=[],
        created_at=now, updated_at=now,
        target_role=None, jd_id=None, status="draft"
    ))
    repo.get_variant = AsyncMock(return_value=source_variant)
    repo.patch_variant_structured = AsyncMock()

    svc = ResumeService(repo)
    with pytest.raises(ValueError, match="bullet_id not found"):
        await svc.patch_variant(
            user_id="user-1",
            variant_id="variant-src",
            operations=[{"op": "replace_bullet", "bullet_id": "bul-ghost", "text": "x"}],
        )
    # Repo should NOT have been called because batch failed before DB write
    repo.patch_variant_structured.assert_not_called()
