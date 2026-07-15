# Agent 智能化改进交接文档

**日期**: 2026-07-15  
**优先级**: P0 → P1 → P2 → P3（按顺序完成，P0/P1 最紧急）  
**目标**: 修复对话上下文丢失、工具调用不自然、意图理解错误三类问题，使 Agent 达到"问什么答什么、自然调工具、前后文连贯"的效果。

---

## 背景：为什么会有这些问题

当前系统是**任务分发器**架构：每条消息 → Router → 专用子图 → 结构化输出。这导致：

1. **`open_ended` 节点** 处理大多数对话，但它传给 LLM 的 prompt 里没有 workspace 信息（没有"你有几条经历"、"当前 JD 是什么"），LLM 不知道该调工具，只能凭空作答。
2. **rolling summary** 窗口太窄（20 条消息后压缩，只保留 8 条原文），正常聊天很快就开始丢上文。
3. **流式传输断连** 时，助手消息不写入 DB，下一轮历史出现洞。
4. **Router 上下文太少**，LLM 路由时不知道用户有什么资产，容易误判。

---

## P0 — `app/graphs/open_ended.py`（最高优先级，最大收益）

**问题**：`_build_messages` 函数只传消息历史 + rolling_summary，完全没有 workspace 上下文，导致 LLM 不知道用户有经历库、不知道有 active JD，不会主动调工具。

**目标效果**：用户说"根据我的经历帮我分析这个岗位"，LLM 应该立刻调用 `list_experiences` → 逐条读取 → 给出分析，而不是凭空编造。

### 修改方案

**文件**: `app/graphs/open_ended.py`

#### 步骤 1：修改 `open_ended_node` 函数签名，接收 config

函数现在已经接收 `config`，但不用于 workspace 查询。需要增加一个轻量级 context 加载步骤。

在 `open_ended_node` 函数里，**在调用 `_build_messages` 之前**，异步加载 workspace summary：

```python
async def open_ended_node(
    state: MainState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Handle open-ended queries with optional tool access."""
    provider = get_provider()
    
    # NEW: load lightweight workspace context before building messages
    workspace_context = await _load_workspace_context(state, config)
    
    llm_messages = _build_messages(state, workspace_context=workspace_context)
    # ... 其余代码不变
```

#### 步骤 2：新增 `_load_workspace_context` 函数

在 `open_ended.py` 末尾新增此函数：

```python
async def _load_workspace_context(
    state: MainState, config: RunnableConfig | None
) -> str:
    """
    加载轻量级 workspace 上下文，注入到 system prompt。
    只查询元数据（titles/counts），不做 RAG 或 embedding 检索。
    失败时静默返回空字符串，不中断对话。
    """
    from app.graphs.runtime import pool_from_config, services_from_config

    services = services_from_config(config)
    workspace = state.get("workspace", {})
    user_id = str(state.get("user_id", ""))

    if not services or not user_id:
        return ""

    parts: list[str] = []

    try:
        # 1. 经历库：只拉 title + category，不拉全文，limit=50
        items, _ = await services.experience.list_experiences(user_id, limit=50)
        if items:
            # 按 category 分组显示
            by_cat: dict[str, list[str]] = {}
            for exp in items:
                cat = str(exp.category or "其他")
                by_cat.setdefault(cat, []).append(str(exp.title or ""))
            lines = [f"  - [{cat}] " + "、".join(titles) for cat, titles in by_cat.items()]
            parts.append(f"用户经历库（共 {len(items)} 条）：\n" + "\n".join(lines))
        else:
            parts.append("用户经历库：暂无数据（用户可能尚未导入经历）")
    except Exception:  # noqa: BLE001
        pass  # 不中断对话

    try:
        # 2. 当前 active JD：只显示标题 + 前 200 字
        jd_id = workspace.get("jd_id")
        if isinstance(jd_id, str) and jd_id:
            jd = await services.jd.get_jd(user_id, jd_id)
            jd_preview = (jd.raw_text or "")[:200].strip()
            if len(jd.raw_text or "") > 200:
                jd_preview += "..."
            parts.append(f"当前 active JD（ID: {jd_id}）：\n  标题: {jd.title}\n  内容预览: {jd_preview}")
        else:
            parts.append("当前 active JD：无")
    except Exception:  # noqa: BLE001
        pass

    try:
        # 3. 当前 active 简历
        resume_id = workspace.get("resume_id")
        if isinstance(resume_id, str) and resume_id:
            parts.append(f"当前 active 简历 ID：{resume_id}（可用 list_resumes 工具查看）")
    except Exception:  # noqa: BLE001
        pass

    try:
        # 4. 用户 profile：姓名 + 职位
        profile = await services.user.get_profile(user_id)
        if profile:
            name = getattr(profile, "full_name", None) or ""
            title = getattr(profile, "current_title", None) or ""
            if name or title:
                parts.append(f"用户信息：{name}，{title}".strip("，"))
    except Exception:  # noqa: BLE001
        pass

    if not parts:
        return ""

    return (
        "\n\n=== 用户工作区 ===\n"
        + "\n\n".join(parts)
        + "\n\n当你需要查看经历详情时，先调用 list_experiences 获取列表，再调用 get_experience 获取某条经历的完整内容。"
        + "\n=== 工作区信息结束 ==="
    )
```

#### 步骤 3：修改 `_build_messages` 接受 workspace_context 参数

```python
def _build_messages(
    state: MainState,
    workspace_context: str = "",
) -> list[dict[str, Any]]:
    messages = state.get("messages", [])
    intent = state.get("intent_description", "")
    rolling_summary = state.get("rolling_summary")

    # 动态 system prompt：基础 prompt + workspace 上下文
    system_content = _SYSTEM_PROMPT
    if workspace_context:
        system_content = _SYSTEM_PROMPT + "\n" + workspace_context

    llm_messages: list[dict[str, Any]] = [{"role": "system", "content": system_content}]
    if intent:
        llm_messages.append({"role": "system", "content": f"Current intent: {intent}"})
    if rolling_summary:
        llm_messages.append({"role": "system", "content": f"Conversation summary: {rolling_summary}"})

    llm_messages.extend(
        {"role": m["role"], "content": m["content"]}
        for m in (messages[-10:] if len(messages) > 10 else messages)
        if m["role"] in ("user", "assistant")
    )
    return llm_messages
```

#### 步骤 4：改进 `_SYSTEM_PROMPT`

将现有的通用 prompt 替换为更有指导性的版本：

```python
_SYSTEM_PROMPT = """你是一个专业的求职助手。你能帮助用户：
- 基于用户的经历库回答问题、做分析
- 撰写和优化简历、求职信、自我介绍
- 解读 JD 要求，分析匹配度
- 提供职业建议和面试准备

**使用工具的原则**：
- 当用户问"我有哪些经历"、"帮我分析我的背景"、"根据我的经历..."时，必须先调用 list_experiences，再按需调用 get_experience 读取详情。
- 当用户问"我保存了哪些JD"时，调用 list_jds。
- 对于需要写入的操作（保存经历、删除等），先向用户确认。
- 如果工作区信息显示"无数据"，主动告知用户并引导他们先导入数据。

**回复风格**：用用户使用的语言回复。简洁、直接、专业，避免无意义的套话。有具体数据时直接展示，不要说"我帮你查一下"然后不查。
"""
```

#### 注意事项

- `_load_workspace_context` 所有 DB 查询都有 `try/except`，任何单点失败不影响对话继续。
- 不要在这里做 RAG/embedding 检索——那是 resume generation 子图的职责。
- 经历库只拉 title + category，不拉全文，保持轻量。

---

## P1a — `app/memory/rolling_summary.py`（上文丢失修复）

**问题**：`COMPRESSION_THRESHOLD = 20`、`MESSAGES_TO_KEEP = 8`，20 条消息就开始压缩，正常聊几轮就丢上文。摘要 prompt 也太简单，容易丢失关键细节。

### 修改方案

**文件**: `app/memory/rolling_summary.py`

#### 步骤 1：放宽压缩阈值

```python
# 原值
COMPRESSION_THRESHOLD = 20
MESSAGES_TO_KEEP = 8

# 改为
COMPRESSION_THRESHOLD = 40   # 40条消息才开始压缩（约20轮对话）
MESSAGES_TO_KEEP = 16         # 保留更多原文（约8轮对话）
```

#### 步骤 2：改进摘要 prompt（`_summarise` 函数内）

将 `_summarise` 函数的 system prompt 替换为：

```python
result = await provider.chat(
    [
        {
            "role": "system",
            "content": (
                "你是一个对话压缩助手。请将下方对话历史压缩为简洁的摘要，"
                "用于后续对话的上下文参考。\n\n"
                "**必须保留的信息**：\n"
                "- 用户表达过的明确需求和偏好（例如：想找什么类型的岗位、简历风格偏好）\n"
                "- 已完成的操作（例如：导入了哪些经历、生成了什么简历、保存了哪个JD）\n"
                "- 用户提供过的关键信息（例如：目标公司、目标职位、工作年限）\n"
                "- 对话中做出的决定（例如：决定先优化某段经历再生成）\n"
                "- 待解决的问题（例如：某段经历还没写完）\n\n"
                "**格式**：3-6句话，中文，按时间顺序，保留具体细节（不要泛化）。\n"
                "例如：不要写'用户讨论了简历'，要写'用户导入了3段工作经历，目标是字节跳动后端工程师岗位，"
                "已生成初版简历草稿，用户要求再优化工作经历中的技术描述部分'。"
                + (f"\n\n已有摘要（在此基础上累积，不要丢失已有信息）：\n{prior_summary}" if prior_summary else "")
            ),
        },
        {"role": "user", "content": history_text},
    ],
    temperature=0.2,   # 更低温度，保持准确
    max_tokens=500,    # 允许更长的摘要（原来 300）
)
```

同时，`history_text` 构建时允许更多内容（原来每条截 300 字，改为 500 字）：

```python
# 原来
history_text = "\n".join(
    f"{m['role'].upper()}: {m['content'][:300]}" for m in messages
)

# 改为
history_text = "\n".join(
    f"{m['role'].upper()}: {m['content'][:500]}" for m in messages
)
```

---

## P1b — `app/api/routes/copilot.py`（流式断连消息丢失）

**问题**：`_stream_with_persistence` 里，助手消息只在检测到 `agent.completed` SSE 事件时写入 DB。如果客户端断连或网络中断，这个事件可能不被处理，导致助手消息不写入历史。

### 修改方案

**文件**: `app/api/routes/copilot.py`

定位到 `_stream_with_persistence` 函数（约第 1136 行），修改如下：

```python
async def _stream_with_persistence() -> AsyncGenerator[str, None]:
    assistant_saved = False
    # NEW: 用于断连后兜底保存
    _last_completed_content: str = ""
    
    try:
        async for chunk in stream_graph_events(graph, initial_state, config):
            try:
                data_line = None
                for line in chunk.splitlines():
                    if line.startswith("data:"):
                        data_line = line[len("data:"):].strip()
                        break
                if not data_line:
                    yield chunk
                    continue
                payload = json.loads(data_line)
                evt = payload.get("event")
                
                # NEW: 追踪最新的完成内容，用于兜底
                if evt == "agent.message.completed":
                    _last_completed_content = str(payload.get("content") or "")
                
                if not assistant_saved and evt == "agent.completed":
                    # ... 原有的持久化逻辑不变 ...
                    assistant_saved = True
                elif not assistant_saved and evt == "agent.interrupt":
                    # ... 原有逻辑不变 ...
                    assistant_saved = True
                elif not assistant_saved and evt == "agent.failed":
                    # ... 原有逻辑不变 ...
                    assistant_saved = True
            except Exception as exc:  # noqa: BLE001
                logger.warning("SSE persistence hook failed: %s", exc)
            yield chunk
            
    except (GeneratorExit, Exception) as exc:
        # 客户端断连或流异常 — 记录但不抛出
        if not isinstance(exc, GeneratorExit):
            logger.warning("Stream ended with exception for thread %s: %s", thread_id, exc)
    finally:
        # NEW: 兜底：如果消息还没保存但我们有内容，在这里保存
        if not assistant_saved and _last_completed_content:
            try:
                await _persist_message(
                    _pool,
                    thread_id=thread_id,
                    role="assistant",
                    content=_last_completed_content,
                    turn_id=turn_id,
                    metadata={"saved_in_finally": True},
                )
                logger.info(
                    "Saved assistant message in finally block for thread %s (stream ended early)",
                    thread_id,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Finally-block message persistence failed for thread %s: %s", thread_id, exc)
```

**注意**：`GeneratorExit` 是 Python 在调用者停止消费生成器时抛出的异常，`finally` 块在此时仍然会执行。这是关键——即使客户端断连，`finally` 块的保存逻辑依然运行。

---

## P2a — `app/graphs/router.py`（Router 上下文改进）

**问题**：LLM 路由时，`context_str` 只有 jd_id、resume_id、rolling_summary，不知道用户有多少经历，导致把"查看我的经历"误路由到 `open_ended`（这本身没错，open_ended 可以处理），但更关键的是 Router LLM 的 prompt 缺乏足够的 workspace 提示。

### 修改方案

**文件**: `app/graphs/router.py`

定位 `router_node` 函数（第 81 行），在构建 `context_str` 处（约第 107-122 行）增加经历数量信息：

```python
# 原有代码
workspace = state.get("workspace", {})
context_parts = []
if workspace.get("jd_id"):
    context_parts.append(f"Active JD: {workspace['jd_id']}")
if workspace.get("resume_id"):
    context_parts.append(f"Active Resume: {workspace['resume_id']}")
rolling_summary = state.get("rolling_summary")
if rolling_summary:
    context_parts.append(f"Conversation summary: {rolling_summary}")

# 改为：在 rolling_summary 之后增加
workspace = state.get("workspace", {})
context_parts = []
if workspace.get("jd_id"):
    context_parts.append(f"Active JD: {workspace['jd_id']}")
if workspace.get("resume_id"):
    context_parts.append(f"Active Resume: {workspace['resume_id']}")
# NEW: 传递经历库状态给路由 LLM（从 state 中读，不做额外 DB 查询）
# 注意：这里不做 DB 查询，如果 assembled_experiences 在 state 里就用，否则跳过
assembled_experiences = state.get("assembled_experiences") or state.get("relevant_experiences") or []
if assembled_experiences:
    context_parts.append(f"User has {len(assembled_experiences)} experiences in library")
rolling_summary = state.get("rolling_summary")
if rolling_summary:
    context_parts.append(f"Conversation summary: {rolling_summary}")
```

同时，改进 `_ROUTER_SYSTEM` prompt 末尾，让 LLM 更清楚 open_ended 的能力：

在 `_ROUTER_SYSTEM` 字符串末尾（最后的 `"""` 之前）添加：

```
Important routing guidance:
- "open_ended" has full tool access: it CAN list/read experiences, JDs, and resumes. 
  Route there for Q&A, analysis, and exploration tasks even if they involve user data.
- Only route to "resume_generation" or "application_package" when the user explicitly 
  wants to CREATE or OVERWRITE resume content, not just discuss it.
- "根据我的经历分析" → open_ended (tool-calling agent will handle)
- "帮我生成一份简历" → resume_generation or application_package
```

---

## P2b — 新增 `app/graphs/router.py` 经历问答路由识别

**问题**：当用户问"根据我的经历库告诉我..."类问题，heuristic router 不认识，走到 LLM router，LLM router 可能也路由不准。

**方案**：在 `_heuristic_route` 函数末尾（在 `artifact_map` 处理之前）增加一个经历问答识别分支：

```python
# 在 requests_resume 分支之后、artifact_map 之前，新增：
experience_qa_terms = (
    "根据我的经历", "从我的经历", "基于我的经历",
    "我的背景", "我的工作经历", "我的项目经历",
    "经历库", "我有哪些经历", "我的经历有哪些",
    "analyse my experience", "based on my experience",
    "from my experience library",
)
if any(term in lower for term in experience_qa_terms):
    return RouterOutput(
        target_subgraph="open_ended",
        intent_description="Answer a question or provide analysis based on user's experience library. Use list_experiences and get_experience tools.",
        context_hints=["experiences", "active_jd"],
        confidence=0.92,
    )
```

---

## P3 — 工具 description 改进

**问题**：`list_experiences` 和 `get_experience` 的 description 太简单，LLM 不清楚何时调用哪个。

### 修改方案

**文件**: `app/tools/experience/list_tool.py`

```python
# 原来
description: str = "List the user's experience library, optionally filtered by category, tags, or search query"

# 改为
description: str = (
    "List the user's stored experiences (titles and categories only). "
    "Call this FIRST when the user asks about their background, experiences, or work history. "
    "Use the returned IDs to call get_experience for full content of specific items. "
    "Supports filtering by category (work/project/education/other), tags, or keyword search (q)."
)
```

**文件**: `app/tools/experience/get_tool.py`

```python
# 原来
description: str = "Get full details of a specific experience including all revisions"

# 改为
description: str = (
    "Get the full content of one specific experience by its ID. "
    "Always call list_experiences first to get the ID, then call this for the complete text. "
    "Returns the full description text needed for analysis or resume writing."
)
```

**文件**: `app/tools/jd/list_tool.py`（如果存在）

同理改为更明确的描述，说明"先调 list 拿 ID，再按需拿详情"。

---

## 执行顺序与验证

### 实施顺序

```
P0 → P1a → P1b → P2a → P2b → P3
```

每完成一步后，运行：

```bash
.venv/bin/python -m pytest tests/unit/ -q
```

确认 180 个测试全部通过（当前基线）。

### 功能验证清单

完成 P0 后，在前端测试以下场景：

| 场景 | 期望行为 |
|---|---|
| "我有哪些工作经历？" | LLM 调用 `list_experiences`，返回经历列表 |
| "根据我的经历帮我分析这个岗位" | LLM 调 `list_experiences` → `get_experience` → 给出分析 |
| "帮我生成简历" + 有经历库 | 路由到 resume_generation，context_assembly 加载经历 |
| 第 2 轮说"修改一下" | workspace 里有 jd_id 和 resume_id，不丢上下文 |
| 聊超过 40 条消息后继续对话 | rolling_summary 生成，内容仍然准确 |

完成 P1b 后验证：

| 场景 | 期望行为 |
|---|---|
| 流式传输到一半，前端断连 | 助手消息仍写入 DB（metadata 包含 `saved_in_finally: true`） |
| 下一轮请求 | 历史里有上一轮的完整问答 |

---

## 架构约束（不得违反）

参考 `CLAUDE.md`：

- `app/graphs/` 不得直接 import `app/infra/`
- `open_ended.py` 中的 `_load_workspace_context` 通过 `config["configurable"]["services"]` 获取 services（不 import infra）
- `app/domain/` 层零框架依赖
- 新增函数需有类型注解

---

## 关键文件索引

| 文件 | 改动 | 优先级 |
|---|---|---|
| `app/graphs/open_ended.py` | 增加 `_load_workspace_context`，改 `_build_messages`，改 `_SYSTEM_PROMPT` | P0 |
| `app/memory/rolling_summary.py` | 改 `COMPRESSION_THRESHOLD`/`MESSAGES_TO_KEEP`，改摘要 prompt | P1a |
| `app/api/routes/copilot.py` | 改 `_stream_with_persistence`，加 `finally` 兜底保存 | P1b |
| `app/graphs/router.py` | 改 `context_str` 构建，改 `_ROUTER_SYSTEM`，加经历问答 heuristic | P2a/P2b |
| `app/tools/experience/list_tool.py` | 改 `description` | P3 |
| `app/tools/experience/get_tool.py` | 改 `description` | P3 |

---

## 不要做的事

- ❌ 不要在 `_load_workspace_context` 里做 RAG 检索（embedding search）——那很重，是 resume generation 的职责
- ❌ 不要在 `open_ended` 里调用 `assemble_context`（会触发 guideline RAG + evidence RAG，严重拖慢对话）
- ❌ 不要修改 `persist_resume_draft_node` 或 Phase 1 的任何代码（workspace snapshot 持久化逻辑已完成，不要碰）
- ❌ 不要在 rolling_summary 里做额外的 DB 查询
- ❌ `finally` 块里的保存失败后不要再抛异常，仅 `logger.warning`

---

*文档版本: 1.0 · 2026-07-15*
