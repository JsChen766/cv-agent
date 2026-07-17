"""Resume Edit subgraph nodes (Phase 3).

Nodes: edit_classify_node, locate_node, apply_node, edit_interrupt_node, edit_tier3_bridge_node.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel, Field

from app.graphs.streaming import (
    emit_content_diff_progress,
    emit_thinking,
    get_optional_stream_writer,
)

logger = logging.getLogger(__name__)


# ── Schemas ───────────────────────────────────────────────────────────────────


class EditClassification(BaseModel):
    tier: Literal[1, 2, 3]
    target_kind: Literal["bullet", "item", "section", "global"]
    target_id: str | None = None
    operation: dict[str, Any] | None = None  # Tier 1 only: full patch op ready to apply
    reasoning: str = ""


class EditLocation(BaseModel):
    target_id: str
    operation: dict[str, Any]
    confidence: float = Field(ge=0.0, le=1.0)


# ── Prompts ───────────────────────────────────────────────────────────────────


_CLASSIFY_SYSTEM_PROMPT = """你是简历编辑意图分类器。根据用户指令、前端提示和简历结构，判断编辑类型。

Tier 1：用户已经明确给出 bul-xxx / item-xxx / sec-xxx 格式的 id + 具体改动内容，可以直接 patch，无需再定位。
Tier 2：用户描述可以精确定位到单个 bullet、item 或 section（如"WEEX 那条第二个要点"），需要 locate LLM 二次定位。
Tier 3：全局改动（整体语气、缩短、结构大改、新增 section）或无法通过自然语言精确定位。

target_kind：
- bullet：改某个要点文字
- item：改条目字段（title/organization/日期等）
- section：改章节标题/顺序
- global：Tier 3 全局改

target_id：仅 Tier 1 需要填写，填用户或前端明确给出的 id；否则 null。

operation：仅 Tier 1 需要填写，完整的 patch op 对象。格式：
- replace_bullet: {"op": "replace_bullet", "bullet_id": "<target_id>", "text": "<根据用户指令改写后的新文本>"}
- replace_item_field: {"op": "replace_item_field", "item_id": "<target_id>", "field": "title|organization|role|start_date|end_date", "value": "<新值>"}
- delete_bullet: {"op": "delete_bullet", "bullet_id": "<target_id>"}
Tier 2/3 的 operation 填 null。

注意：如果给了 explicit_target_id 且格式合法（bul-/item-/sec- 开头），优先视为 Tier 1，并根据用户指令构造 operation。"""

_LOCATE_SYSTEM_PROMPT = """你是简历编辑定位器。根据用户的自然语言编辑指令和完整简历结构，输出：
1. target_id：精确的 bul-xxx / item-xxx / sec-xxx id（必须在上面的结构中存在）
2. operation：完整的 patch op 对象，格式参考：
   - replace_bullet: {"op": "replace_bullet", "bullet_id": "bul-xxx", "text": "新文本"}
   - replace_item_field: {"op": "replace_item_field", "item_id": "item-xxx", "field": "title"|"organization"|"role"|"start_date"|"end_date", "value": "新值"}
   - delete_bullet: {"op": "delete_bullet", "bullet_id": "bul-xxx"}
   - add_bullet: {"op": "add_bullet", "item_id": "item-xxx", "text": "新 bullet 文本", "after_bullet_id": "bul-yyy 或 null"}
3. confidence：0-1 的置信度

注意：
- target_id 必须是 structured 里真实存在的 id，不可凭空构造
- replace_bullet 的 text 必须**基于用户指令**重新改写该 bullet，不是照抄原文
- 输出 op 时，bul-/item-/sec- id 来自结构，不要替换成其他值"""


# ── Helper functions ──────────────────────────────────────────────────────────


def _summarize_structured_for_classify(structured: dict[str, Any] | None) -> str:
    if not structured:
        return "(无简历数据)"
    lines: list[str] = []
    for sec in structured.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        sec_id = sec.get("id", "?")
        sec_type = sec.get("type", "?")
        heading = sec.get("heading", "")
        lines.append(f"Section {sec_id} [{sec_type}] {heading!r}")
        for item in sec.get("items") or []:
            if not isinstance(item, dict):
                continue
            item_id = item.get("id", "?")
            title = item.get("title") or ""
            org = item.get("organization") or ""
            lines.append(f"  Item {item_id} {title!r} @ {org!r}")
            for bullet in item.get("bullets") or []:
                if not isinstance(bullet, dict):
                    continue
                bul_id = bullet.get("id", "?")
                text = bullet.get("text", "")
                lines.append(f"    Bullet {bul_id}: {text[:120]}")
    return "\n".join(lines)


def _full_structured_text(structured: dict[str, Any] | None) -> str:
    return _summarize_structured_for_classify(structured)


def _id_exists_in_structured(target_id: str, structured: dict[str, Any]) -> bool:
    for sec in structured.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        if sec.get("id") == target_id:
            return True
        for item in sec.get("items") or []:
            if not isinstance(item, dict):
                continue
            if item.get("id") == target_id:
                return True
            for bullet in item.get("bullets") or []:
                if isinstance(bullet, dict) and bullet.get("id") == target_id:
                    return True
    return False


def _compute_structured_diff(old: dict[str, Any], new: dict[str, Any]) -> dict[str, list[str]]:
    changed_bullet_ids: list[str] = []
    changed_item_ids: list[str] = []
    changed_section_ids: list[str] = []
    added_ids: list[str] = []
    removed_ids: list[str] = []

    old_by_id: dict[str, dict[str, Any]] = {}
    new_by_id: dict[str, dict[str, Any]] = {}

    for sec in old.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        sid = sec.get("id")
        if sid:
            old_by_id[sid] = sec
        for item in sec.get("items") or []:
            if not isinstance(item, dict):
                continue
            iid = item.get("id")
            if iid:
                old_by_id[iid] = item
            for b in item.get("bullets") or []:
                if isinstance(b, dict) and b.get("id"):
                    old_by_id[b["id"]] = b

    for sec in new.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        sid = sec.get("id")
        if sid:
            new_by_id[sid] = sec
        for item in sec.get("items") or []:
            if not isinstance(item, dict):
                continue
            iid = item.get("id")
            if iid:
                new_by_id[iid] = item
            for b in item.get("bullets") or []:
                if isinstance(b, dict) and b.get("id"):
                    new_by_id[b["id"]] = b

    all_ids = set(old_by_id) | set(new_by_id)

    for eid in all_ids:
        old_entity = old_by_id.get(eid)
        new_entity = new_by_id.get(eid)
        if old_entity and not new_entity:
            removed_ids.append(eid)
        elif new_entity and not old_entity:
            added_ids.append(eid)
        elif old_entity and new_entity and old_entity != new_entity:
            if eid.startswith("bul-"):
                changed_bullet_ids.append(eid)
            elif eid.startswith("item-"):
                changed_item_ids.append(eid)
            elif eid.startswith("sec-"):
                changed_section_ids.append(eid)

    return {
        "changed_bullet_ids": changed_bullet_ids,
        "changed_item_ids": changed_item_ids,
        "changed_section_ids": changed_section_ids,
        "added_ids": added_ids,
        "removed_ids": removed_ids,
    }


def _edit_confirmation_message(diff: dict[str, list[str]]) -> str:
    changed = len(diff.get("changed_bullet_ids", [])) + len(diff.get("changed_item_ids", []))
    added = len(diff.get("added_ids", []))
    removed = len(diff.get("removed_ids", []))
    parts: list[str] = []
    if changed:
        parts.append(f"修改了 {changed} 处")
    if added:
        parts.append(f"新增了 {added} 处")
    if removed:
        parts.append(f"删除了 {removed} 处")
    return "已" + "、".join(parts) + "。" if parts else "编辑已应用。"


async def _load_latest_structured(
    services: Any, user_id: str, resume_id: str
) -> dict[str, Any] | None:
    try:
        detail = await services.resume.get_resume(user_id, resume_id)
        if detail.variants:
            latest = sorted(detail.variants, key=lambda v: v.created_at, reverse=True)[0]
            return latest.structured
    except Exception:
        logger.exception("Failed to load latest structured for resume %s", resume_id)
    return None


def _build_tier3_instruction(instruction: str, current_structured: dict[str, Any] | None) -> str:
    if not current_structured:
        return instruction
    summary = _summarize_structured_for_classify(current_structured)
    return (
        f"[对话式编辑指令]\n{instruction}\n\n"
        f"[当前简历结构（请在此基础上修改，保留未涉及的内容和 source_experience_id）]\n{summary}"
    )


# ── Nodes ─────────────────────────────────────────────────────────────────────


async def edit_classify_node(
    state: dict[str, Any], config: RunnableConfig | None = None
) -> dict[str, Any]:
    from app.graphs.runtime import services_from_config
    from app.providers.factory import get_provider

    services = services_from_config(config)
    provider = get_provider()

    workspace = dict(state.get("workspace") or {})
    resume_id = workspace.get("resume_id")
    if not resume_id:
        return {
            "edit_tier": None,
            "assistant_message": "当前没有可编辑的简历，请先生成一份简历。",
            "pending_sse_events": [
                *(state.get("pending_sse_events") or []),
                {
                    "event": "agent.message.completed",
                    "content": "当前没有可编辑的简历，请先生成一份简历。",
                },
            ],
        }

    user_id = str(state.get("user_id") or "")
    current_structured: dict[str, Any] | None = None
    if services:
        try:
            detail = await services.resume.get_resume(user_id, str(resume_id))
            if detail.variants:
                latest = sorted(detail.variants, key=lambda v: v.created_at, reverse=True)[0]
                current_structured = latest.structured
        except Exception:
            pass

    structured_summary = _summarize_structured_for_classify(current_structured)
    instruction = str(state.get("edit_instruction") or state.get("intent_description") or "")
    editing_scope = str(state.get("editing_scope") or "")
    extracted = dict(state.get("extracted_params") or {})
    explicit_target_id = str(extracted.get("edit_target_id") or "")

    user_content = (
        f"用户编辑指令：{instruction}\n"
        f"editingScope（前端提示）：{editing_scope or '未指定'}\n"
        f"前端传来的 explicit_target_id：{explicit_target_id or '无'}\n\n"
        f"当前简历结构摘要（含所有 id）：\n{structured_summary}"
    )

    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在理解你的简历修改要求…")

    result: EditClassification = await provider.chat_structured(
        [
            {"role": "system", "content": _CLASSIFY_SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        EditClassification,
        temperature=0.1,
    )

    if (
        result.tier == 1
        and result.target_id
        and current_structured
        and not _id_exists_in_structured(result.target_id, current_structured)
    ):
        result = result.model_copy(update={"tier": 2, "target_id": None, "operation": None})

    # Tier 1: populate edit_operations so apply_node can proceed without locate_node
    existing_operations = list(state.get("edit_operations") or [])
    edit_operations: list[dict[str, Any]] = []
    if result.tier == 1 and result.operation:
        edit_operations = [result.operation]
    elif result.tier == 1 and existing_operations:
        edit_operations = existing_operations
    elif result.tier == 1 and not result.operation:
        # classify said Tier 1 but gave no operation → downgrade to Tier 2
        result = result.model_copy(update={"tier": 2})

    return {
        "edit_tier": result.tier,
        "edit_target_kind": result.target_kind,
        "edit_target_id": result.target_id,
        "edit_operations": edit_operations,
    }


async def locate_node(
    state: dict[str, Any], config: RunnableConfig | None = None
) -> dict[str, Any]:
    from app.graphs.runtime import services_from_config
    from app.providers.factory import get_provider

    services = services_from_config(config)
    provider = get_provider()
    user_id = str(state.get("user_id") or "")
    workspace = dict(state.get("workspace") or {})
    resume_id = workspace.get("resume_id")

    current_structured = await _load_latest_structured(services, user_id, str(resume_id))
    if not current_structured:
        return {
            "edit_operations": [],
            "assistant_message": "找不到当前简历数据，请重新打开简历后再试。",
            "pending_sse_events": [
                *(state.get("pending_sse_events") or []),
                {
                    "event": "agent.message.completed",
                    "content": "找不到当前简历数据，请重新打开简历后再试。",
                },
            ],
        }

    instruction = str(state.get("edit_instruction") or state.get("intent_description") or "")
    full_structured_text = _full_structured_text(current_structured)

    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在定位需要修改的简历内容…")

    result: EditLocation = await provider.chat_structured(
        [
            {"role": "system", "content": _LOCATE_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"用户编辑指令：{instruction}\n\n完整简历结构（含所有 id）：\n{full_structured_text}",
            },
        ],
        EditLocation,
        temperature=0.1,
    )

    if not _id_exists_in_structured(result.target_id, current_structured):
        return {
            "edit_operations": [],
            "assistant_message": f"未能在当前简历中定位到目标（{result.target_id}），请描述得更具体一些。",
            "pending_sse_events": [
                *(state.get("pending_sse_events") or []),
                {
                    "event": "agent.message.completed",
                    "content": f"未能在当前简历中定位到目标（{result.target_id}），请描述得更具体一些。",
                },
            ],
        }

    return {
        "edit_target_id": result.target_id,
        "edit_operations": [result.operation],
    }


async def apply_node(state: dict[str, Any], config: RunnableConfig | None = None) -> dict[str, Any]:
    from app.graphs.runtime import services_from_config

    user_id = str(state.get("user_id") or "")
    workspace = dict(state.get("workspace") or {})
    resume_id = str(workspace.get("resume_id") or "")
    operations = list(state.get("edit_operations") or [])
    require_review = bool(state.get("require_review_before_apply"))
    existing_events = list(state.get("pending_sse_events") or [])
    events: list[dict[str, Any]] = list(existing_events)

    if not resume_id:
        return {
            "assistant_message": "当前没有可编辑的简历。",
            "pending_sse_events": [
                *events,
                {"event": "agent.message.completed", "content": "当前没有可编辑的简历。"},
            ],
        }
    if not operations:
        return {
            "assistant_message": "未能确定编辑操作，请描述得更具体一些。",
            "pending_sse_events": [
                *events,
                {
                    "event": "agent.message.completed",
                    "content": "未能确定编辑操作，请描述得更具体一些。",
                },
            ],
        }

    services = services_from_config(config)
    if not services:
        raise RuntimeError("services unavailable in apply_node")

    detail = await services.resume.get_resume(user_id, resume_id)
    if not detail.variants:
        return {
            "assistant_message": "找不到简历草稿。",
            "pending_sse_events": [
                *events,
                {"event": "agent.message.completed", "content": "找不到简历草稿。"},
            ],
        }
    old_variant = sorted(detail.variants, key=lambda v: v.created_at, reverse=True)[0]
    old_structured = old_variant.structured or {}

    new_variant = await services.resume.patch_variant(user_id, old_variant.id, operations)
    layout_report = getattr(new_variant, "layout_report", None)
    layout_quality_status = getattr(new_variant, "quality_status", None)

    diff = _compute_structured_diff(old_structured, new_variant.structured or {})

    if require_review:
        return {
            "edit_new_structured": new_variant.structured,
            "edit_new_content": new_variant.content,
            "edit_new_variant_id": new_variant.id,
            "edit_diff": diff,
            "layout_report": (
                layout_report.model_dump(mode="json") if layout_report is not None else None
            ),
            "quality_status": layout_quality_status,
            "workspace": workspace,
            "pending_sse_events": events,
        }

    writer = get_optional_stream_writer()
    buffered_events: list[dict[str, Any]] = []
    event_writer = writer or buffered_events.append
    emit_thinking(event_writer, "修改已完成，正在逐段更新简历…")
    await emit_content_diff_progress(
        event_writer,
        new_variant.content,
        resume_id=resume_id,
        variant_id=new_variant.id,
        structured=new_variant.structured,
        diff=diff,
        frame_delay=0.018 if writer is not None else 0,
    )
    events.extend(buffered_events)

    confirmation_msg = _edit_confirmation_message(diff)
    if layout_quality_status == "needs_revision":
        confirmation_msg += " 当前版本尚未通过版面标准，请继续调整"
    events.append({"event": "agent.message.completed", "content": confirmation_msg})

    return {
        "assistant_message": confirmation_msg,
        "edit_new_variant_id": new_variant.id,
        "edit_diff": diff,
        "layout_report": (
            layout_report.model_dump(mode="json") if layout_report is not None else None
        ),
        "quality_status": layout_quality_status,
        "workspace": workspace,
        "pending_sse_events": events,
    }


async def edit_interrupt_node(
    state: dict[str, Any], config: RunnableConfig | None = None
) -> dict[str, Any]:
    import uuid

    from langgraph.types import interrupt

    interrupt_id = str(uuid.uuid4())
    workspace = dict(state.get("workspace") or {})
    diff = state.get("edit_diff") or {}
    new_structured = state.get("edit_new_structured")
    new_content = state.get("edit_new_content") or ""
    new_variant_id = state.get("edit_new_variant_id") or ""
    layout_report = state.get("layout_report")
    quality_status = state.get("quality_status")
    review_message = (
        "已完成编辑，但当前版本尚未通过版面标准，请继续调整。"
        if quality_status == "needs_revision"
        else "已完成编辑，请确认修改是否符合预期。"
    )

    payload = {
        "interrupt_id": interrupt_id,
        "type": "resume_edit_review",
        "message": review_message,
        "resume": {
            "structured": new_structured,
            "content": new_content,
            "id": new_variant_id,
        },
        "diff": diff,
        "layout_report": layout_report,
        "quality_status": quality_status,
        "action_options": [
            {"id": "accept", "label": "应用修改", "description": "确认并保存此次编辑"},
            {"id": "discard", "label": "撤销", "description": "放弃此次编辑，恢复原版"},
        ],
        "workspace": workspace,
    }

    existing_events = list(state.get("pending_sse_events") or [])
    events: list[dict[str, Any]] = list(existing_events)
    events.append(
        {
            "event": "agent.interrupt",
            "interrupt_id": interrupt_id,
            "type": "resume_edit_review",
            "message": payload["message"],
            "resume": payload["resume"],
            "diff": diff,
            "layout_report": layout_report,
            "quality_status": quality_status,
            "variants": [],
            "action_options": payload["action_options"],
        }
    )

    resume_value = interrupt(payload)

    action = None
    if isinstance(resume_value, dict):
        action = resume_value.get("action") or resume_value.get("decision")

    if action in ("accept", "confirm"):
        events.append({"event": "agent.message.completed", "content": "编辑已应用。"})
        return {
            "assistant_message": "编辑已应用。",
            "pending_sse_events": events,
            "workspace": workspace,
        }
    else:
        events.append({"event": "agent.message.completed", "content": "已撤销本次编辑。"})
        return {
            "assistant_message": "已撤销本次编辑。",
            "pending_sse_events": events,
            "workspace": workspace,
        }


async def edit_tier3_bridge_node(
    state: dict[str, Any], config: RunnableConfig | None = None
) -> dict[str, Any]:
    from app.graphs.resume.graph import build_resume_subgraph
    from app.graphs.runtime import services_from_config

    services = services_from_config(config)
    user_id = str(state.get("user_id") or "")
    workspace = dict(state.get("workspace") or {})
    resume_id = str(workspace.get("resume_id") or "")
    instruction = str(state.get("edit_instruction") or state.get("intent_description") or "")

    current_structured: dict[str, Any] | None = None
    if services and resume_id:
        try:
            detail = await services.resume.get_resume(user_id, resume_id)
            if detail.variants:
                latest = sorted(detail.variants, key=lambda v: v.created_at, reverse=True)[0]
                current_structured = latest.structured
        except Exception:
            pass

    grounded_instruction = _build_tier3_instruction(instruction, current_structured)

    # Use the same checkpointer that the main graph uses so LangGraph interrupts
    # (interrupt()) inside resume_generation can persist state for resume.
    checkpointer = (config or {}).get("configurable", {}).get("checkpointer")  # type: ignore[union-attr]
    resume_graph = build_resume_subgraph().compile(checkpointer=checkpointer)
    sub_state: dict[str, Any] = {
        **state,
        "target_subgraph": "resume_generation",
        "intent_description": grounded_instruction,
        "previous_structured": current_structured,
    }
    result = await resume_graph.ainvoke(sub_state, config=config)

    return {
        "assistant_message": result.get("assistant_message"),
        "pending_sse_events": result.get("pending_sse_events", []),
        "interrupt_payload": result.get("interrupt_payload"),
        "workspace": result.get("workspace", workspace),
        "resume_user_action": result.get("resume_user_action"),
        "revision_instruction": result.get("revision_instruction"),
    }
