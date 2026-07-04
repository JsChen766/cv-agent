# 编码计划

> 依据：`new-agent-architecture-plan.md` + `api-contract.md`
> 原则：依赖方向严格自下而上（core → domain → infra → providers → rag → memory → tools → graphs → api）
> 每个阶段结束有明确的可验证 checkpoint

---

## Phase 0 — 项目初始化

**目标：** 可运行的空项目骨架，数据库能连通。

### 任务清单

**0.1 目录结构**
按 `new-agent-architecture-plan.md §16.2` 创建完整目录骨架，所有子目录放 `__init__.py`。

**0.2 pyproject.toml**
按 `§17` 依赖版本配置：
```
fastapi ^0.115, uvicorn[standard] ^0.30, langgraph ^0.2, langchain ^0.3,
langchain-openai ^0.2, langchain-anthropic ^0.3, asyncpg ^0.29,
sqlalchemy[asyncio] ^2.0, alembic ^1.13, pgvector ^0.3,
langgraph-checkpoint-postgres ^2.0, pydantic ^2.9, pydantic-settings ^2.5,
python-jose[cryptography] ^3.3, passlib[bcrypt] ^1.7,
pypdf ^4.3, python-docx ^1.1, httpx ^0.27, python-multipart ^0.0.12
dev: pytest ^8.3, pytest-asyncio ^0.23, pytest-cov ^5.0, ruff ^0.6, mypy ^1.11
```

**0.3 docker-compose.yml**
```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: cvbe
      POSTGRES_USER: cvbe
      POSTGRES_PASSWORD: cvbe
    ports: ["5432:5432"]
```

**0.4 alembic 初始化**
- `alembic init alembic`
- 配置 `alembic/env.py` 使用 asyncpg

**0.5 FastAPI 入口**
- `app/main.py`：创建 FastAPI 实例，注册路由，挂载 CORS，启动时初始化 DB 连接池
- `run.py` 或 `Makefile` 命令：`uvicorn app.main:app --reload`

**✅ Checkpoint：** `GET /v1/health` 返回 `{"status":"ok"}`，数据库连接正常。

---

## Phase 1 — core 层

**目标：** 全项目共享的基础类型、配置、错误、SSE 事件定义。无任何业务依赖。

### 文件

**`app/core/config.py`**
```python
class Settings(BaseSettings):
    database_url: str
    secret_key: str
    llm_provider: Literal["openai", "anthropic", "deepseek"] = "openai"
    llm_model: str = "gpt-4o"
    llm_api_key: str
    llm_base_url: str | None = None   # 兼容 openai-compatible 厂商
    embedding_model: str = "text-embedding-3-small"
    environment: Literal["development", "production"] = "development"
```

**`app/core/types.py`**
- ID 前缀常量：`THREAD_PREFIX = "thread-"` 等
- 通用枚举：`RiskLevel`, `MutabilityLevel`, `CareerStage`
- `generate_id(prefix: str) -> str`：`prefix + str(uuid4())`

**`app/core/errors.py`**
- `AppError(Exception)` 基类，携带 `code: str`, `message: str`, `http_status: int`, `retryable: bool`
- 按 `api-contract.md §2.4` 定义所有具体错误子类：
  `NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError`, `ScopeViolationError` 等

**`app/core/events.py`**
- 按 `api-contract.md §3.3` 定义所有 SSE 事件 TypedDict：
  `AgentThinkingEvent`, `ContentDiffStartedEvent`, `ContentDiffDeltaEvent`,
  `ContentDiffCompletedEvent`, `ArtifactStartedEvent`, `ArtifactDeltaEvent`,
  `ArtifactCompletedEvent`, `AgentInterruptEvent`, `AgentCompletedEvent`, `AgentFailedEvent` 等
- `SSEEvent = Union[所有事件类型]`
- `format_sse(event: SSEEvent) -> str`：序列化为 `event: xxx\ndata: {...}\n\n`

**✅ Checkpoint：** `pytest tests/unit/test_core.py`，验证 ID 生成、错误实例化、SSE 格式化。

---

## Phase 2 — domain 层

**目标：** 全部业务模型和服务逻辑，零框架依赖，可独立单元测试。

每个子域结构统一：`models.py`（Pydantic）+ `repository.py`（Protocol）+ `service.py`（业务逻辑）

### 2.1 user 域
**`domain/user/models.py`**
- `User`：id, email, hashed_password, created_at
- `UserProfile`：按 `§11.8` 完整字段定义（full_name, career_stage, target_roles 等）

**`domain/user/repository.py`**
```python
class UserRepository(Protocol):
    async def get_by_id(self, user_id: str) -> User | None: ...
    async def get_by_email(self, email: str) -> User | None: ...
    async def create(self, email: str, hashed_password: str) -> User: ...
    async def get_profile(self, user_id: str) -> UserProfile | None: ...
    async def upsert_profile(self, user_id: str, profile: UserProfile) -> UserProfile: ...
```

**`domain/user/service.py`**
- `authenticate(email, password) -> User`
- `get_or_create_profile(user_id) -> UserProfile`
- `update_profile(user_id, patch) -> UserProfile`

---

### 2.2 experience 域
**`domain/experience/models.py`**
- `Experience`：id, user_id, category, title, organization, role, start_date, end_date, tags, status, current_revision_id, created_at, updated_at
- `ExperienceRevision`：id, experience_id, content, source, created_at
- `ImportCandidate`：id, import_job_id, user_id, title, category, organization, role, content, status
- `ImportJob`：id, user_id, source（"text" | "file"）, status, created_at

**`domain/experience/repository.py`**
```python
class ExperienceRepository(Protocol):
    async def list(self, user_id: str, *, limit: int, cursor: str | None, category: str | None, tags: list[str] | None) -> tuple[list[Experience], str | None]: ...
    async def get(self, user_id: str, experience_id: str) -> Experience | None: ...
    async def create(self, ...) -> Experience: ...
    async def update(self, user_id: str, experience_id: str, patch: dict) -> Experience: ...
    async def archive(self, user_id: str, experience_id: str) -> None: ...
    async def get_revisions(self, experience_id: str) -> list[ExperienceRevision]: ...
    async def add_revision(self, experience_id: str, content: str, source: str) -> ExperienceRevision: ...
    async def create_import_job(self, user_id: str, source: str) -> ImportJob: ...
    async def create_candidates(self, job_id: str, candidates: list[dict]) -> list[ImportCandidate]: ...
    async def get_candidate(self, user_id: str, candidate_id: str) -> ImportCandidate | None: ...
    async def update_candidate_status(self, candidate_id: str, status: str) -> ImportCandidate: ...
```

**`domain/experience/service.py`**
- `list_experiences(user_id, ...)` → 分页列表
- `get_experience_detail(user_id, id)` → Experience + current revision + all revisions
- `create_experience(user_id, data)` → Experience + 首个 revision
- `update_experience_meta(user_id, id, patch)` → 只更新结构化字段
- `add_revision(user_id, id, content, source)` → 新 revision，更新 current_revision_id
- `archive_experience(user_id, id)`
- `create_import_job_from_text(user_id, text)` → ImportJob + candidates（调用 LLM 提取，此处依赖注入 extractor）
- `create_import_job_from_file(user_id, file_id, parsed_text)` → 同上
- `accept_candidate(user_id, candidate_id)` → 创建 Experience
- `reject_candidate(user_id, candidate_id)`

---

### 2.3 jd 域
**`domain/jd/models.py`**
- `JdRecord`：id, user_id, title, company, target_role, raw_text, requirements（JSON）, created_at, updated_at
- `JdRequirement`：id, text, category, importance

**`domain/jd/repository.py`** + **`service.py`**
- `list_jds`, `get_jd`, `create_jd`（含 requirements 解析）, `delete_jd`

---

### 2.4 resume 域
**`domain/resume/models.py`**
- `Resume`：id, user_id, title, target_role, jd_id, status, created_at, updated_at
- `ResumeItem`：id, resume_id, section_type, title, content_snapshot, order_index, hidden, pinned, source_experience_id, source_variant_id, created_at, updated_at
- `ResumeVariant`：id, resume_id, jd_id, title, content, score（JSON）, evidence_summary（JSON）, risk_summary（JSON）, created_at

**`domain/resume/repository.py`** + **`service.py`**
- Resume CRUD + items CRUD + reorder + variant 存储/查询

---

### 2.5 artifact 域
**`domain/artifact/models.py`**
- `Artifact`：id, user_id, type, title, content, source_jd_id, source_experience_ids（JSON）, created_at, updated_at

**`domain/artifact/repository.py`** + **`service.py`**
- `list_artifacts`, `get_artifact`, `create_artifact`, `update_artifact`, `delete_artifact`
- `record_edit_signal(artifact_id, before, after)`：写 PreferenceSignal，供后续 PreferenceBank 学习

---

### 2.6 preference 域
**`domain/preference/models.py`**
- `Preference`：id, user_id, rule, category, source（explicit/rejection_signal/edit_pattern）, priority, confidence, reinforcement_count, scope, created_at, last_reinforced_at
- `PreferenceSignal`：id, user_id, signal_type, raw_content, generation_context（JSON）, created_at

**`domain/preference/repository.py`** + **`service.py`**
- `get_active_preferences(user_id, category_filter, scope)` → 按 priority DESC 排序
- `add_explicit_preference(user_id, rule, category, scope)` → priority=100
- `record_signal(user_id, signal_type, raw_content, context)`
- `process_signal(signal_id)` → LLM 提取 → upsert preference（embedding 去重）
- `delete_preference(user_id, preference_id)`
- `consolidate(user_id)` → 检测矛盾、合并相似、清理弱信号

**✅ Checkpoint：** `pytest tests/unit/test_domain/` 所有 service 方法均有单元测试，无需数据库（mock repository）。

---

## Phase 3 — infra 层

**目标：** 数据库连接池、所有 Repository 的 Postgres 实现、文件解析。

### 3.1 数据库迁移
**`alembic/versions/0001_initial_schema.py`**

建表顺序（外键依赖）：
```
users → user_profiles
      → experiences → experience_revisions
                    → import_jobs → import_candidates
      → jd_records
      → resumes → resume_items
                → resume_variants
      → artifacts
      → preferences
      → preference_signals
      → threads（LangGraph checkpointer 用）
```

pgvector 扩展：`CREATE EXTENSION IF NOT EXISTS vector;`

关键字段：
- `experiences.embedding vector(1536)` — 语义搜索
- `experience_revisions.embedding vector(1536)`
- `jd_records.requirements jsonb`
- `preferences.embedding vector(1536)` — 去重用
- `guideline_chunks` 表（RAG 用）：id, content, embedding, metadata

**`alembic/versions/0002_langgraph_checkpointer.py`**
LangGraph PostgresSaver 所需的表（按官方 schema）。

---

### 3.2 连接池
**`app/infra/db/connection.py`**
```python
async def create_pool(settings: Settings) -> asyncpg.Pool: ...
async def get_pool() -> asyncpg.Pool: ...   # FastAPI 依赖注入用
```

---

### 3.3 Repository 实现
**`app/infra/db/repositories/`** — 按 domain 一一对应实现：

每个 repository 实现 domain 层定义的 Protocol，只有这一层能直接写 SQL。

关键实现点：
- cursor-based 分页（`WHERE id > $cursor ORDER BY id LIMIT $limit`）
- 所有写操作在事务内执行
- `experience` 更新 `current_revision_id` 与创建 revision 在同一事务
- 语义搜索：`ORDER BY embedding <=> $query_embedding LIMIT $k`

---

### 3.4 文件存储与解析
**`app/infra/files/storage.py`**
```python
class FileStorage(Protocol):
    async def save(self, content: bytes, filename: str) -> str: ...  # 返回存储路径
    async def get(self, path: str) -> bytes: ...
    async def delete(self, path: str) -> None: ...

class LocalFileStorage:  # 开发用
class S3FileStorage:     # 生产用，通过 config 切换
```

**`app/infra/files/parser.py`**（同步接口）
```python
def parse_pdf(content: bytes) -> str: ...        # pypdf
def parse_docx(content: bytes) -> str: ...       # python-docx
def parse_file(content: bytes, mime_type: str) -> str: ...  # 统一入口
```

**✅ Checkpoint：** 运行 `alembic upgrade head`，所有表创建成功；`pytest tests/integration/test_repositories.py`（需真实 DB）。

---

## Phase 4 — Auth

**目标：** 登录/登出/鉴权中间件，解锁所有需要认证的接口。

### 文件

**`app/api/middleware/auth.py`**
- `AuthMiddleware`：从 Cookie 或 Bearer token 解析 user_id，注入 `request.state.user_id`
- 白名单：`/v1/health`, `/v1/auth/login`

**`app/api/routes/auth.py`**
- `POST /v1/auth/login`：验证 email/password → 生成 session token → Set-Cookie
- `POST /v1/auth/logout`：清除 Cookie
- `GET /v1/users/me`：返回当前用户基础信息

**`app/api/deps.py`**
```python
async def get_current_user(request: Request) -> User: ...      # FastAPI 依赖
async def get_db() -> asyncpg.Connection: ...
async def get_services() -> ServiceContainer: ...
```

**✅ Checkpoint：** `POST /v1/auth/login` 返回 session cookie，`GET /v1/users/me` 需认证，未认证返回 401。

---

## Phase 5 — Product REST APIs（非 Agent）

**目标：** 经历库、JD、简历、Artifact、文件、用户 Profile 的全部 CRUD 接口。前端 P0/P1/P2/P3 中的非 Copilot 接口全部可用。

### 5.1 统一响应封装

**`app/api/response.py`**
```python
def ok(data: Any, request_id: str) -> dict: ...
def err(error: AppError, request_id: str) -> JSONResponse: ...
```

**`app/api/middleware/`**
- `RequestIdMiddleware`：生成/透传 `X-Request-Id`
- `IdempotencyMiddleware`：缓存幂等键 + 响应
- `ErrorHandlerMiddleware`：捕获 `AppError` → 统一错误响应格式

---

### 5.2 各路由文件

按 `api-contract.md` 逐接口实现，每个路由文件对应一个资源：

**`app/api/routes/product/experience.py`**
- `GET /v1/product/experiences` — 列表（支持 limit/cursor/category/tags/q）
- `POST /v1/product/experiences`
- `GET /v1/product/experiences/:id`
- `PATCH /v1/product/experiences/:id`
- `DELETE /v1/product/experiences/:id`
- `POST /v1/product/experiences/:id/revisions`
- `POST /v1/product/import/text`
- `POST /v1/product/import/file`
- `POST /v1/product/import-candidates/:id/accept`
- `POST /v1/product/import-candidates/:id/reject`

**`app/api/routes/product/jd.py`**
- `GET /v1/product/jds`
- `POST /v1/product/jds`（含同步 requirements 解析，此阶段用规则提取，Phase 6 后换 LLM）
- `GET /v1/product/jds/:id`
- `DELETE /v1/product/jds/:id`

**`app/api/routes/product/resume.py`**
- `GET /v1/product/resumes`
- `POST /v1/product/resumes`
- `GET /v1/product/resumes/:id`
- `PATCH /v1/product/resumes/:id`
- `POST /v1/product/resumes/:id/items`
- `PATCH /v1/product/resume-items/:id`
- `DELETE /v1/product/resume-items/:id`
- `POST /v1/product/resumes/:id/reorder`

**`app/api/routes/product/artifact.py`**
- `GET /v1/product/artifacts`
- `GET /v1/product/artifacts/:id`
- `PATCH /v1/product/artifacts/:id`（含 edit diff 信号记录）
- `DELETE /v1/product/artifacts/:id`

**`app/api/routes/files.py`**
- `POST /v1/files/upload`
- `POST /v1/files/:id/parse`（同步，调用 `infra/files/parser.py`）

**`app/api/routes/users.py`**
- `GET /v1/users/me/profile`
- `PATCH /v1/users/me/profile`
- `GET /v1/users/me/preferences`
- `POST /v1/users/me/preferences`
- `DELETE /v1/users/me/preferences/:id`

**`app/api/routes/dashboard.py`**
- `GET /v1/copilot/sidebar`
- `GET /v1/dashboard`

**✅ Checkpoint：** 按 `api-contract.md §附录A` P0/P1/P2/P3 中的非 Copilot 接口全部可通过 HTTP 测试，响应格式符合 Envelope 规范。

---

## Phase 6 — providers 层

**目标：** LLM 调用统一抽象，让上层代码不关心具体厂商。

**`app/providers/base.py`**
```python
class LLMProvider(Protocol):
    async def chat(self, messages: list[Message], *, stream: bool = False, response_format: type | None = None) -> str | AsyncIterator[str]: ...
    async def embed(self, texts: list[str]) -> list[list[float]]: ...
```

**`app/providers/openai_format.py`**
- 基于 `langchain-openai`，支持 `base_url` 配置（兼容 DeepSeek、通义千问等）

**`app/providers/anthropic_format.py`**
- 基于 `langchain-anthropic`

**`app/providers/factory.py`**
```python
def get_provider(settings: Settings) -> LLMProvider: ...  # 根据 llm_provider 配置选择
def get_embedding_provider(settings: Settings) -> EmbeddingProvider: ...
```

**升级 JD requirements 解析**：Phase 5 中 JD 保存接口的规则提取换成 LLM 结构化输出（`POST /v1/product/jds` 现在真正返回 `requirements`）。

**✅ Checkpoint：** 编写 provider 单元测试（mock HTTP），验证流式输出和结构化输出正确解析。

---

## Phase 7 — rag 层

**目标：** Guideline RAG 和 Evidence RAG 独立可用。

### 7.1 Guideline RAG

**`app/rag/guideline/ingestion.py`**
- 将写作规范文档切片 → embedding → 存入 `guideline_chunks` 表
- 提供 CLI 命令：`python -m app.rag.guideline.ingestion --file guidelines.md`

**`app/rag/guideline/service.py`**
```python
async def retrieve(
    query: str,           # target_role + intent_description
    top_k: int = 5,
) -> list[str]: ...       # 返回 guideline 指令列表
```

---

### 7.2 Evidence RAG

**`app/rag/evidence/claim_extractor.py`**
```python
async def extract_claims(experience_content: str) -> list[Claim]: ...
# LLM 结构化输出：[{ text, category, is_quantified }]
```

**`app/rag/evidence/indexer.py`**
```python
async def index_experience(experience_id: str, revision_id: str, content: str) -> None:
    # 1. 提取 claims
    # 2. 对 claims embedding
    # 3. 存入 DB
    # 4. 更新 experience.embedding（内容整体向量）
```

在 `domain/experience/service.py` 的 `add_revision` 和 `create_experience` 完成后，调用 indexer（依赖注入）。

**`app/rag/evidence/service.py`**
```python
async def retrieve_for_jd(
    jd_requirements: list[JdRequirement],
    user_id: str,
    top_k: int = 8,
) -> list[ExperienceWithClaims]: ...

async def build_evidence_pack(
    jd_requirements: list[JdRequirement],
    experiences: list[ExperienceWithClaims],
) -> EvidencePack: ...
```

**✅ Checkpoint：** 写入 2 条经历 → 触发 indexer → 保存一条 JD → 调用 `retrieve_for_jd`，返回相关经历。

---

## Phase 8 — memory 层

**目标：** Thread State 定义 + Context Assembly 完整逻辑 + 滚动摘要。

**`app/memory/thread_state.py`**
按 `§19.1` 和 `§6.1` 定义完整 `ThreadState TypedDict`。

**`app/memory/context_assembly.py`**
```python
async def assemble_context(
    state: ThreadState,
    intent_description: str,
    context_hints: list[str],
    token_budget: int = 6000,
) -> AssembledContext: ...
```

内部按 `§20` 的策略：并行检索（asyncio.gather）→ evidence pack 构建 → token 预算截断 → 结构化 prompt 组装。

**`app/memory/rolling_summary.py`**
```python
async def compress_history(
    messages: list[Message],
    threshold: int = 20,     # 超过多少条触发压缩
) -> tuple[str, list[Message]]: ...  # (摘要, 保留的近期原文)
```

**✅ Checkpoint：** 给定 mock ThreadState + 一条 intent，`assemble_context` 返回结构化 prompt，验证 token 预算不超限。

---

## Phase 9 — tools 层

**目标：** 所有业务工具实现 Tool 协议，统一注册，可被 graph 层调用。

**`app/tools/base.py`**
```python
class ToolResult(BaseModel):
    status: Literal["success", "needs_input", "failed"]
    data: Any | None = None
    message: str | None = None

class Tool(Protocol):
    name: str
    description: str
    input_schema: type[BaseModel]
    requires_confirmation: bool
    risk_level: Literal["low", "medium", "high"]

    async def execute(self, input: BaseModel, context: ToolContext) -> ToolResult: ...

class ToolContext(BaseModel):
    user_id: str
    thread_id: str
    services: ServiceContainer    # 注入所有 domain service
```

**`app/tools/registry.py`**
```python
_registry: dict[str, Tool] = {}

def register(tool: Tool) -> None: ...
def get_all() -> list[Tool]: ...
def get(name: str) -> Tool: ...
```

**工具实现**（每个文件末尾调用 `register()`）：

`tools/experience/`：list, get, save, update, delete, import_text, import_file, accept_candidate, reject_candidate, match_jd

`tools/jd/`：list, get, save

`tools/resume/`：list, get, generate（占位，Phase 11 完善）, revise_item（占位）, accept_variant

`tools/artifact/`：create（占位）, get

`tools/evidence/`：show, check_claims

**✅ Checkpoint：** `get_all()` 返回所有已注册工具，每个工具 input_schema 验证可正常执行（mock service）。

---

## Phase 10 — graphs 骨架 + Router

**目标：** LangGraph 主 Graph 可运行，Router Node 能正确路由，Thread State 持久化正常。

**`app/infra/db/checkpointer.py`**
```python
async def create_checkpointer(pool: asyncpg.Pool) -> PostgresSaver: ...
```

**`app/graphs/state.py`**
完整 `MainState TypedDict`（包含 ThreadState 所有字段 + 路由决策字段）。

**`app/graphs/router.py`**

Router Node：
```python
async def router_node(state: MainState) -> dict:
    # 1. 构建 thread_state_summary
    # 2. 调用 LLM structured output → RouterOutput
    # 3. 写入 state: target_subgraph, intent_description, context_hints, extracted_params
```

Conditional edge：
```python
def route(state: MainState) -> str:
    return state["target_subgraph"]  # → subgraph 名称
```

**`app/graphs/main.py`**
```python
def build_main_graph(checkpointer: PostgresSaver) -> CompiledGraph:
    builder = StateGraph(MainState)
    builder.add_node("router", router_node)
    builder.add_node("experience_import", experience_import_subgraph)
    builder.add_node("jd", jd_subgraph)
    builder.add_node("resume_generation", resume_generation_subgraph)  # 占位
    builder.add_node("artifact", artifact_subgraph)                    # 占位
    builder.add_node("open_ended", open_ended_node)
    builder.add_conditional_edges("router", route)
    builder.set_entry_point("router")
    return builder.compile(checkpointer=checkpointer)
```

**`app/graphs/jd/graph.py` + `nodes.py`**（最简单，先实现）：
- `save_jd_node`：调用 `tools/jd/save`
- `parse_requirements_node`：LLM 解析 JD → requirements，更新 JD 记录

**`app/graphs/experience/graph.py` + `nodes.py`**：
- `parse_node`：调用文件解析 / 文本提取 + claim extractor
- `review_candidates_node`：构建 candidates，触发 interrupt
- `save_node`：accept/reject 后写库

**✅ Checkpoint：** 发一条"帮我保存这个 JD"的消息 → Router 路由到 `jd` → JD 被保存，`GET /v1/product/jds` 可查到。

---

## Phase 11 — 核心 Subgraphs

**目标：** 实现简历生成（最复杂）和 Artifact 生成两个核心子图，SSE 流式输出正确。

### 11.1 Resume Generation Subgraph

按 `§19` 完整实现：

**`app/graphs/resume/state.py`**：`ResumeGenerationState` TypedDict

**`app/graphs/resume/nodes.py`**：

`context_assembly_node`：调用 `memory/context_assembly.py`，写入所有 context 字段

`cot_planning_node`：
- 输入：jd_requirements + relevant_experiences + guideline_instructions + evidence_pack + user_preferences + user_profile
- LLM 调用（structured output）→ MatchingPlan
- 写入 state: matching_plan, generation_strategy

`draft_generation_node`：
- 基于 matching_plan + generation_strategy + intent_description
- **流式 LLM 调用**，每个 token 构造 `ContentDiffDeltaEvent` 推入 `pending_sse_events`
- 生成完成后计算 Myers diff（与原 resume items 对比），构造 `ContentDiffCompletedEvent`
- 写入 state: variants, current_diff

`self_review_node`：
- 检查每个 variant：claim 是否有 evidence 支撑，是否有不可验证断言
- 输出 ReviewResult（pass / needs_revision）
- `review_iteration < 3` 时 needs_revision → Revision Node；否则强制 pass

`revision_node`：
- 读取 review_result.revision_instruction
- 针对性重写 variant
- review_iteration += 1

`output_node`：
- 构造 InterruptPayload
- 调用 `interrupt(payload)`（LangGraph 原生）

**Conditional edge**：
```python
def review_route(state) -> str:
    if state["review_result"].verdict == "pass" or state["review_iteration"] >= 3:
        return "output"
    return "revision"
```

**`app/graphs/resume/graph.py`**：组装 Subgraph

---

### 11.2 Artifact Generation Subgraph

**`app/graphs/artifact/registry.py`**
```python
ARTIFACT_REGISTRY = {
    "cover_letter":  ArtifactTypeConfig(default_context_hints=["active_jd", "experiences", "profile"]),
    "self_intro":    ArtifactTypeConfig(default_context_hints=["experiences", "target_role", "profile"]),
    "match_report":  ArtifactTypeConfig(default_context_hints=["active_jd", "experiences"]),
    "interview_prep":ArtifactTypeConfig(default_context_hints=["active_jd", "experiences"]),
    # 新增 type 只需加一行
}
```

**`app/graphs/artifact/nodes.py`**：

`context_assembly_node`：按 artifact_type 的 default_context_hints（可被 intent_description 覆盖）调用 context_assembly

`draft_generation_node`：
- 流式 LLM 调用，token 构造 `ArtifactDeltaEvent` 推入 `pending_sse_events`
- 生成完成后构造 `ArtifactCompletedEvent`
- 调用 `domain/artifact/service.create_artifact` 持久化

---

### 11.3 Open-Ended Node

**`app/graphs/open_ended.py`**：
- LangGraph 原生 ReAct，工具列表来自 `tools/registry.get_all()`
- 每次工具调用前后推送 `agent.tool.started` / `agent.tool.completed` SSE 事件

**✅ Checkpoint：** 发"基于字节跳动 JD 帮我生成简历" → 走完 resume_generation subgraph → SSE 事件流正确 → `agent.interrupt` 触发 → 前端可看到 variants。

---

## Phase 12 — Copilot API + Thread 管理

**目标：** 所有 Copilot 接口上线，SSE 流式正确推送，interrupt 生命周期完整。

### 12.1 SSE 推送机制

**`app/api/sse.py`**
```python
async def stream_graph_events(
    graph: CompiledGraph,
    input: dict,
    config: RunnableConfig,
) -> AsyncIterator[str]:
    # 使用 graph.astream_events() 监听 LangGraph 事件
    # 将 pending_sse_events 转为 SSE 格式推送
    # 监听 interrupt → 推送 agent.interrupt 事件
    # 结束时推送 agent.completed（含完整 CopilotChatResponse）
```

### 12.2 路由文件

**`app/api/routes/copilot.py`**
- `POST /v1/copilot/chat`：同步，等待 graph 完成，返回 `CopilotChatResponse`
- `POST /v1/copilot/chat/stream`：返回 `StreamingResponse`（SSE），调用 `stream_graph_events`
- `POST /v1/copilot/actions`：显式动作，构造 message → 调用 graph

**`app/api/routes/threads.py`**
- `GET /v1/threads`：从 DB 查询用户会话列表
- `GET /v1/threads/:id`：会话详情 + 消息历史 + workspace 恢复
- `PATCH /v1/threads/:id`：更新标题/状态
- `POST /v1/threads/:id/resume`：`graph.ainvoke(Command(resume=True), config)` → 返回 CopilotChatResponse
- `POST /v1/threads/:id/discard`：`graph.ainvoke(Command(resume=False), config)` + 记录 rejection 信号

### 12.3 Workspace 构建

**`app/api/copilot/workspace_builder.py`**
```python
async def build_workspace(state: MainState, user_id: str) -> Workspace:
    # 根据 state 中的 active panel 信息，查询并组装 Workspace 对象
    # 对应 api-contract.md §4.1 的 Workspace 结构
```

**✅ Checkpoint：**
- `POST /v1/copilot/chat` 完整走通（Router → JD Subgraph → 返回 CopilotChatResponse）
- `POST /v1/copilot/chat/stream` SSE 事件流正确（用 `curl --no-buffer` 验证）
- interrupt 流程：chat/stream → `agent.interrupt` → `POST /threads/:id/resume` → 数据入库

---

## Phase 13 — PreferenceBank 反馈闭环

**目标：** 三类信号自动写入 PreferenceBank，生成时偏好生效。

### 13.1 信号接入点

**显式对话信号**：在 Router Node 之后，每轮对话结束时，跑一次轻量 LLM 检测是否包含偏好表达，有则写 `PreferenceSignal`。

**拒绝信号**：`POST /v1/threads/:id/discard` 中，若 `reason` 非空，调用 `preference_service.record_signal(user_id, "rejection", reason, context)`。

**编辑 diff 信号**：`PATCH /v1/product/artifacts/:id` 中，计算 before/after diff，若变化量超阈值，调用 `artifact_service.record_edit_signal`（内部写 PreferenceSignal）。Resume item 编辑同理（`PATCH /v1/product/resume-items/:id`）。

### 13.2 信号处理

**`app/domain/preference/service.py`** 中的 `process_signal`：
- LLM 结构化输出提取规则 → `ExtractedPreference`
- embedding 去重（相似度 > 0.85 → 强化已有条目而非新建）
- 积累 5 条信号后触发 `consolidate`

### 13.3 生成时注入

在 Context Assembly Node 中调用 `preference_service.get_active_preferences`，将偏好注入 prompt 的"用户偏好"区块。

**✅ Checkpoint：** 拒绝一次生成 + 给出原因 → `GET /v1/users/me/preferences` 可看到新增条目 → 再次生成时偏好已融入 prompt。

---

## Phase 14 — 测试补全与质量收尾

**目标：** 关键路径有测试覆盖，代码质量达标。

### 14.1 单元测试（`tests/unit/`）
- `test_core/`：types, errors, SSE format
- `test_domain/`：每个 service 的核心方法（mock repository）
- `test_tools/`：每个 tool 的 execute（mock service）
- `test_providers/`：LLM 调用（mock httpx）
- `test_rag/`：evidence pack 构建逻辑

### 14.2 集成测试（`tests/integration/`）
需要真实 DB（测试环境 docker-compose）：
- `test_repositories/`：每个 repository 的 CRUD
- `test_graph_flows/`：
  - JD 保存完整流程
  - 经历导入完整流程（文本 → candidates → accept）
  - Artifact 生成流程
  - Resume 生成 + interrupt + resume 完整流程

### 14.3 API 契约测试（`tests/api/`）
按 `api-contract.md §附录A` P0 优先级逐接口验证响应格式是否符合 Envelope 规范。

### 14.4 代码质量
```bash
ruff check app/          # lint
ruff format app/         # format
mypy app/               # 类型检查
```

**✅ 最终 Checkpoint：** 核心 4 条业务链路全部端到端可用：
1. 文本导入经历 → 经历库可查
2. 保存 JD → requirements 已解析
3. 生成 Cover Letter → SSE 流式输出 → Artifact 已保存
4. 基于 JD 生成简历 → interrupt → 确认 → Resume 已写库

---

## 各 Phase 依赖关系

```
Phase 0（项目初始化）
    │
    ▼
Phase 1（core）
    │
    ▼
Phase 2（domain）
    │
    ├──▶ Phase 3（infra）──▶ Phase 4（auth）──▶ Phase 5（REST APIs）
    │                                                    │
    │                                                    ▼
    ├──▶ Phase 6（providers）                        可验证点：
    │           │                                   所有非 Agent 接口可用
    │           ├──▶ Phase 7（rag）
    │           │           │
    │           └──▶ Phase 8（memory）
    │                       │
    │                       ▼
    └───────────────▶ Phase 9（tools）
                            │
                            ▼
                     Phase 10（graphs 骨架 + Router）
                            │
                            ▼
                     Phase 11（核心 Subgraphs）
                            │
                            ▼
                     Phase 12（Copilot API + SSE）
                            │
                            ▼
                     Phase 13（PreferenceBank 闭环）
                            │
                            ▼
                     Phase 14（测试补全）
```

---

## 工作量估算参考

| Phase | 复杂度 | 关键风险 |
|---|---|---|
| 0–1 | 低 | 无 |
| 2 | 中 | domain 设计一旦定型后续改动成本高，需充分 review |
| 3 | 中 | pgvector 迁移脚本、并发安全 |
| 4–5 | 低-中 | 幂等中间件实现 |
| 6 | 低 | provider 切换测试 |
| 7 | 中 | claim 提取质量依赖 prompt 调优 |
| 8 | 中 | token 预算计算逻辑 |
| 9 | 低 | 工具多但结构简单 |
| 10 | 中 | LangGraph checkpointer 配置 |
| **11** | **高** | **Resume Generation Subgraph 最复杂，self-review loop + SSE 联调** |
| **12** | **高** | **SSE + interrupt 生命周期，前后端联调核心** |
| 13 | 中 | embedding 去重 + consolidation 逻辑 |
| 14 | 中 | 集成测试环境搭建 |
