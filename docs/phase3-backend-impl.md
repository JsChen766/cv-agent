# Phase 3 后端实现文档 — 对话式简历编辑（resume_edit 子图）

**适用版本**: chy_temp 分支，Phase 2 已合并（`parent_variant_id` 列已存在，`patch_variant` service 已就位，`apply_patch_operations` 纯函数已在 `app/domain/resume/patch.py`）

**前置假设**（不需要再做）:
- `resume_variants.parent_variant_id` 列已存在（migration 0013 已跑）
- `ResumeService.patch_variant()` 已实现，调用 `apply_patch_operations` + `_repo.patch_variant_structured`
- `app/domain/resume/patch.py` 中 `apply_patch_operations` 纯函数已就位
- `render_structured_to_markdown` 已在 `app/domain/resume/render.py`

---

## 1. 总体架构

```
POST /copilot/chat/stream
  → router_node  (新增 edit_resume 意图)
  → resume_edit 子图
      ├─ edit_classify_node   (分 Tier)
      ├─ Tier 1: apply_node   (前端直接给 id + text → 直调 patch，无 LLM)
      ├─ Tier 2: locate_node → apply_node → (可选) edit_interrupt_node
      └─ Tier 3: edit_tier3_bridge_node → 走既有 resume_generation 子图
```

Tier 2 默认**不走 interrupt**，直接把新 structured 发回 SSE（`content.diff.*`）。  
Tier 3 **强制走 interrupt**，复用 `resume_review` interrupt 机制，payload 多携带 `diff`。

---

## 2. 需要修改/新建的文件清单

```
app/graphs/state.py                          修改 — 新增 edit 相关字段
app/graphs/router.py                         修改 — 新增 edit_resume 意图 + heuristic
app/graphs/main.py                           修改 — 挂载 resume_edit 子图
app/graphs/resume/nodes.py                   修改 — _assign_structure_ids id 复用逻辑
app/core/events.py                           修改 — AgentInterruptEvent 新增类型
app/graphs/resume/edit/                      新建目录
app/graphs/resume/edit/__init__.py           新建（空文件）
app/graphs/resume/edit/state.py              新建
app/graphs/resume/edit/nodes.py              新建
app/graphs/resume/edit/graph.py              新建
tests/unit/graphs/test_resume_edit.py        新建
```

---

## 3. `app/graphs/state.py` — 新增字段

在 `MainState` 末尾追加以下字段（`total=False` 已有，直接加）：

```python
# Resume conversational edit (Phase 3)
edit_instruction: str | None          # 用户的自然语言编辑指令，由 router 从 latest message 提取
editing_scope: str | None             # 前端传来：'bullet' | 'section' | 'global' | None
require_review_before_apply: bool | None  # 前端传来：True 强制 Tier 2 也走 interrupt
edit_diff: dict[str, Any] | None      # apply_node 产出：记录变动 id 集合，用于 SSE diff 高亮
```

---

## 4. `app/graphs/resume/edit/state.py` — 子图专属 State

```python
"""ResumeEditState — resume_edit 子图专属状态。"""
from __future__ import annotations
from typing import Any
from app.graphs.state import MainState


class ResumeEditState(MainState, total=False):
    # Tier 判定结果
    edit_tier: int | None                    # 1 | 2 | 3
    edit_target_kind: str | None             # 'bullet' | 'item' | 'section' | 'global'
    edit_target_id: str | None               # Tier 1/2：前端/LLM 给出的精确 id
    edit_operations: list[dict[str, Any]]    # Tier 1/2：patch op 列表（classify 或 locate 产出）

    # Tier 2/3 产出
    edit_new_structured: dict[str, Any] | None   # apply_node 成功后的新 structured
    edit_new_content: str | None                  # 对应 markdown
    edit_new_variant_id: str | None               # 持久化后新 variant 的 id
```

---

## 5. `app/graphs/resume/edit/nodes.py` — 四个节点

### 5.1 `edit_classify_node`

**职责**: 小 LLM 一次调用，判断 Tier + target_kind + target_id（仅 Tier 1 直接给 id）。

**Schema**（`EditClassification`，Pydantic v2）:
```python
class EditClassification(BaseModel):
    tier: Literal[1, 2, 3]
    target_kind: Literal["bullet", "item", "section", "global"]
    target_id: str | None = None   # Tier 1: 前端或明确语义中确定的 id；其余 None
    reasoning: str = ""            # 内部 debug，不对外暴露
```

**Tier 判定规则（写入 system prompt）**:
- **Tier 1**: 用户消息或 `extracted_params.edit_target_id` 中**已经明确给出** `bul-xxx` / `item-xxx` / `sec-xxx` 格式 id 且有具体修改内容 → 直调 patch，不再走 locate LLM
- **Tier 2**: 能通过自然语言定位到单个 bullet/item/section（如"把 WEEX 那条第二个 bullet"）→ locate_node 做二次定位
- **Tier 3**: 全局改动（"整体"、"缩短"、"语气"、"加一个 section"）或无法精确定位 → 走 resume_generation 主链

**实现要点**:

```python
async def edit_classify_node(
    state: ResumeEditState, config: RunnableConfig | None = None
) -> dict[str, object]:
    from app.providers.factory import get_provider
    from app.graphs.runtime import services_from_config

    services = services_from_config(config)
    provider = get_provider()

    workspace = dict(state.get("workspace") or {})
    resume_id = workspace.get("resume_id")
    if not resume_id:
        # workspace 里没有 resume_id，无法编辑，退出
        return {
            "edit_tier": None,
            "assistant_message": "当前没有可编辑的简历，请先生成一份简历。",
            "pending_sse_events": [
                *(state.get("pending_sse_events") or []),
                {"event": "agent.message.completed", "content": "当前没有可编辑的简历，请先生成一份简历。"},
            ],
        }

    # 拉取当前 variant 的 structured，提供给 LLM 做 Tier 判定
    user_id = str(state.get("user_id") or "")
    current_structured: dict | None = None
    if services:
        try:
            detail = await services.resume.get_resume(user_id, str(resume_id))
            if detail.variants:
                # 取最新 variant（按 created_at DESC，取 index 0）
                latest = sorted(detail.variants, key=lambda v: v.created_at, reverse=True)[0]
                current_structured = latest.structured
        except Exception:
            pass

    structured_summary = _summarize_structured_for_classify(current_structured)
    instruction = str(state.get("edit_instruction") or state.get("intent_description") or "")
    editing_scope = str(state.get("editing_scope") or "")
    extracted = dict(state.get("extracted_params") or {})
    explicit_target_id = str(extracted.get("edit_target_id") or "")

    system = _CLASSIFY_SYSTEM_PROMPT
    user_content = (
        f"用户编辑指令：{instruction}\n"
        f"editingScope（前端提示）：{editing_scope or '未指定'}\n"
        f"前端传来的 explicit_target_id：{explicit_target_id or '无'}\n\n"
        f"当前简历结构摘要（含所有 id）：\n{structured_summary}"
    )

    result: EditClassification = await provider.chat_structured(
        [{"role": "system", "content": system}, {"role": "user", "content": user_content}],
        EditClassification,
        temperature=0.1,
    )

    # Tier 1 边界校验：如果给了 target_id 但该 id 不存在于 structured → 降为 Tier 2
    if result.tier == 1 and result.target_id and current_structured:
        if not _id_exists_in_structured(result.target_id, current_structured):
            result = result.model_copy(update={"tier": 2, "target_id": None})

    return {
        "edit_tier": result.tier,
        "edit_target_kind": result.target_kind,
        "edit_target_id": result.target_id,
    }
```

**`_summarize_structured_for_classify`**: 遍历 structured，产出如下文本（控制在 2000 token 内）：
```
Section sec-xxxx [experience] "工作经历"
  Item item-yyyy "AI算法工程师" @ 江西新华云
    Bullet bul-aaaa: "主导处理30万+条语料库..."
    Bullet bul-bbbb: "管理300万+条关键词库..."
  Item item-zzzz "数据分析实习生" @ WEEX
    Bullet bul-cccc: "编写95+复杂SQL脚本..."
    Bullet bul-dddd: "交付50+个Power BI看板..."
Section sec-xxxx [education] "教育背景"
  ...
```

**`_CLASSIFY_SYSTEM_PROMPT`**（中文，精简）：
```python
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

注意：如果给了 explicit_target_id 且格式合法（bul-/item-/sec- 开头），优先视为 Tier 1。"""
```

---

### 5.2 `locate_node`

**职责**: Tier 2 专用，LLM 读当前完整 structured + 用户指令，输出精确 target_id + 新内容/操作。

**Schema**（`EditLocation`，Pydantic v2）:
```python
class EditLocation(BaseModel):
    target_id: str                   # bul-xxx / item-xxx / sec-xxx，必须存在于 structured
    operation: dict[str, Any]        # 完整 patch op，如 {"op": "replace_bullet", "bullet_id": "bul-xxx", "text": "..."}
    confidence: float = Field(ge=0.0, le=1.0)
```

**实现要点**:

```python
async def locate_node(
    state: ResumeEditState, config: RunnableConfig | None = None
) -> dict[str, object]:
    from app.providers.factory import get_provider
    from app.graphs.runtime import services_from_config

    services = services_from_config(config)
    provider = get_provider()
    user_id = str(state.get("user_id") or "")
    workspace = dict(state.get("workspace") or {})
    resume_id = workspace.get("resume_id")

    # 拉取最新 variant structured（复用 edit_classify_node 的逻辑，或从 state 里已存的字段取）
    current_structured = await _load_latest_structured(services, user_id, str(resume_id))
    if not current_structured:
        return {
            "edit_operations": [],
            "assistant_message": "找不到当前简历数据，请重新打开简历后再试。",
            "pending_sse_events": [
                *(state.get("pending_sse_events") or []),
                {"event": "agent.message.completed", "content": "找不到当前简历数据，请重新打开简历后再试。"},
            ],
        }

    instruction = str(state.get("edit_instruction") or state.get("intent_description") or "")
    full_structured_text = _full_structured_text(current_structured)  # 同 _summarize_structured_for_classify 但不截断

    system = _LOCATE_SYSTEM_PROMPT
    user_content = (
        f"用户编辑指令：{instruction}\n\n"
        f"完整简历结构（含所有 id）：\n{full_structured_text}"
    )

    result: EditLocation = await provider.chat_structured(
        [{"role": "system", "content": system}, {"role": "user", "content": user_content}],
        EditLocation,
        temperature=0.1,
    )

    # 校验 target_id 确实存在
    if not _id_exists_in_structured(result.target_id, current_structured):
        return {
            "edit_operations": [],
            "assistant_message": f"未能在当前简历中定位到目标（{result.target_id}），请描述得更具体一些。",
            "pending_sse_events": [
                *(state.get("pending_sse_events") or []),
                {"event": "agent.message.completed", "content": f"未能在当前简历中定位到目标（{result.target_id}），请描述得更具体一些。"},
            ],
        }

    return {
        "edit_target_id": result.target_id,
        "edit_operations": [result.operation],
    }
```

**`_LOCATE_SYSTEM_PROMPT`**（中文）：
```python
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
```

---

### 5.3 `apply_node`

**职责**: Tier 1 / Tier 2 共用。调用 `services.resume.patch_variant` 生成新 variant，产出 diff，发 `content.diff.*` SSE。

```python
async def apply_node(
    state: ResumeEditState, config: RunnableConfig | None = None
) -> dict[str, object]:
    from app.graphs.runtime import services_from_config, thread_id_from_config
    from app.graphs.tracing import tool_started, tool_completed

    services = services_from_config(config)
    if not services:
        raise RuntimeError("services unavailable in apply_node")

    user_id = str(state.get("user_id") or "")
    workspace = dict(state.get("workspace") or {})
    resume_id = str(workspace.get("resume_id") or "")
    operations = list(state.get("edit_operations") or [])
    require_review = bool(state.get("require_review_before_apply"))
    existing_events = list(state.get("pending_sse_events") or [])
    events: list[dict] = list(existing_events)

    if not resume_id:
        return {
            "assistant_message": "当前没有可编辑的简历。",
            "pending_sse_events": [*events, {"event": "agent.message.completed", "content": "当前没有可编辑的简历。"}],
        }
    if not operations:
        return {
            "assistant_message": "未能确定编辑操作，请描述得更具体一些。",
            "pending_sse_events": [*events, {"event": "agent.message.completed", "content": "未能确定编辑操作，请描述得更具体一些。"}],
        }

    # 拿到当前 variant（最新）
    detail = await services.resume.get_resume(user_id, resume_id)
    if not detail.variants:
        return {"assistant_message": "找不到简历草稿。", "pending_sse_events": [*events, {"event": "agent.message.completed", "content": "找不到简历草稿。"}]}
    old_variant = sorted(detail.variants, key=lambda v: v.created_at, reverse=True)[0]
    old_structured = old_variant.structured or {}

    # 调 patch_variant（内部做 apply_patch_operations + 写 DB 新行）
    new_variant = await services.resume.patch_variant(user_id, old_variant.id, operations)

    # 计算 diff
    diff = _compute_structured_diff(old_structured, new_variant.structured or {})

    # 更新 workspace
    workspace["resume_id"] = resume_id  # 不变；variant_id 可选存，前端用 resume_id 重拉

    if require_review:
        # 前端要求 Tier 2 也走 interrupt：走 edit_interrupt_node（见 §5.4）
        return {
            "edit_new_structured": new_variant.structured,
            "edit_new_content": new_variant.content,
            "edit_new_variant_id": new_variant.id,
            "edit_diff": diff,
            "workspace": workspace,
            "pending_sse_events": events,  # interrupt node 会追加
        }

    # 默认：直出，不走 interrupt
    # 发 content.diff.* SSE，让前端画布实时更新
    events.append({
        "event": "content.diff.started",
        "resume_id": resume_id,
        "variant_id": new_variant.id,
    })
    events.append({
        "event": "content.diff.delta",
        "operations": [{"op": "insert", "text": new_variant.content}],
        "structured": new_variant.structured,
        "diff": diff,
    })
    events.append({
        "event": "content.diff.completed",
        "resume_id": resume_id,
        "variant_id": new_variant.id,
        "total_insertions": 1,
        "diff": diff,
    })

    confirmation_msg = _edit_confirmation_message(diff)
    events.append({"event": "agent.message.completed", "content": confirmation_msg})

    return {
        "assistant_message": confirmation_msg,
        "edit_new_variant_id": new_variant.id,
        "edit_diff": diff,
        "workspace": workspace,
        "pending_sse_events": events,
    }
```

**`_compute_structured_diff`** — 纯函数，对比 old/new structured，返回：
```python
def _compute_structured_diff(
    old: dict[str, Any], new: dict[str, Any]
) -> dict[str, list[str]]:
    """
    Returns:
      {
        "changed_bullet_ids": [...],
        "changed_item_ids": [...],
        "changed_section_ids": [...],
        "added_ids": [...],      # bul- / item- / sec- 新增的
        "removed_ids": [...],    # bul- / item- / sec- 删除的
      }
    """
```

实现：递归遍历 sections/items/bullets，按 id 做集合对比 + 文本对比。

**`_edit_confirmation_message`**：
```python
def _edit_confirmation_message(diff: dict[str, list[str]]) -> str:
    changed = len(diff.get("changed_bullet_ids", [])) + len(diff.get("changed_item_ids", []))
    added = len(diff.get("added_ids", []))
    removed = len(diff.get("removed_ids", []))
    parts = []
    if changed: parts.append(f"修改了 {changed} 处")
    if added: parts.append(f"新增了 {added} 处")
    if removed: parts.append(f"删除了 {removed} 处")
    return "已" + "、".join(parts) + "。" if parts else "编辑已应用。"
```

---

### 5.4 `edit_interrupt_node`（仅当 `require_review_before_apply=True` 时经过）

**职责**: Tier 2 + `require_review=True` 时，让用户确认后再落库。

```python
async def edit_interrupt_node(
    state: ResumeEditState, config: RunnableConfig | None = None
) -> dict[str, object]:
    from langgraph.types import interrupt
    import uuid

    interrupt_id = str(uuid.uuid4())
    workspace = dict(state.get("workspace") or {})
    resume_id = str(workspace.get("resume_id") or "")
    diff = state.get("edit_diff") or {}
    new_structured = state.get("edit_new_structured")
    new_content = state.get("edit_new_content") or ""
    new_variant_id = state.get("edit_new_variant_id") or ""

    payload = {
        "interrupt_id": interrupt_id,
        "type": "resume_edit_review",
        "message": "已完成编辑，请确认修改是否符合预期。",
        "resume": {
            "structured": new_structured,
            "content": new_content,
            "id": new_variant_id,
        },
        "diff": diff,
        "action_options": [
            {"id": "accept", "label": "应用修改", "description": "确认并保存此次编辑"},
            {"id": "discard", "label": "撤销", "description": "放弃此次编辑，恢复原版"},
        ],
        "workspace": workspace,
    }

    existing_events = list(state.get("pending_sse_events") or [])
    events: list[dict] = list(existing_events)
    events.append({
        "event": "agent.interrupt",
        "interrupt_id": interrupt_id,
        "type": "resume_edit_review",
        "message": payload["message"],
        "resume": payload["resume"],
        "diff": diff,
        "variants": [],
        "action_options": payload["action_options"],
    })

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
        # discard: 新 variant 已在 DB，但因为 parent_variant_id 存在，回退只需前端拿 parent_variant_id
        events.append({"event": "agent.message.completed", "content": "已撤销本次编辑。"})
        return {
            "assistant_message": "已撤销本次编辑。",
            "pending_sse_events": events,
            "workspace": workspace,
        }
```

---

### 5.5 `edit_tier3_bridge_node`

**职责**: Tier 3 分支入口，把编辑指令 + 当前 structured 打包成 `revision_instruction`，然后**退出 resume_edit 子图**，让 router 重新路由到 `resume_generation`（通过修改 `target_subgraph`）。

**原理**: LangGraph 允许子图节点直接写 `target_subgraph` + `intent_description`；main graph 在 resume_edit → END 之后**本轮不再重路由**，所以这里用的方法是：直接在节点内部拉起 `resume_generation` 子图**作为服务调用**（不通过 LangGraph 路由），并把结果 merge 回 state。

**实现（直接调用子图 graph 的 invoke）**:

```python
async def edit_tier3_bridge_node(
    state: ResumeEditState, config: RunnableConfig | None = None
) -> dict[str, object]:
    from app.graphs.runtime import services_from_config
    from app.graphs.resume.graph import build_resume_subgraph

    services = services_from_config(config)
    user_id = str(state.get("user_id") or "")
    workspace = dict(state.get("workspace") or {})
    resume_id = str(workspace.get("resume_id") or "")
    instruction = str(state.get("edit_instruction") or state.get("intent_description") or "")

    # 拉取当前 structured 作为 grounding
    current_structured: dict | None = None
    if services and resume_id:
        try:
            detail = await services.resume.get_resume(user_id, resume_id)
            if detail.variants:
                latest = sorted(detail.variants, key=lambda v: v.created_at, reverse=True)[0]
                current_structured = latest.structured
        except Exception:
            pass

    # 组装 previous_structured 描述，注入到 intent_description
    grounded_instruction = _build_tier3_instruction(instruction, current_structured)

    # 直接 invoke resume_generation 子图（带 config，让 checkpointer/services 穿透）
    resume_graph = build_resume_subgraph().compile()
    sub_state = {
        **state,
        "target_subgraph": "resume_generation",
        "intent_description": grounded_instruction,
        "previous_structured": current_structured,  # 新增字段，_assign_structure_ids 会读它做 id 复用
    }
    result = await resume_graph.ainvoke(sub_state, config=config)

    # Merge 结果回 MainState
    return {
        "assistant_message": result.get("assistant_message"),
        "pending_sse_events": result.get("pending_sse_events", []),
        "interrupt_payload": result.get("interrupt_payload"),
        "workspace": result.get("workspace", workspace),
        "resume_user_action": result.get("resume_user_action"),
        "revision_instruction": result.get("revision_instruction"),
    }


def _build_tier3_instruction(instruction: str, current_structured: dict | None) -> str:
    """把用户指令 + 当前 structured 摘要 merge 成 resume_generation 的 intent_description。"""
    if not current_structured:
        return instruction
    summary = _summarize_structured_for_classify(current_structured)  # 复用
    return (
        f"[对话式编辑指令]\n{instruction}\n\n"
        f"[当前简历结构（请在此基础上修改，保留未涉及的内容和 source_experience_id）]\n{summary}"
    )
```

**关键**：`previous_structured` 字段需要在 `MainState` / `ResumeGenerationState` 加（见第 6 节），并在 `_assign_structure_ids` 里消费。

---

## 6. `app/graphs/resume/nodes.py` — `_assign_structure_ids` id 复用

**目标**: Tier 3 生成时，若新 item 的 `source_experience_id` 与旧 structured 里某个 item 的 `source_experience_id` 相同，则复用旧 item 的 id 及其 bullet id（按 bullet 文本相似度贪心匹配）。

**在 `_assign_structure_ids` 签名里加 `previous_structured` 参数**:

```python
def _assign_structure_ids(
    llm: _LlmResumeStructure,
    fallback_contact: dict[str, object] | None = None,
    previous_structured: dict[str, object] | None = None,   # 新增
) -> dict[str, object]:
```

**在函数顶部，构建 "source_experience_id → (item_id, bullet_id_list)" 的映射**:

```python
# 从 previous_structured 构建 id 复用表
_prev_item_by_src: dict[str, dict] = {}    # source_experience_id → prev item dict
if previous_structured:
    for prev_sec in (previous_structured.get("sections") or []):
        for prev_item in (prev_sec.get("items") or []):
            src_id = prev_item.get("source_experience_id")
            if src_id:
                _prev_item_by_src[src_id] = prev_item
```

**在 item 循环里复用 id**（替换原来 `item-{uuid.uuid4()}` 的赋值）：

```python
for item in section.items:
    # 复用旧 item id
    prev_item = _prev_item_by_src.get(item.source_experience_id) if item.source_experience_id else None
    item_id = prev_item["id"] if prev_item else f"item-{uuid.uuid4()}"

    # 复用旧 bullet id（按位置贪心：位置相同且文本相似度 > 0.6 时复用）
    prev_bullets: list[dict] = prev_item.get("bullets", []) if prev_item else []
    bullets_out = []
    for bi, b in enumerate(item.bullets):
        if bi < len(prev_bullets) and _text_similarity(b.text, prev_bullets[bi].get("text", "")) > 0.6:
            bul_id = prev_bullets[bi]["id"]
        else:
            bul_id = f"bul-{uuid.uuid4()}"
        bullets_out.append({
            "id": bul_id,
            "text": b.text,
            "matched_jd_requirement_ids": list(b.matched_jd_requirement_ids),
        })

    item_dict: dict[str, object] = {
        "id": item_id,
        "title": item.title,
        "organization": item.organization,
        "role": item.role,
        "start_date": item.start_date,
        "end_date": item.end_date,
        "source_experience_id": item.source_experience_id,
        "bullets": bullets_out,
        "raw_text": item.raw_text,
    }
```

**`_text_similarity`**（简单 char overlap ratio，domain 层纯函数）：
```python
def _text_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    set_a, set_b = set(a), set(b)
    return len(set_a & set_b) / max(len(set_a), len(set_b))
```

**调用处（`draft_generation_node` 调用 `_assign_structure_ids` 的地方）**，补传 `previous_structured`：
```python
# 从 state 里读（由 edit_tier3_bridge_node 写入）
previous_structured = state.get("previous_structured")
structured = _assign_structure_ids(llm_result, fallback_contact=..., previous_structured=previous_structured)
```

需要在 `ResumeGenerationState` 加 `previous_structured: dict | None` 字段（在 `app/graphs/resume/state.py`）：
```python
previous_structured: dict[str, Any] | None   # Tier 3 编辑时传入，用于 id 复用
```

---

## 7. `app/graphs/resume/edit/graph.py` — 子图结构

```python
"""Resume Edit subgraph (Phase 3)."""
from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.graphs.resume.edit.nodes import (
    apply_node,
    edit_classify_node,
    edit_interrupt_node,
    edit_tier3_bridge_node,
    locate_node,
)
from app.graphs.resume.edit.state import ResumeEditState


def _tier_route(state: ResumeEditState) -> str:
    tier = state.get("edit_tier")
    if tier is None:
        return "end"           # guard: classify 已输出 error message，直接结束
    if tier == 1:
        return "apply"
    if tier == 2:
        return "locate"
    return "tier3"             # tier == 3


def _apply_route(state: ResumeEditState) -> str:
    """After apply: if require_review → interrupt node; else → end."""
    if state.get("require_review_before_apply"):
        return "interrupt"
    return "end"


def _locate_route(state: ResumeEditState) -> str:
    """After locate: if operations produced → apply; else → end (error already in events)."""
    ops = state.get("edit_operations")
    if ops:
        return "apply"
    return "end"


def build_resume_edit_subgraph() -> StateGraph[ResumeEditState]:
    builder = StateGraph(ResumeEditState)

    builder.add_node("classify", edit_classify_node)
    builder.add_node("locate", locate_node)
    builder.add_node("apply", apply_node)
    builder.add_node("interrupt", edit_interrupt_node)
    builder.add_node("tier3", edit_tier3_bridge_node)

    builder.add_edge(START, "classify")
    builder.add_conditional_edges("classify", _tier_route, {
        "apply": "apply",
        "locate": "locate",
        "tier3": "tier3",
        "end": END,
    })
    builder.add_conditional_edges("locate", _locate_route, {
        "apply": "apply",
        "end": END,
    })
    builder.add_conditional_edges("apply", _apply_route, {
        "interrupt": "interrupt",
        "end": END,
    })
    builder.add_edge("interrupt", END)
    builder.add_edge("tier3", END)

    return builder
```

---

## 8. `app/graphs/router.py` — 新增 `edit_resume` 意图

### 8.1 RouterOutput 新增枚举值

```python
target_subgraph: Literal[
    "experience_import",
    "jd",
    "resume_generation",
    "application_package",
    "artifact",
    "open_ended",
    "clarify",
    "edit_resume",     # 新增
]
```

### 8.2 System prompt 新增路由说明

在 `_ROUTER_SYSTEM` 的路由选项列表里追加：
```
- "edit_resume": 用户想对**已存在的简历**做局部或全局编辑。触发条件：workspace 里有 resume_id，且用户消息包含编辑意图（改、换、删、加、侧重、缩短、精简、更正式、更详细等）。
  注意：仅当 workspace 有 resume_id 时才能路由到 edit_resume，否则路由到 resume_generation。
```

在 `Important routing guidance` 里追加：
```
- workspace.resume_id 非空 + 编辑词汇 → "edit_resume"（优先级高于 resume_generation）
- "把简历改得更精简" 且有 resume_id → edit_resume
- "帮我生成一份简历" 无 resume_id → resume_generation（不是 edit_resume）
```

### 8.3 Heuristic route — 在 `_heuristic_route` 里新增 edit_resume 分支

在函数末尾的 `artifact_map` 判断之前，添加：

```python
edit_terms = (
    "改一下", "修改", "改成", "改得", "改为", "更改",
    "换成", "替换", "删掉", "删除", "去掉",
    "加一条", "再加", "新增一条", "补充",
    "侧重", "强调", "突出",
    "缩短", "精简", "压缩", "砍到",
    "更正式", "更详细", "更简洁", "更专业",
    "整体语气", "全部改",
)
has_edit_intent = any(term in lower for term in edit_terms)
has_active_resume = bool(workspace.get("resume_id") if isinstance(workspace, dict) else False)

# _heuristic_route 没有 workspace 参数，所以从 existing_extracted 拿 resume_id 判断
# 修改函数签名：加 has_active_resume: bool = False 参数（在 router_node 调用处传入）
if has_edit_intent and has_active_resume:
    return RouterOutput(
        target_subgraph="edit_resume",
        intent_description="对当前简历进行对话式编辑。",
        context_hints=["active_resume"],
        extracted_params={},
        confidence=0.92,
    )
```

**注意**：`_heuristic_route` 当前签名是 `(user_msg, existing_extracted, *, has_active_jd)`，需要加 `has_active_resume: bool = False`，并在 `router_node` 调用时传入 `has_active_resume=bool(workspace.get("resume_id"))`。

### 8.4 `route_decision` 新增 edit_resume 分支

```python
valid = {
    "experience_import", "jd", "resume_generation", "application_package",
    "artifact", "open_ended", "clarify", "edit_resume",   # 加这个
}
```

### 8.5 `edit_instruction` 字段写回

在 `router_node` 返回值里，当 `target_subgraph == "edit_resume"` 时，把 `intent_description` 同时写到 `edit_instruction`：
```python
edit_instruction = routing.intent_description if routing.target_subgraph == "edit_resume" else None
return {
    ...
    "edit_instruction": edit_instruction,
    ...
}
```

---

## 9. `app/graphs/main.py` — 挂载 resume_edit 子图

```python
from app.graphs.resume.edit.graph import build_resume_edit_subgraph

# 在 build_main_graph 里：
resume_edit_subgraph = build_resume_edit_subgraph().compile(checkpointer=checkpointer)
builder.add_node("edit_resume", resume_edit_subgraph)
builder.add_edge("edit_resume", END)

# 在 conditional_edges 的字典里加：
"edit_resume": "edit_resume",
```

---

## 10. `app/core/events.py` — `AgentInterruptEvent` 新类型

在 `_AgentInterruptBase` 的 `type` Literal 里加：
```python
type: Literal[
    "resume_review",
    "application_package_review",
    "experience_import",
    "confirm_action",
    "jd_save",
    "resume_edit_review",     # 新增
]
```

在 `AgentInterruptEvent` 里加可选字段：
```python
diff: dict[str, Any] | None   # for resume_edit_review — 变动 id 集合
```

---

## 11. 辅助函数汇总（全部放在 `app/graphs/resume/edit/nodes.py` 顶部）

| 函数 | 说明 |
|---|---|
| `_summarize_structured_for_classify(structured)` | 截断到 ~2000 token 的结构摘要，用于 classify/locate LLM |
| `_full_structured_text(structured)` | 完整结构文本（不截断），用于 locate LLM |
| `_id_exists_in_structured(target_id, structured)` | 检查 id 是否存在于 structured 的任意层级 |
| `_compute_structured_diff(old, new)` | 纯函数，返回 changed/added/removed id 集合 |
| `_edit_confirmation_message(diff)` | 生成人类可读确认消息 |
| `_load_latest_structured(services, user_id, resume_id)` | 从 DB 拉最新 variant structured |
| `_build_tier3_instruction(instruction, current_structured)` | 打包 Tier 3 intent |

---

## 12. `app/api/routes/copilot.py` — edit_instruction 字段穿透

在 `_build_initial_state`（或 `_workspace_from_client_state`）里，从前端 `clientState` 读 `editingScope` 和 `requireReviewBeforeApply`，写入 state：

```python
editing_scope = client_state.get("editingScope") or None
require_review = bool(client_state.get("requireReviewBeforeApply") or False)

# 在 initial_state 里加：
if editing_scope:
    initial_state["editing_scope"] = editing_scope
if require_review:
    initial_state["require_review_before_apply"] = require_review
```

---

## 13. 单元测试 `tests/unit/graphs/test_resume_edit.py`

需要覆盖以下场景（全部 mock provider，不打真实 LLM）：

### 13.1 Tier 1 直路径
```python
# 前端传 edit_target_id="bul-abc" + text → classify 输出 Tier 1
# apply_node 调 patch_variant(user_id, variant_id, [{"op":"replace_bullet","bullet_id":"bul-abc","text":"..."}])
# 断言: services.resume.patch_variant 被调用一次，event 列表含 content.diff.*，无 LLM locate 调用
```

### 13.2 Tier 2 locate → apply
```python
# 指令："把 WEEX 那条第 2 个 bullet 改成强调 SQL 脚本数量"
# mock locate 返回 target_id="bul-real" + op
# 断言: apply_node 拿到 operations=[op], patch_variant 被调用, diff 非空, changed_bullet_ids=["bul-real"]
# 断言: 其他 bullet id 全部保持不变（在 test fixture 里预设 structured）
```

### 13.3 Tier 2 + require_review → interrupt
```python
# state.require_review_before_apply = True
# apply_node 完成后走 edit_interrupt_node
# 断言: events 里有 agent.interrupt type=resume_edit_review
# 断言: interrupt payload 里有 diff 字段
```

### 13.4 Tier 3 → resume_generation
```python
# 指令："整体太长了，压缩到一页"
# mock classify 输出 Tier 3
# 断言: edit_tier3_bridge_node 被调用，previous_structured 被传入 resume_generation 子图
# 断言: 输出 interrupt_payload 类型为 resume_review
```

### 13.5 workspace.resume_id 为空 → 错误
```python
# state.workspace = {} (无 resume_id)
# classify 输出 error message，pending_sse_events 里有 agent.message.completed
# 断言: 没有 LLM locate/apply 调用
```

### 13.6 id 复用（_assign_structure_ids）
```python
# previous_structured 里有 item(source_experience_id="exp-123", id="item-old-id", bullets=[{id:"bul-old"}])
# 新 LLM 输出相同 source_experience_id 的 item
# 断言: 新 structured 里该 item.id == "item-old-id"
# 断言: 相似 bullet 复用 "bul-old"，新 bullet 得到新 id
```

---

## 14. 验收 checklist

- [ ] `pytest tests/unit/ -q` 全绿（含新增 6 个 test case）
- [ ] `from app.graphs.main import build_main_graph; build_main_graph()` 无报错
- [ ] curl 手工验收（Tier 2）：
  1. 生成简历 → accept → 拿到 resume_id + variant_id
  2. 发消息 "把 WEEX 那条第 2 个 bullet 改得更强调 SQL 数量"，clientState 带 `activeResumeId`
  3. SSE 里出现 `content.diff.completed`，diff.changed_bullet_ids 非空
  4. 重拉 variant，指定 bullet text 已变，其他 id 全不变
- [ ] curl 手工验收（Tier 3）：
  1. 同一简历，发消息 "整体太长，压缩到一页"
  2. SSE 里出现 `agent.interrupt` type=`resume_review`，payload 里有 diff.removed_ids
  3. accept 后 `resume_variants` 出现新行，新行 parent_variant_id 指向上一版

---

## 附：已完成（不要重做）

- `app/domain/resume/patch.py` — `apply_patch_operations` 已存在
- `app/domain/resume/service.py` — `patch_variant` 方法已实现
- `resume_variants.parent_variant_id` — 列已存在（migration 0013）
- `render_structured_to_markdown` — 已在 `app/domain/resume/render.py`
