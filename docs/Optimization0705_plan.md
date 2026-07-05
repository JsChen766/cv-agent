# Optimization0705 Plan

> Date: 2026-07-05
> Scope: Agent runtime, tool/function calling, process trace/SSE, interrupt persistence, and related architecture cleanup.

## 1. 背景与目标

当前项目已经具备 FastAPI、domain/infra 基础 CRUD、LangGraph 主图/子图、SSE 事件类型、部分 tools 和 provider 抽象。但 Agent 运行时还没有闭环，尤其是：

- `open_ended` 声称拥有 tool access，但实际没有 function calling / tool loop。
- `tools.registry` 定义了 `_load_all()`，但运行时未调用，`get_all()` 默认返回空列表。
- `Tool` 协议缺少规划中要求的 `input_schema`，无法稳定转换为 OpenAI / Anthropic tool schema。
- provider 层没有统一的 tool calling 参数和返回结构。
- `agent.thinking`、`agent.tool.*`、`agent.node.*` 等 SSE 事件类型已定义，但缺少统一产出机制。
- `interrupt()` 与 PostgreSQL checkpointer 的运行时接线不完整。
- 多个 graph node 直接 import `infra/`，违反 AGENTS.md 中 `graphs/` 不直接访问数据库/infra 的约束。

本计划目标是把 Agent 层收敛为：低耦合 provider + 高内聚 tools + graph 只编排，不直接访问 infra；同时让后续新增工具只需要“新增文件 + registry 注册”，避免修改 Router / Orchestrator 核心逻辑。

## 2. 设计原则

- 严格保持依赖方向：`api -> graphs -> tools -> domain <- infra`。
- `graphs/` 只负责 LangGraph 编排、路由、状态转换和 interrupt，不直接创建 repository，不直接访问 DB。
- `tools/` 是 LLM 可调用能力的唯一出口；工具内部只调用 domain service。
- `domain/` 继续保持零框架依赖，不 import FastAPI / LangGraph / asyncpg / SQLAlchemy。
- provider 只处理 LLM 协议差异，不内嵌业务工具逻辑。
- SSE trace 暴露“过程摘要/节点/工具/状态”，不暴露模型隐藏思维链原文。
- 所有高风险写操作必须走 `requires_confirmation` 或 graph interrupt。

## 3. 当前问题清单

### P0 - Tool calling 不可用

涉及文件：

- `app/graphs/open_ended.py`
- `app/providers/base.py`
- `app/providers/openai_format.py`
- `app/providers/anthropic_format.py`
- `app/tools/base.py`
- `app/tools/registry.py`

问题：

- `open_ended_node()` 当前只调用普通 `provider.chat()`。
- `get_all()` 返回空列表，因为 `_load_all()` 没有被调用。
- `Tool` 协议没有 `input_schema`。
- provider 不支持 `tools`、`tool_choice`、tool call 返回值。

### P0 - Checkpointer / interrupt 生命周期不完整

涉及文件：

- `app/graphs/main.py`
- `app/main.py`
- `app/api/routes/copilot.py`
- `app/api/routes/threads.py`
- 新增 `app/infra/db/checkpointer.py`

问题：

- Alembic 已有 checkpoint 表，但运行时 `get_graph()` 未注入 checkpointer。
- `/threads/{id}/resume` 依赖 `Command(resume=...)`，但没有稳定的持久 checkpoint 支撑。

### P1 - SSE / 过程链路不完整

涉及文件：

- `app/core/events.py`
- `app/api/sse.py`
- `app/graphs/router.py`
- `app/graphs/open_ended.py`
- `app/graphs/*/nodes.py`

问题：

- `agent.route.completed` 已在 router 产出。
- `agent.thinking` 只有零散使用，字段还与 `events.py` 不一致：事件定义是 `text`，部分代码使用 `content`。
- `agent.node.started/completed` 未统一产出。
- `agent.tool.started/completed/failed` 没有真实工具执行链路。

### P1 - Graph 层绕过 tools/domain 边界

涉及文件：

- `app/graphs/resume/nodes.py`
- `app/graphs/artifact/nodes.py`
- `app/graphs/experience/nodes.py`
- `app/memory/context_assembly.py`

问题：

- Graph node 中直接 import `app.infra.db.connection`、repository、domain service。
- 后续应通过 ToolContext/ServiceContainer 或 graph runtime dependency 注入拿到 tools/domain service。

### P1 - Streaming 只是一次性事件

涉及文件：

- `app/graphs/resume/nodes.py`
- `app/graphs/artifact/nodes.py`
- `app/api/sse.py`

问题：

- Resume 生成注释已写 `non-streaming for now`。
- Artifact 生成一次性返回完整内容，然后发送单个 `artifact.delta`。
- 后续应支持 provider streaming，将 token/chunk 转成 `agent.message.delta`、`content.diff.delta` 或 `artifact.delta`。

### P2 - 测试覆盖不足

涉及目录：

- `tests/unit/test_tools/`
- `tests/unit/test_providers/`
- `tests/integration/`
- `tests/api/`

问题：

- 当前 API 鉴权测试存在失败：期望 401，实际出现 200/502。
- 缺少 tool registry、tool schema、open-ended tool loop、interrupt resume 的集成测试。

## 4. Tool 协议规划

### 4.1 统一 Tool Protocol

目标文件：`app/tools/base.py`

```python
class Tool(Protocol):
    name: str
    description: str
    input_schema: type[BaseModel]
    requires_confirmation: bool
    risk_level: Literal["low", "medium", "high"]

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult: ...
```

### 4.2 Tool schema 转换

新增文件：`app/tools/schema.py`

职责：

- `to_openai_tool(tool: Tool) -> dict`
- `to_anthropic_tool(tool: Tool) -> dict`
- `validate_tool_input(tool: Tool, raw_args: dict) -> BaseModel`
- `summarize_tool_result(result: ToolResult) -> str`

转换来源统一使用 `tool.input_schema.model_json_schema()`，避免每个 provider 重复写 schema 逻辑。

### 4.3 Tool registry

目标文件：`app/tools/registry.py`

改动：

- 在 `get_all()` / `get()` / `get_names()` 前确保 `_load_all()` 已执行一次。
- 不再静默吞掉所有 ImportError；只允许明确的 optional tool 跳过，普通导入错误应暴露。
- 增加 `get_by_names(names: list[str]) -> list[Tool]`，方便某些 subgraph 只开放白名单工具。

## 5. 预计工具清单与 Schema

以下 schema 使用 Pydantic v2，字段命名保持后端 Python 风格；API 层如需 camelCase 由 schema/adapter 转换，不污染 domain/tool 层。

### 5.1 Experience tools

#### `list_experiences`

状态：已有，需补 `input_schema`。

文件：`app/tools/experience/list_tool.py`

```python
class ListExperiencesInput(BaseModel):
    category: str | None = None
    tags: list[str] | None = None
    q: str | None = None
    limit: int = Field(default=20, ge=1, le=50)
```

风险：`low`，无需确认。

#### `get_experience`

状态：已有，需补 `input_schema`。

文件：`app/tools/experience/get_tool.py`

```python
class GetExperienceInput(BaseModel):
    experience_id: str
```

风险：`low`，无需确认。

#### `save_experience`

状态：已有，需补 `input_schema`；建议只用于低风险显式保存，批量导入走 review interrupt。

文件：`app/tools/experience/save_tool.py`

```python
class SaveExperienceInput(BaseModel):
    title: str
    organization: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    content: str
    category: str = "work"
    tags: list[str] = Field(default_factory=list)
```

风险：`medium`，建议 `requires_confirmation=True`，避免 LLM 静默写库。

#### `update_experience`

状态：需新增。

文件：`app/tools/experience/update_tool.py`

```python
class UpdateExperienceInput(BaseModel):
    experience_id: str
    title: str | None = None
    organization: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    content: str | None = None
    category: str | None = None
    tags: list[str] | None = None
    change_reason: str | None = None
```

风险：`medium`，需要确认。

#### `delete_experience`

状态：需新增。

文件：`app/tools/experience/delete_tool.py`

```python
class DeleteExperienceInput(BaseModel):
    experience_id: str
    reason: str | None = None
```

风险：`high`，必须确认。

#### `import_experience_text`

状态：已有，需补 `input_schema`，并明确只解析候选，不直接写库。

文件：`app/tools/experience/import_text_tool.py`

```python
class ImportExperienceTextInput(BaseModel):
    raw_text: str
    source_label: str | None = None
```

风险：`low`，无需确认；保存候选由 `accept_experience_candidates` 处理。

#### `import_experience_file`

状态：需新增。

文件：`app/tools/experience/import_file_tool.py`

```python
class ImportExperienceFileInput(BaseModel):
    file_id: str
    source_label: str | None = None
```

风险：`low`，无需确认；只解析文件并返回候选。

#### `accept_experience_candidates`

状态：需新增。

文件：`app/tools/experience/accept_candidates_tool.py`

```python
class ExperienceCandidateInput(BaseModel):
    title: str
    organization: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    content: str
    category: str = "work"
    tags: list[str] = Field(default_factory=list)

class AcceptExperienceCandidatesInput(BaseModel):
    candidates: list[ExperienceCandidateInput]
    source: str | None = None
```

风险：`medium`，需要确认。

#### `match_experiences_to_jd`

状态：需新增。

文件：`app/tools/experience/match_jd_tool.py`

```python
class MatchExperiencesToJdInput(BaseModel):
    jd_id: str
    experience_ids: list[str] | None = None
    top_k: int = Field(default=8, ge=1, le=20)
```

风险：`low`，无需确认。

### 5.2 JD tools

#### `list_jds`

状态：已有，需补 `input_schema`。

文件：`app/tools/jd/list_tool.py`

```python
class ListJdsInput(BaseModel):
    q: str | None = None
    company: str | None = None
    limit: int = Field(default=20, ge=1, le=50)
```

风险：`low`，无需确认。

#### `get_jd`

状态：需新增。

文件：`app/tools/jd/get_tool.py`

```python
class GetJdInput(BaseModel):
    jd_id: str
    include_requirements: bool = True
```

风险：`low`，无需确认。

#### `save_jd`

状态：已有，需补 `input_schema`。

文件：`app/tools/jd/save_tool.py`

```python
class SaveJdInput(BaseModel):
    title: str
    raw_text: str
    company: str | None = None
    target_role: str | None = None
```

风险：`medium`，建议需要确认；如果来自显式 REST 表单可由 API 直接调用 domain service。

#### `update_jd`

状态：需新增。

文件：`app/tools/jd/update_tool.py`

```python
class UpdateJdInput(BaseModel):
    jd_id: str
    title: str | None = None
    raw_text: str | None = None
    company: str | None = None
    target_role: str | None = None
```

风险：`medium`，需要确认。

#### `delete_jd`

状态：需新增。

文件：`app/tools/jd/delete_tool.py`

```python
class DeleteJdInput(BaseModel):
    jd_id: str
    reason: str | None = None
```

风险：`high`，必须确认。

### 5.3 Resume tools

#### `list_resumes`

状态：已有，需补 `input_schema`。

文件：`app/tools/resume/list_tool.py`

```python
class ListResumesInput(BaseModel):
    q: str | None = None
    limit: int = Field(default=20, ge=1, le=50)
```

风险：`low`，无需确认。

#### `get_resume`

状态：需新增。

文件：`app/tools/resume/get_tool.py`

```python
class GetResumeInput(BaseModel):
    resume_id: str
    include_items: bool = True
```

风险：`low`，无需确认。

#### `create_resume`

状态：需新增。

文件：`app/tools/resume/create_tool.py`

```python
class CreateResumeInput(BaseModel):
    title: str
    template_id: str | None = None
    source_experience_ids: list[str] = Field(default_factory=list)
```

风险：`medium`，需要确认。

#### `generate_resume_from_jd`

状态：需新增或由 resume subgraph 封装为 tool callable action。

文件：`app/tools/resume/generate_from_jd_tool.py`

```python
class GenerateResumeFromJdInput(BaseModel):
    jd_id: str
    resume_id: str | None = None
    experience_ids: list[str] | None = None
    target_language: str | None = None
    instruction: str | None = None
```

风险：`medium`，需要确认后写入；生成草稿本身可低风险，保存/替换必须确认。

#### `revise_resume_item`

状态：需新增。

文件：`app/tools/resume/revise_item_tool.py`

```python
class ReviseResumeItemInput(BaseModel):
    resume_item_id: str
    instruction: str
    target_jd_id: str | None = None
```

风险：`medium`，需要确认。

#### `accept_resume_variant`

状态：需新增。

文件：`app/tools/resume/accept_variant_tool.py`

```python
class AcceptResumeVariantInput(BaseModel):
    variant_id: str
    resume_id: str | None = None
    title: str | None = None
```

风险：`medium`，需要确认。

#### `reorder_resume_items`

状态：需新增。

文件：`app/tools/resume/reorder_items_tool.py`

```python
class ReorderResumeItemsInput(BaseModel):
    resume_id: str
    ordered_item_ids: list[str]
```

风险：`medium`，需要确认。

### 5.4 Artifact tools

#### `list_artifacts`

状态：需新增。

文件：`app/tools/artifact/list_tool.py`

```python
class ListArtifactsInput(BaseModel):
    artifact_type: str | None = None
    q: str | None = None
    limit: int = Field(default=20, ge=1, le=50)
```

风险：`low`，无需确认。

#### `get_artifact`

状态：已有，需补 `input_schema`。

文件：`app/tools/artifact/get_tool.py`

```python
class GetArtifactInput(BaseModel):
    artifact_id: str
```

风险：`low`，无需确认。

#### `create_artifact`

状态：已有，需补 `input_schema`；建议 graph 生成和 tool 创建复用同一个 domain service。

文件：`app/tools/artifact/create_tool.py`

```python
class CreateArtifactInput(BaseModel):
    artifact_type: str
    title: str
    content: str
    source_jd_id: str | None = None
    source_experience_ids: list[str] = Field(default_factory=list)
```

风险：`medium`，需要确认。

#### `generate_artifact`

状态：需新增。

文件：`app/tools/artifact/generate_tool.py`

```python
class GenerateArtifactInput(BaseModel):
    artifact_type: str
    instruction: str
    jd_id: str | None = None
    experience_ids: list[str] | None = None
    target_language: str | None = None
```

风险：`medium`，生成草稿无需确认，保存需要确认。

#### `update_artifact`

状态：需新增。

文件：`app/tools/artifact/update_tool.py`

```python
class UpdateArtifactInput(BaseModel):
    artifact_id: str
    title: str | None = None
    content: str | None = None
    change_reason: str | None = None
```

风险：`medium`，需要确认。

#### `delete_artifact`

状态：需新增。

文件：`app/tools/artifact/delete_tool.py`

```python
class DeleteArtifactInput(BaseModel):
    artifact_id: str
    reason: str | None = None
```

风险：`high`，必须确认。

### 5.5 Evidence / RAG tools

#### `show_evidence`

状态：需新增。

文件：`app/tools/evidence/show_tool.py`

```python
class ShowEvidenceInput(BaseModel):
    jd_id: str | None = None
    resume_id: str | None = None
    experience_ids: list[str] | None = None
    requirement_ids: list[str] | None = None
```

风险：`low`，无需确认。

#### `check_claims`

状态：需新增。

文件：`app/tools/evidence/check_claims_tool.py`

```python
class CheckClaimsInput(BaseModel):
    text: str
    jd_id: str | None = None
    experience_ids: list[str] | None = None
```

风险：`low`，无需确认。

### 5.6 User / Preference tools

#### `get_user_profile`

状态：需新增。

文件：`app/tools/user/get_profile_tool.py`

```python
class GetUserProfileInput(BaseModel):
    include_preferences: bool = True
```

风险：`low`，无需确认。

#### `list_preferences`

状态：需新增。

文件：`app/tools/preference/list_tool.py`

```python
class ListPreferencesInput(BaseModel):
    category: str | None = None
    scope: str | None = None
    active_only: bool = True
```

风险：`low`，无需确认。

#### `add_preference`

状态：需新增。

文件：`app/tools/preference/add_tool.py`

```python
class AddPreferenceInput(BaseModel):
    rule: str
    category: str
    scope: str = "global"
```

风险：`medium`，需要确认。

#### `delete_preference`

状态：需新增。

文件：`app/tools/preference/delete_tool.py`

```python
class DeletePreferenceInput(BaseModel):
    preference_id: str
    reason: str | None = None
```

风险：`medium`，需要确认。

## 6. Function calling / Tool use 实现计划

### 6.1 Provider 抽象

目标文件：

- `app/providers/base.py`
- `app/providers/openai_format.py`
- `app/providers/anthropic_format.py`

新增数据结构：

```python
class ToolCall(BaseModel):
    id: str
    name: str
    arguments: dict[str, Any]

class ChatResult(BaseModel):
    content: str
    tool_calls: list[ToolCall] = Field(default_factory=list)
    raw: Any | None = None
```

Provider 方法：

```python
async def chat_with_tools(
    self,
    messages: list[dict[str, Any]],
    tools: list[Tool],
    *,
    tool_choice: str | None = "auto",
    temperature: float = 0.2,
    max_tokens: int | None = None,
) -> ChatResult: ...
```

OpenAI format 预计实现：

- 将 `Tool` 转为 OpenAI-compatible tool schema。
- 使用 LangChain `bind_tools()`。
- 从 `AIMessage.tool_calls` 解析 tool call。

Anthropic format 预计实现：

- 先使用 LangChain `bind_tools()`。
- 如果供应商差异导致不可用，降级到 JSON tool-call prompt，但必须通过统一 parser 校验。

### 6.2 Open-ended ReAct loop

目标文件：`app/graphs/open_ended.py`

新增流程：

1. 构造 system prompt + history + workspace summary。
2. 从 `tools.registry.get_all()` 获取工具。
3. 调用 `provider.chat_with_tools(...)`。
4. 如返回普通内容，结束。
5. 如返回 tool_calls：
   - 校验工具存在。
   - 用 `tool.input_schema` 校验参数。
   - 若 `requires_confirmation=True`，触发 confirm interrupt，不直接执行。
   - 发送 `agent.tool.started`。
   - 执行 `tool.execute(input, context)`。
   - 发送 `agent.tool.completed` 或 `agent.tool.failed`。
   - 将 tool result 作为 tool message 回填给模型。
   - 最多循环 `max_tool_iterations` 次，默认 5。
6. 生成最终 assistant message。

需要新增辅助：

- `app/tools/executor.py`
- `app/tools/context.py` 或复用 `base.py` 中 `ServiceContainer`

重点：ServiceContainer 由 API/graph runtime 注入，不在 graph node 内直接 import infra repository。

## 7. SSE / 思考链路接口计划

目标：提供可解释执行过程，但不暴露隐藏 CoT。

### 7.1 事件字段修正

目标文件：`app/core/events.py`

- `AgentThinkingEvent` 统一使用 `text`。
- 审核现有代码中 `content` 字段，改成 `text`。

### 7.2 统一 node trace

新增文件：`app/graphs/tracing.py`

职责：

- `node_started(node, description)`
- `node_completed(node, duration_ms)`
- `thinking(text)`
- `tool_started(tool, input)`
- `tool_completed(tool, result_summary)`
- `tool_failed(tool, error)`

graph node 不直接拼 TypedDict，统一调用 helper，减少事件字段漂移。

### 7.3 SSE flush 策略

目标文件：`app/api/sse.py`

改动：

- 保留 `pending_sse_events` flush。
- 增加去重或 cursor 机制，避免多个 `on_chain_end` 重复推同一批 pending events。
- `agent.completed` 应包含 `turn_id` / `thread_id` / response，或明确和 `events.py` 定义一致。
- 对 interrupt 统一输出 `AgentInterruptEvent` 结构，避免一处是 `type`，一处是 `interrupt_type/data`。

## 8. Checkpointer / interrupt 持久化计划

新增文件：`app/infra/db/checkpointer.py`

职责：

```python
async def create_checkpointer(pool) -> AsyncPostgresSaver: ...
```

目标改动：

- `app/main.py` lifespan 中初始化 DB pool 后初始化 checkpointer。
- `app/graphs/main.py` 的 `get_graph()` 支持按 checkpointer 构建单例；如果 checkpointer 变化，避免复用无 checkpointer 的旧 graph。
- `app/api/routes/copilot.py` 和 `app/api/routes/threads.py` 使用同一个带 checkpointer 的 graph。
- `/threads/{id}/resume` 必须验证 thread ownership 后调用 `Command(resume=...)`。
- `/threads/{id}/discard` 如需真正解除 pending interrupt，应明确用 `Command(resume={"action": "discard", ...})` 或记录状态，不能只返回 discarded。

## 9. Graph 层架构清理计划

### 9.1 迁移 direct infra import

需要改动：

- `app/graphs/resume/nodes.py`
- `app/graphs/artifact/nodes.py`
- `app/graphs/experience/nodes.py`
- `app/memory/context_assembly.py`

方向：

- Context assembly 可以保留在 `memory/`，但应通过 repository Protocol 或 service interface 获取数据，不直接写 SQL。
- Graph node 调用 tools 或 injected services。
- Artifact 保存、Experience 保存、Resume 保存都通过 tool/domain service 完成。

### 9.2 子图职责边界

- `resume_generation`：生成 variant + diff + review + interrupt，不直接写最终 resume；接受 variant 后由 `accept_resume_variant` tool 写入。
- `artifact`：生成 artifact draft；保存 artifact 由 `create_artifact` 或确认后的 `generate_artifact` tool 处理。
- `experience_import`：解析候选 + interrupt；确认后调用 `accept_experience_candidates`。
- `open_ended`：唯一自由 tool-calling agent；复杂明确业务链路仍由 router 分发到对应 subgraph。

## 10. 预计改动文件列表

### 新增文件

- `app/tools/schema.py`
- `app/tools/executor.py`
- `app/tools/experience/update_tool.py`
- `app/tools/experience/delete_tool.py`
- `app/tools/experience/import_file_tool.py`
- `app/tools/experience/accept_candidates_tool.py`
- `app/tools/experience/match_jd_tool.py`
- `app/tools/jd/get_tool.py`
- `app/tools/jd/update_tool.py`
- `app/tools/jd/delete_tool.py`
- `app/tools/resume/get_tool.py`
- `app/tools/resume/create_tool.py`
- `app/tools/resume/generate_from_jd_tool.py`
- `app/tools/resume/revise_item_tool.py`
- `app/tools/resume/accept_variant_tool.py`
- `app/tools/resume/reorder_items_tool.py`
- `app/tools/artifact/list_tool.py`
- `app/tools/artifact/generate_tool.py`
- `app/tools/artifact/update_tool.py`
- `app/tools/artifact/delete_tool.py`
- `app/tools/evidence/show_tool.py`
- `app/tools/evidence/check_claims_tool.py`
- `app/tools/user/get_profile_tool.py`
- `app/tools/preference/list_tool.py`
- `app/tools/preference/add_tool.py`
- `app/tools/preference/delete_tool.py`
- `app/graphs/tracing.py`
- `app/infra/db/checkpointer.py`
- `tests/unit/test_tools/test_registry.py`
- `tests/unit/test_tools/test_schema.py`
- `tests/unit/test_tools/test_executor.py`
- `tests/unit/test_providers/test_tool_calling.py`
- `tests/integration/test_open_ended_tool_loop.py`
- `tests/integration/test_interrupt_resume.py`

### 修改文件

- `app/tools/base.py`
- `app/tools/registry.py`
- `app/providers/base.py`
- `app/providers/openai_format.py`
- `app/providers/anthropic_format.py`
- `app/graphs/open_ended.py`
- `app/graphs/main.py`
- `app/graphs/router.py`
- `app/graphs/resume/nodes.py`
- `app/graphs/artifact/nodes.py`
- `app/graphs/experience/nodes.py`
- `app/api/sse.py`
- `app/api/routes/copilot.py`
- `app/api/routes/threads.py`
- `app/main.py`
- `app/core/events.py`
- `app/api/deps.py`
- `tests/api/test_health.py`

## 11. 分阶段实施顺序

### Phase A - Tool 基础设施

产出：

- `Tool.input_schema` 补齐。
- registry 自动加载生效。
- tool schema 转换器。
- tool executor。
- 现有工具全部补齐 schema。

验收：

- `get_names()` 返回已注册工具。
- 每个工具的 `input_schema.model_json_schema()` 可转换。
- unit tests 覆盖 registry/schema/executor。

### Phase B - Provider tool calling

产出：

- provider 支持 `chat_with_tools()`。
- OpenAI format 优先使用 `bind_tools()`。
- Anthropic format 使用同一协议，必要时降级。

验收：

- mock LLM 返回 tool call，provider 能解析为统一 `ToolCall`。
- mock 工具执行结果能回填并生成最终回答。

### Phase C - Open-ended ReAct

产出：

- `open_ended_node()` 支持多轮 tool loop。
- tool started/completed/failed SSE 可见。
- 需要确认的工具触发 interrupt。

验收：

- “列出我的经历”能调用 `list_experiences`。
- “保存这段 JD”不会静默写库，而是触发确认或走 JD subgraph。

### Phase D - Checkpointer + interrupt resume

产出：

- `app/infra/db/checkpointer.py`。
- graph 编译注入 PostgreSQL checkpointer。
- `/threads/{id}/resume` 可恢复同一个 interrupted graph。

验收：

- `chat/stream -> agent.interrupt -> /threads/:id/resume` 完整通过。
- 服务重启后仍可 resume pending interrupt。

### Phase E - SSE / process trace

产出：

- 统一 tracing helper。
- 修正 thinking event 字段。
- node/tool/process trace 不重复推送。
- Resume/Artifact 逐 chunk 输出。

验收：

- 前端能看到 route、node、tool、draft delta、interrupt、completed 的稳定事件序列。

### Phase F - Graph 架构清理

产出：

- graph node 移除 direct infra import。
- 保存类动作统一经 tool/domain service。
- context assembly 依赖接口化。

验收：

- `rg "from app.infra" app/graphs app/memory` 只剩允许项或为 0。
- domain 层仍无框架依赖。

### Phase G - 测试与契约收口

产出：

- 修复现有 4 个 API 鉴权测试失败。
- 增加 tool/agent/checkpointer 集成测试。
- 增加 SSE contract snapshot。

验收：

- `pytest` 全绿。
- `ruff check app tests` 通过。
- `mypy app` 至少对新增代码通过，若旧代码已有问题需单独记录。

## 12. 风险与决策点

### 12.1 Tool confirmation 策略

建议：

- 读操作：`low`，无需确认。
- 创建/更新：`medium`，默认需要确认，除非用户通过显式 REST 表单操作。
- 删除/覆盖：`high`，必须确认。

待确认：

- `save_jd` / `save_experience` 是否允许“用户明确说保存”时免确认。

### 12.2 Tool loop 最大轮数

建议：

- 默认 5 轮。
- 超过后返回“我需要更多明确指令”，并附上已执行工具摘要。

### 12.3 Provider fallback

建议：

- OpenAI-compatible 优先走原生 tool calling。
- Anthropic 优先走 LangChain `bind_tools()`。
- 不支持 tool calling 的模型可走 JSON tool-call fallback，但必须用 schema 校验，禁止直接 eval/执行未经校验参数。

### 12.4 隐藏思维链

建议：

- 不输出 LLM 原始 chain-of-thought。
- 输出可审计的 high-level trace：正在检索、正在匹配 JD、调用了哪个工具、工具结果摘要。

## 13. 完成定义

本轮优化完成后，应满足：

- 工具 registry 稳定非空。
- 每个工具具备 `input_schema`，可自动转换 provider tool schema。
- open-ended 真正支持 function calling / tools use。
- 工具调用前后有 SSE trace。
- 高风险工具调用会 interrupt 确认。
- PostgreSQL checkpointer 接入，interrupt/resume 可跨请求恢复。
- graph 层不再直接访问 infra。
- 新增/修改工具不需要改 Router 核心逻辑。
- 单元测试、关键集成测试、API 契约测试通过。
