"""Tests for resume edit subgraph (Phase 3)."""

from __future__ import annotations

from collections import namedtuple
from typing import Any

from pydantic import BaseModel

from app.graphs.resume.edit.nodes import (
    EditClassification,
    _compute_structured_diff,
    _edit_confirmation_message,
    _id_exists_in_structured,
    _summarize_structured_for_classify,
)
from app.graphs.resume.nodes import (
    _assign_structure_ids,
    _LlmBullet,
    _LlmResumeStructure,
    _LlmSection,
    _LlmSectionItem,
    _text_similarity,
)

# ── Fixtures ──────────────────────────────────────────────────────────────────

_SAMPLE_STRUCTURED: dict[str, Any] = {
    "language": "zh-CN",
    "contact": {"name": "张三"},
    "sections": [
        {
            "id": "sec-exp",
            "type": "experience",
            "heading": "工作经历",
            "items": [
                {
                    "id": "item-weex",
                    "source_experience_id": "exp-weex",
                    "title": "数据分析实习生",
                    "organization": "WEEX国际交易所有限公司",
                    "bullets": [
                        {"id": "bul-1", "text": "编写95+复杂SQL脚本"},
                        {"id": "bul-2", "text": "交付50+个Power BI看板"},
                        {"id": "bul-3", "text": "独立完成数据清洗与ETL流程"},
                    ],
                },
                {
                    "id": "item-xy",
                    "source_experience_id": "exp-xy",
                    "title": "AI算法工程师",
                    "organization": "江西新华云",
                    "bullets": [
                        {"id": "bul-4", "text": "主导处理30万+条语料库"},
                        {"id": "bul-5", "text": "管理300万+条关键词库"},
                    ],
                },
            ],
        }
    ],
}


class _MockProvider:
    def __init__(self, result: Any) -> None:
        self._result = result

    async def chat_structured(
        self,
        messages: list[dict[str, str]],
        schema: type,
        *,
        temperature: float = 0.2,
    ) -> Any:
        if isinstance(self._result, Exception):
            raise self._result
        if isinstance(self._result, BaseModel):
            return self._result
        return schema.model_validate(self._result)


class _MockResumeService:
    async def get_resume(self, user_id: str, resume_id: str) -> Any:
        from datetime import datetime

        class _Variant:
            id = "var-original"
            created_at = datetime(2025, 1, 1)
            structured = _SAMPLE_STRUCTURED
            content = "mock content"

        class _Resume:
            variants = [_Variant()]

        return _Resume()

    async def patch_variant(
        self, user_id: str, variant_id: str, operations: list[dict]
    ) -> Any:
        from datetime import datetime

        class _NewVariant:
            id = "var-new-123"
            created_at = datetime(2025, 1, 2)
            structured = _SAMPLE_STRUCTURED
            content = "patched content"

        return _NewVariant()



_MockServices = namedtuple("_MockServices", ["resume"])


def _make_mock_services() -> _MockServices:
    return _MockServices(resume=_MockResumeService())


# ── Helper tests ────────────────────────────────────────────────────────────


def test_summarize_structured_for_classify() -> None:
    result = _summarize_structured_for_classify(_SAMPLE_STRUCTURED)
    assert "Section sec-exp [experience]" in result
    assert "Item item-weex" in result
    assert "Bullet bul-1" in result


def test_id_exists_in_structured() -> None:
    assert _id_exists_in_structured("bul-1", _SAMPLE_STRUCTURED) is True
    assert _id_exists_in_structured("item-weex", _SAMPLE_STRUCTURED) is True
    assert _id_exists_in_structured("sec-exp", _SAMPLE_STRUCTURED) is True
    assert _id_exists_in_structured("bul-nonexistent", _SAMPLE_STRUCTURED) is False


def test_compute_structured_diff_no_change() -> None:
    diff = _compute_structured_diff(_SAMPLE_STRUCTURED, _SAMPLE_STRUCTURED)
    assert diff["changed_bullet_ids"] == []
    assert diff["changed_item_ids"] == []
    assert diff["added_ids"] == []
    assert diff["removed_ids"] == []


def test_compute_structured_diff_bullet_change() -> None:
    new_structured = dict(_SAMPLE_STRUCTURED)
    new_structured["sections"] = [dict(_SAMPLE_STRUCTURED["sections"][0])]
    new_structured["sections"][0]["items"] = [dict(_SAMPLE_STRUCTURED["sections"][0]["items"][0])]
    new_structured["sections"][0]["items"][0]["bullets"] = [
        {"id": "bul-1", "text": "changed text"},
    ]
    diff = _compute_structured_diff(_SAMPLE_STRUCTURED, new_structured)
    assert "bul-1" in diff["changed_bullet_ids"]


def test_edit_confirmation_message() -> None:
    msg = _edit_confirmation_message({
        "changed_bullet_ids": ["bul-1"],
        "changed_item_ids": [],
        "changed_section_ids": [],
        "added_ids": ["bul-new"],
        "removed_ids": [],
    })
    assert "修改了 1 处" in msg
    assert "新增了 1 处" in msg


def test_text_similarity() -> None:
    assert _text_similarity("hello world", "hello world") == 1.0
    assert _text_similarity("abc", "xyz") == 0.0
    assert _text_similarity("", "hello") == 0.0
    assert _text_similarity("hello", "") == 0.0


# ── Tier 1: classify outputs Tier 1, apply_node calls patch_variant ─────────


async def test_tier1_direct_patch(monkeypatch) -> None:
    from app.graphs.resume.edit.nodes import apply_node, edit_classify_node

    classify_result = EditClassification(
        tier=1, target_kind="bullet", target_id="bul-1", reasoning="direct edit"
    )

    monkeypatch.setattr(
        "app.providers.factory.get_provider",
        lambda: _MockProvider(classify_result),
    )
    monkeypatch.setattr(
        "app.graphs.runtime.services_from_config",
        lambda _: _make_mock_services(),
    )

    state: dict[str, Any] = {
        "workspace": {"resume_id": "res-123"},
        "user_id": "user-1",
        "edit_instruction": "把第一个 bullet 改成'编写100+复杂SQL脚本'",
        "pending_sse_events": [],
        "edit_operations": [{"op": "replace_bullet", "bullet_id": "bul-1", "text": "编写100+复杂SQL脚本"}],
        "require_review_before_apply": False,
    }

    config = {"configurable": {}}

    classify_out = await edit_classify_node(state, config)
    assert classify_out["edit_tier"] == 1

    result = await apply_node({**state, **classify_out, "edit_operations": [{"op": "replace_bullet", "bullet_id": "bul-1", "text": "编写100+复杂SQL脚本"}]}, config)
    assert result["edit_new_variant_id"] is not None
    events = result.get("pending_sse_events", [])
    event_types = [e.get("event") for e in events]
    assert "content.diff.started" in event_types
    assert "content.diff.delta" in event_types
    assert "content.diff.completed" in event_types


async def test_edit_classify_no_resume_id(monkeypatch) -> None:
    from app.graphs.resume.edit.nodes import edit_classify_node

    state: dict[str, Any] = {
        "workspace": {},
        "user_id": "user-1",
        "edit_instruction": "改一下这个简历",
        "pending_sse_events": [],
    }
    result = await edit_classify_node(state, None)
    assert result["edit_tier"] is None
    events = result.get("pending_sse_events", [])
    assert any("当前没有可编辑的简历" in str(e.get("content", "")) for e in events)


# ── Tier 2: locate → apply ──────────────────────────────────────────────────


async def test_tier2_locate_then_apply(monkeypatch) -> None:
    from app.graphs.resume.edit.nodes import apply_node, locate_node

    class _LocateProvider:
        async def chat_structured(
            self,
            messages: list[dict[str, str]],
            schema: type,
            *,
            temperature: float = 0.2,
        ) -> Any:
            return schema.model_validate({
                "target_id": "bul-2",
                "operation": {"op": "replace_bullet", "bullet_id": "bul-2", "text": "交付60+个Power BI看板"},
                "confidence": 0.95,
            })

    monkeypatch.setattr(
        "app.providers.factory.get_provider",
        lambda: _LocateProvider(),
    )
    monkeypatch.setattr(
        "app.graphs.runtime.services_from_config",
        lambda _: _make_mock_services(),
    )

    state: dict[str, Any] = {
        "workspace": {"resume_id": "res-123"},
        "user_id": "user-1",
        "edit_instruction": "把 WEEX 第二条改成 SQL 数量更多",
        "pending_sse_events": [],
        "require_review_before_apply": False,
    }
    config = {"configurable": {}}

    locate_out = await locate_node(state, config)
    assert locate_out["edit_target_id"] == "bul-2"
    assert len(locate_out["edit_operations"]) == 1

    result = await apply_node({**state, **locate_out}, config)
    assert result["edit_new_variant_id"] is not None
    diff = result.get("edit_diff", {})
    # Mock returns same structured, but apply_node path was exercised
    assert isinstance(diff, dict)


# ── Tier 2 + require_review → interrupt ──────────────────────────────────────


async def test_tier2_with_interrupt(monkeypatch) -> None:
    from app.graphs.resume.edit.nodes import apply_node

    monkeypatch.setattr(
        "app.graphs.runtime.services_from_config",
        lambda _: _make_mock_services(),
    )

    state: dict[str, Any] = {
        "workspace": {"resume_id": "res-123"},
        "user_id": "user-1",
        "edit_operations": [{"op": "replace_bullet", "bullet_id": "bul-1", "text": "new text"}],
        "require_review_before_apply": True,
        "pending_sse_events": [],
    }
    config = {"configurable": {}}

    result = await apply_node(state, config)
    assert result.get("edit_new_structured") is not None
    events = result.get("pending_sse_events", [])
    event_types = [e.get("event") for e in events]
    assert "content.diff.started" not in event_types


# ── Tier 3 → edit_tier3_bridge_node prepares for resume_generation ──────────


def test_build_tier3_instruction() -> None:
    from app.graphs.resume.edit.nodes import _build_tier3_instruction

    instruction = "整体太长，压缩到一页"
    result = _build_tier3_instruction(instruction, _SAMPLE_STRUCTURED)
    assert "[对话式编辑指令]" in result
    assert instruction in result
    assert "Section sec-exp" in result


# ── Id reuse (_assign_structure_ids) ──────────────────────────────────────────


def test_assign_structure_ids_reuses_ids() -> None:
    previous_structured: dict[str, Any] = {
        "language": "zh-CN",
        "contact": None,
        "sections": [
            {
                "id": "sec-old",
                "type": "experience",
                "heading": "经历",
                "items": [
                    {
                        "id": "item-old",
                        "source_experience_id": "exp-123",
                        "title": "旧标题",
                        "organization": "旧公司",
                        "role": "",
                        "start_date": None,
                        "end_date": None,
                        "bullets": [
                            {"id": "bul-old-1", "text": "旧 bullet 1"},
                            {"id": "bul-old-2", "text": "旧 bullet 2"},
                        ],
                        "raw_text": None,
                    }
                ],
            }
        ],
    }

    llm = _LlmResumeStructure(
        language="zh-CN",
        contact=None,
        sections=[
            _LlmSection(
                type="experience",
                heading="经历",
                items=[
                    _LlmSectionItem(
                        source_experience_id="exp-123",
                        title="新标题",
                        organization="旧公司",
                        role="",
                        start_date=None,
                        end_date=None,
                        bullets=[
                            _LlmBullet(text="旧 bullet 1 修改版"),
                            _LlmBullet(text="全新 bullet 内容"),
                        ],
                        raw_text=None,
                    )
                ],
            )
        ],
    )

    result = _assign_structure_ids(llm, previous_structured=previous_structured)
    sections = result.get("sections", [])
    assert len(sections) == 1
    items = sections[0].get("items", [])
    assert len(items) == 1
    item = items[0]
    assert item["id"] == "item-old"
    bullets = item["bullets"]
    assert bullets[0]["id"] == "bul-old-1"
    assert bullets[1]["id"] != "bul-old-2"
    assert bullets[1]["id"].startswith("bul-")


def test_assign_structure_ids_no_previous() -> None:
    llm = _LlmResumeStructure(
        language="zh-CN",
        contact=None,
        sections=[
            _LlmSection(
                type="experience",
                heading="经历",
                items=[
                    _LlmSectionItem(
                        source_experience_id="exp-123",
                        title="标题",
                        organization="公司",
                        role="",
                        start_date=None,
                        end_date=None,
                        bullets=[],
                        raw_text=None,
                    )
                ],
            )
        ],
    )

    result = _assign_structure_ids(llm)
    item = result["sections"][0]["items"][0]
    assert item["id"].startswith("item-")


# ── Edge case: apply_node with no operations ────────────────────────────────


async def test_apply_node_no_operations() -> None:
    from app.graphs.resume.edit.nodes import apply_node

    state: dict[str, Any] = {
        "workspace": {"resume_id": "res-123"},
        "user_id": "user-1",
        "edit_operations": [],
        "pending_sse_events": [],
    }
    result = await apply_node(state)
    assert "未能确定编辑操作" in result.get("assistant_message", "")


async def test_apply_node_no_resume_id() -> None:
    from app.graphs.resume.edit.nodes import apply_node

    state: dict[str, Any] = {
        "workspace": {},
        "user_id": "user-1",
        "edit_operations": [{"op": "replace_bullet", "bullet_id": "bul-1", "text": "test"}],
        "pending_sse_events": [],
    }
    result = await apply_node(state)
    assert "当前没有可编辑的简历" in result.get("assistant_message", "")


# ── _compute_structured_diff: addition and removal ──────────────────────────


def test_compute_structured_diff_additions() -> None:
    import copy

    old = copy.deepcopy(_SAMPLE_STRUCTURED)
    new = copy.deepcopy(_SAMPLE_STRUCTURED)
    new["sections"][0]["items"][0]["bullets"] = (
        new["sections"][0]["items"][0]["bullets"]
        + [{"id": "bul-new", "text": "new bullet"}]
    )
    diff = _compute_structured_diff(old, new)
    assert "bul-new" in diff["added_ids"]


# ── locate_node: no structured data (empty variants) ────────────────────────


async def test_locate_node_no_structured(monkeypatch) -> None:
    from app.graphs.resume.edit.nodes import locate_node

    class _EmptyResumeService:
        async def get_resume(self, user_id: str, resume_id: str) -> Any:

            class _Resume:
                variants = []

            return _Resume()

    class _EmptyResumeService:
        async def get_resume(self, user_id: str, resume_id: str) -> Any:

            class _Resume:
                variants = []

            return _Resume()

    monkeypatch.setattr(
        "app.graphs.runtime.services_from_config",
        lambda _: type("_S", (), {"resume": _EmptyResumeService()})(),
    )

    state: dict[str, Any] = {
        "workspace": {"resume_id": "res-123"},
        "user_id": "user-1",
        "edit_instruction": "改一下",
        "pending_sse_events": [],
    }
    config = {"configurable": {}}
    result = await locate_node(state, config)
    assert result.get("edit_operations") == []
