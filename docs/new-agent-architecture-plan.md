# 新版多 Agent 后端架构规划

> 状态：草稿 · 持续迭代中
> 基于旧版 cv-agent 分析，迁移至 LangChain + LangGraph

---

## 一、旧版核心问题

### 1.1 输出质量差

| 问题 | 根因 |
|---|---|
| Prompt 静态、缺乏动态推理 | Prompt 是 markdown 文件，RAG 结果和用户偏好只是"附在后面"，没有真正融入推理链 |
| Critic 机制形同虚设 | CriticGate 只有 pass / revise / block 三档，revise 仅重发一条 revision request，没有真正迭代 |
| Variant 生成套模板 | 固定 4 种 role，不根据 JD 和经历动态推导 |
| 大量确定性 fallback | `deterministicAgentFallback` 绕过了真正的 LLM 推理，输出死板 |
| 反馈信号断路 | 用户编辑/拒绝生成内容后，信号没有回写 PreferenceBank，自我进化不形成闭环 |

### 1.2 架构过度设计

- **FrontDeskAgent 不必要**：意图识别本质是分类+路由，用完整 Agent 生命周期代价太高
- **Agent 间通信复杂**：通过 AgentMessageBus + AgentObservation 传递，难以调试和扩展
- **Critic 是全局 Gate**：不在推理路径内，无法做局部迭代
- **PendingAction 外挂**：确认机制绕开了 Agent 执行流程，需要单独维护表和生命周期

---

## 二、新版设计原则

1. **质量优先**：生成、自查、改写在 graph 内真正迭代，不是一次性输出
2. **路由轻量化**：Router 是 conditional edge + 一次结构化 LLM 调用，不是 Agent
3. **推理链显式**：每个 node 职责单一，state 流转清晰可追踪
4. **RAG 深度融合**：guideline 和 evidence 在生成 node 内部参与推理，不是后处理附加
5. **偏好动态注入**：PreferenceBank 在每次生成前实时查询，作为 soft constraint 融入 prompt
6. **输出自由不死板**：类型标签只用于存储分类，实际生成行为由 intent_description 驱动
7. **高扩展性**：工具、子图、artifact 类型、LLM provider 均可独立扩展，互不耦合
8. **自我进化闭环**：用户反馈信号（编辑、拒绝、采纳）自动回写 PreferenceBank

---

## 三、技术栈选型

| 层 | 选型 | 说明 |
|---|---|---|
| Agent 框架 | LangGraph (Python) | StateGraph 支持条件边、子图、循环，天然适合多轮推理 |
| LLM 调用 | LangChain | 统一 provider 接口，支持 OpenAI format / Anthropic format |
| LLM Provider | OpenAI format + Anthropic format | 主流厂商均支持其中一种，两种格式覆盖全部需求 |
| 向量检索 | PostgreSQL pgvector | 沿用旧版，避免引入额外依赖 |
| API 层 | Python FastAPI（全栈） | async 模式保证并发；若并发瓶颈出现，可拆出 Node.js BFF + Python Agent 服务 |
| 持久化 | PostgreSQL | 沿用旧版 schema，asyncpg |
| Graph 持久化 | LangGraph PostgreSQL Checkpointer | Thread state 跨轮次持久化，支持 interrupt/resume |
| 异步任务 | 无 | PDF 由前端浏览器 print-to-PDF；文件解析做成同步接口；无需独立 Job 系统 |
| 语言 | Python | LangChain/LangGraph 原生语言 |

---

## 四、整体 Graph 结构

```
用户消息 + Thread State
        │
        ▼
[Router Node]  ── 轻量结构化 LLM 调用
    │  输出：{ intent, target_subgraph, intent_description, context_hints }
    │
    ├── experience_import  ──▶ [Experience Import Subgraph]
    ├── jd                 ──▶ [JD Subgraph]
    ├── resume_generation  ──▶ [Resume Generation Subgraph]
    ├── artifact           ──▶ [Artifact Generation Subgraph]
    ├── export             ──▶ [Export Subgraph]
    └── open_ended         ──▶ [Tool-Calling Agent Node]  ← 兜底，自由调用工具
```

### 4.1 Router Node（取代 FrontDeskAgent）

- 一次结构化 LLM 调用，不需要 memory、tool loop
- 输出 `intent_description`（自然语言描述意图）传入下游 subgraph，驱动生成行为
- `open_ended` 路由兜底处理无法归类的意图，让 LLM 自由决定调用哪些工具

### 4.2 Resume Generation Subgraph

```
[Context Assembly Node]
    │  拉取：JD requirements、经历库（RAG 检索）、Guideline RAG、PreferenceBank、用户 Profile
    ▼
[Chain-of-Thought Planning Node]
    │  推导：哪些经历匹配哪些 requirement，生成策略，决定输出结构
    ▼
[Draft Generation Node]
    │  流式生成 variants（数量和风格动态决定，非固定模板）
    │  同步发出 content.diff.* SSE 事件供前端画布渲染
    ▼
[Self-Review Node]  ◄──────────────────────────┐
    │  检查：evidence grounding、claim 真实性       │
    │  输出：pass / needs_revision                  │ (loop, max 3)
    ├── pass ──▶ [interrupt Node]                   │
    │            用户确认后写入简历库                 │
    └── needs_revision ────────────────────────────►┘
                   [Revision Node]
```

### 4.3 Experience Import Subgraph

```
[Parse Node]
    │  文件（PDF/Word/...）或纯文本 → 结构化经历列表
    ▼
[Candidate Review Node]
    │  生成 import candidates，附结构化字段
    ▼
[interrupt Node]  ← 用户逐条 accept / reject
    │
    ▼
[Save Node]  → 写入经历库，生成首个 revision
```

### 4.4 JD Subgraph

```
[Save + Parse Node]
    │  保存 JD 原文，同步解析结构化 requirements
    ▼
[Experience Match Node]（可选，用户触发）
    │  JD requirements × 经历库 claims → 匹配报告
    ▼
[Output Node]  → 返回匹配结果 / 写入 match_report artifact
```

### 4.5 Artifact Generation Subgraph（cover letter / 自我介绍等）

```
[Context Assembly Node]
    │  按 context_hints 决定拉取：JD、经历库（RAG）、用户 Profile、PreferenceBank
    ▼
[Draft Generation Node]
    │  流式输出 markdown，由 intent_description 驱动（不是 type 决定行为）
    │  同步发出 artifact.* SSE 事件
    ▼
[Artifact Persist Node]
    │  保存为 Artifact 实体，关联 source JD / experience IDs
    ▼
[Output Node]
```

### 4.6 Export Subgraph

PDF 导出 = 前端画布的 headless 渲染，保证 WYSIWYG。后端不维护独立模板，直接用 Puppeteer/Chrome headless 打印前端相同的 HTML/CSS。前端改样式，PDF 自动跟着变。

```
[HTML Snapshot Node]  → 接收前端画布 HTML（或按 resumeId 重建）
    ▼
[PDF Render Node]（Puppeteer headless，异步 Job）
    ▼
[Output Node]  → 返回 export record + download URL
```

### 4.7 Tool-Calling Agent Node（open_ended 兜底）

- LangGraph ReAct 风格，LLM 自由决定调用哪些工具
- 所有注册工具均可用
- 不需要预定义路由，适合用户的发散性需求

---

## 五、Artifact 生成：自由不死板

### 5.1 核心原则

`artifact_type` 只是存储用的元数据标签，**不参与生成逻辑**。生成行为完全由 `intent_description` 驱动：

```json
{
  "target_subgraph": "artifact",
  "artifact_type": "cover_letter",
  "intent_description": "用第一人称，针对这家公司强调系统设计经验，语气专业但不死板，控制在300字以内",
  "context_hints": ["active_jd", "experiences:backend"]
}
```

同一个 `artifact_type`，`intent_description` 不同，输出完全不同。

### 5.2 Artifact 实体

```json
{
  "id": "art-xxx",
  "type": "cover_letter | self_intro | match_report | interview_prep | career_advice | ...",
  "title": "给字节跳动的 Cover Letter",
  "content": "markdown string",
  "sourceJdId": "pjd-xxx",
  "sourceExperienceIds": ["pexp-1", "pexp-2"],
  "createdAt": "..."
}
```

### 5.3 扩展 Artifact 类型

不需要改 subgraph，只需新增类型标签和对应的 context_hints 默认策略：

| type | 默认上下文 |
|---|---|
| `cover_letter` | active_jd + 相关经历 + 用户 Profile |
| `self_intro` | 经历库摘要 + target_role + PreferenceBank |
| `match_report` | JD requirements × 经历 claims |
| `interview_prep` | JD + 经历 + 常见问题库 |
| `linkedin_summary` | 经历库摘要 + 用户 Profile |
| `career_advice` | 全部经历 + target_role |
| 任意新类型 | 在注册时定义默认 context_hints 即可 |

---

## 六、上下文管理

### 6.1 Thread State（跨轮次持久化）

LangGraph Checkpointer 在每个 turn 后持久化完整 graph state，下一轮自动恢复：

```python
class ThreadState(TypedDict):
    # 会话激活资源
    active_jd_id: str | None
    active_resume_id: str | None
    referenced_experience_ids: list[str]
    uploaded_file_ids: list[str]
    recent_artifact_ids: list[str]
    # 对话历史
    messages: list[Message]
    messages_summary: str | None   # 早期轮次的滚动摘要
    # 用户上下文
    user_profile: UserProfile
    target_role: str | None
```

### 6.2 Context Assembly Node 智能拉取

不是全量注入，而是按当前 intent 按需加载：

```
当前 intent: "写一封 cover letter"
        │
        ▼
Context Assembly Node 推断需要：
  ├── active_jd → 从 thread_state.active_jd_id 加载 JD 全文
  ├── 相关经历 → RAG 检索经历库（不全量加载）
  ├── 用户 Profile → thread_state.user_profile
  ├── PreferenceBank → 实时查询用户偏好
  └── 上传的文件 → 如 thread_state.uploaded_file_ids 不空，按需加载
```

### 6.3 滚动摘要（长对话不撑爆 token）

对话超过阈值后，早期轮次做 LLM 压缩摘要：

```
[turn 1-10 摘要: "用户上传了后端简历，目标字节跳动，强调系统设计..."]
[turn 11-15 原文]
[turn 16 当前]
```

---

## 七、待确认操作机制（interrupt + Checkpointer）

### 7.1 工作流程

```
Graph 运行到写操作 Node
        │
        ▼
   Node 调用 interrupt(payload)
        │  payload = { preview: { before, after, diff }, risk, summary }
        ▼
   Graph 状态完整保存到 PostgreSQL Checkpointer
        │
   SSE 推送 agent.interrupt 事件给前端（含 preview diff）
        │
   用户确认 → POST /threads/:thread_id/resume
        │
   Graph 从 checkpoint 恢复，继续执行写操作
```

### 7.2 对比旧版

| 旧版 PendingAction | 新版 interrupt() |
|---|---|
| 单独建表，参数序列化存储 | Graph 完整状态由 LangGraph checkpointer 托管 |
| 需要重新构建执行环境 | 直接从 checkpoint 恢复，上下文完整 |
| 确认机制在 Agent 流程之外 | 是 Graph 执行流的一部分 |
| 过期/校验逻辑需手写 | LangGraph 内置 thread 生命周期管理 |

---

## 八、实时画布 Diff

### 8.1 SSE 事件

```
content.diff.started   → { targetId, targetType, before }
content.diff.delta     → { token }
content.diff.completed → { after, diff: [{type, value}...] }

artifact.started       → { artifactId, artifactType, title }
artifact.delta         → { token }
artifact.completed     → { artifactId, content }
```

### 8.2 两种场景

**低风险自动写入：** `diff.started → delta（实时流）→ diff.completed → 直接写入`

**高风险需确认：** diff 流式完成后触发 `interrupt()`，payload 内含已计算好的 diff；前端画布冻结显示 before/after，用户确认后 resume 写入，拒绝后画布恢复 before。

---

## 九、RAG 深度融合与自我进化

### 9.1 Guideline RAG（升级）

旧版：检索结果附加在 prompt 末尾
新版：检索结果作为 CoT Planning Node 的推理输入，指导生成策略

### 9.2 Evidence RAG（升级）

旧版：生成后做证据验证
新版：
- Context Assembly Node 预构建 evidence pack
- 生成时每条 claim 对应具体 evidence
- Self-Review Node 做 grounded 验证（有 evidence 支撑才 pass）

### 9.3 PreferenceBank 自我进化（闭环修复）

旧版：从对话提取偏好，但用户编辑/拒绝生成内容的信号没有回写
新版：**自动提取与显式设置两者并存**

**自动提取（行为信号）：**
- **信号来源 1**：对话中显式偏好表达（旧版已有）
- **信号来源 2（新增）**：用户拒绝 interrupt → 提取拒绝原因 → 写入 PreferenceBank
- **信号来源 3（新增）**：用户手动编辑生成内容 → diff 对比 → 提取编辑模式 → 写入 PreferenceBank

**显式设置（用户主动）：**
- 用户在设置页直接添加/编辑/删除偏好条目
- 显式设置优先级高于自动提取，不会被行为信号覆盖

定期做 consolidation，合并冲突偏好，形成稳定的用户风格画像。

---

## 十、主要业务链路

### 10.1 经历导入

文件（PDF/Word/图片 OCR）或纯文本 → 解析 → import candidates → 用户 accept/reject → 写入经历库（生成首个 revision）

扩展点：后续可接入 LinkedIn 导入、GitHub 导入等，只需新增 Parse Node 实现。

### 10.2 JD 管理

输入 JD 文本 → 保存 → 异步解析结构化 requirements（技能、经验年限、职责等）→ 可触发经历库匹配分析

### 10.3 简历生成

选定 JD → Context Assembly（经历 RAG + Guideline + Preference）→ CoT Planning → 流式生成 → Self-Review 迭代 → 用户画布确认 → 写入简历库

### 10.4 自由内容生成（Artifact）

用户自然语言输入 → Router 提取 intent_description → Context Assembly（按需拉取）→ 流式 markdown 输出 → 保存 Artifact

### 10.5 导出

简历或 Artifact → HTML 渲染 → PDF 转换（异步 Job）→ 下载链接

### 10.6 经历改写

选中经历 → 用户给出改写方向（或 AI 建议）→ 流式生成新版本 → diff 画布对比 → 用户确认 → 写入新 revision（不覆盖旧版本）

---

## 十一、完整产品能力清单

### 11.1 经历库
- CRUD（list / get / create / update / delete/archive）
- 版本历史（每次修改生成 revision，不覆盖）
- 语义搜索
- 从文件/文本导入（import candidates 流程）
- 与 JD 匹配分析

### 11.2 JD 库
- CRUD
- 结构化 requirements 解析
- 经历库匹配报告

### 11.3 简历库
- CRUD
- resume items 管理（分 section，支持排序/隐藏/置顶）
- 基于 JD 生成
- 单条 item 改写
- fit report / quality report / compression report

### 11.4 Artifact 库
- 多类型（cover letter / 自我介绍 / 匹配报告 / 面试准备等）
- 创建 / 查看 / 编辑 / 删除
- 关联 source JD + experiences

### 11.5 导出
- PDF = 前端画布 headless 渲染（Puppeteer），WYSIWYG
- HTML 快照同步生成
- 异步 Job 管理（状态查询 / 下载链接）

### 11.6 文件管理
- 上传（PDF / Word / 图片）
- 解析（文本提取 / OCR）
- 关联到经历导入 / 简历导入

### 11.7 用户与会话
- 多用户隔离（所有数据按 user_id 隔离）
- Auth（Cookie Session / Bearer）
- LLM API Key 统一在服务端环境变量配置，用户不感知、不管理
- 会话（Thread）列表、历史恢复、归档
- 用户 Profile（见下方字段定义）

### 11.8 用户 Profile 字段

```python
class UserProfile(BaseModel):
    # 基础信息（用于简历头部、cover letter 联系方式）
    full_name: str | None
    email: str | None
    phone: str | None
    location: str | None          # 城市/地区
    linkedin_url: str | None
    github_url: str | None
    personal_website: str | None

    # 职业信息（直接影响生成质量）
    current_title: str | None     # 当前职位
    current_company: str | None
    years_of_experience: int | None
    career_stage: Literal["student", "junior", "mid", "senior", "lead", "executive"] | None
    target_roles: list[str]       # 目标岗位，可多个
    target_industries: list[str]  # 目标行业
    target_locations: list[str]   # 求职地点

    # 生成偏好（影响所有内容输出）
    preferred_language: str       # "zh-CN" | "en-US"，默认 zh-CN
    resume_style: Literal["concise", "detailed"] | None
```

`target_roles`、`career_stage`、`preferred_language` 三个字段对生成影响最大，其余主要用于填充简历头部和 cover letter 联系方式。

### 11.9 后台任务

无独立 Job 系统：
- **PDF 导出**：前端浏览器 print-to-PDF，后端不介入
- **文件解析**：同步接口，上传后直接返回解析结果
- **经历库索引重建**：可作为管理员接口手动触发，无需队列

---

## 十二、扩展性设计

### 12.1 工具扩展性

所有工具通过统一 Tool Registry 注册，新工具只需实现标准接口：

```python
class Tool(Protocol):
    name: str
    description: str
    input_schema: BaseModel
    requires_confirmation: bool
    risk_level: Literal["low", "medium", "high"]

    async def execute(self, input, context) -> ToolResult: ...
```

Router 的 `open_ended` 子图自动感知所有注册工具，无需手动维护路由表。

### 12.2 Subgraph 扩展性

每个业务链路是独立 Subgraph，新增链路只需：
1. 实现 Subgraph（StateGraph）
2. 在 Router Node 增加一个路由分支
3. 注册对应的 intent 关键词

### 12.3 Artifact 类型扩展性

新增 artifact 类型只需在 artifact type registry 中注册：
- type 标签
- 默认 context_hints
- 可选的特定 prompt 片段

Subgraph 本身不需要修改。

### 12.4 LLM Provider 扩展性

通过 LangChain 统一接口，新增 provider 只需在服务端配置中注册：

```python
PROVIDERS = {
    "deepseek": DeepSeekProvider(...),
    "openai": ChatOpenAI(...),
    "compatible": OpenAICompatibleProvider(base_url=..., model=...),
}
```

API key 统一由服务端环境变量管理，切换 provider 不影响业务代码。

### 12.5 RAG 扩展性

Guideline 和 Evidence 分别通过独立 RAG Service 提供，可独立升级检索策略（BM25、向量、混合）而不影响其他模块。

---

## 十三、多用户与历史恢复

- 所有数据按 `user_id` 隔离，Tool 执行时强制 scope guard 校验
- Thread（会话）按 user 归属，列表 / 详情 / 归档 / 删除
- Thread State 由 LangGraph Checkpointer 持久化，重新打开历史会话时自动恢复完整上下文（激活的 JD、简历、经历引用、对话历史摘要）
- 历史会话中的 workspace（当前激活面板、资源）一并恢复，前端不需要重新选择资源

---

## 十四、API 契约

### 保留接口（兼容旧版前端）
- `POST /copilot/chat`
- `POST /copilot/chat/stream`（新增 `content.diff.*` / `artifact.*` / `agent.interrupt` 事件类型）
- `POST /copilot/actions`
- `GET/POST /product/*` REST 接口

### 新增接口
- `POST /threads/:thread_id/resume` — 替代旧版 `/copilot/pending-actions/:id/confirm`
- `GET /artifacts` / `GET /artifacts/:id` — Artifact 管理
- `GET /users/profile` / `PATCH /users/profile` — 用户 Profile

---

## 十五、已决策事项

| 事项 | 决策 | 备注 |
|---|---|---|
| API 层语言 | Python FastAPI 全栈（async） | 若并发瓶颈出现，可拆出 Node.js BFF + Python Agent 服务 |
| LLM Provider 格式 | OpenAI format + Anthropic format | 主流厂商均支持其中一种，无需单独适配每家 |
| Self-Review 迭代上限 | 最多 3 轮 | 延迟与质量的平衡点 |
| 异步任务 | 无独立 Job 系统 | PDF 由前端 print-to-PDF；文件解析做成同步接口 |
| PreferenceBank | 自动提取 + 显式设置两者并存 | 显式设置优先级更高，不被行为信号覆盖 |
| 用户 Profile 字段 | 见第 11.8 节 | |

---

## 十六、目录结构与模块划分

### 16.1 设计原则

**高内聚**：每个模块拥有完整的垂直切片（models + services + repositories），功能自包含。
**低耦合**：模块间通过接口/协议通信，不依赖具体实现；LangGraph 只存在于 `graphs/` 层，domain 层对框架无感知。

**依赖方向（单向，不可反转）：**
```
api → graphs → tools → domain ← infra
                 ↓
           rag / memory / providers
                 ↓
               core
```

### 16.2 目录结构

```
cv-be/
├── app/
│   │
│   ├── api/                        # FastAPI 层（路由、中间件、请求/响应 schema）
│   │   ├── routes/
│   │   │   ├── copilot.py          # /copilot/chat, /copilot/chat/stream, /copilot/actions
│   │   │   ├── threads.py          # /threads/:id/resume（interrupt 确认）
│   │   │   ├── product/
│   │   │   │   ├── experience.py
│   │   │   │   ├── jd.py
│   │   │   │   ├── resume.py
│   │   │   │   ├── artifact.py
│   │   │   │   └── export.py
│   │   │   ├── files.py
│   │   │   ├── auth.py
│   │   │   └── health.py
│   │   ├── middleware/
│   │   │   ├── auth.py             # 鉴权中间件
│   │   │   ├── cors.py
│   │   │   └── idempotency.py
│   │   ├── schemas/                # Pydantic 请求/响应模型（纯 I/O，不含业务逻辑）
│   │   │   ├── copilot.py
│   │   │   ├── experience.py
│   │   │   ├── resume.py
│   │   │   └── ...
│   │   └── deps.py                 # FastAPI 依赖注入（db session、当前用户等）
│   │
│   ├── graphs/                     # LangGraph 层（所有 Graph/Node/State 定义）
│   │   ├── main.py                 # 主 Graph 入口，组装所有 subgraph
│   │   ├── router.py               # Router Node + conditional edges
│   │   ├── state.py                # 共享 ThreadState 定义
│   │   ├── resume/
│   │   │   ├── graph.py            # Resume Generation Subgraph
│   │   │   ├── nodes.py            # 各 Node 实现
│   │   │   └── state.py            # Resume subgraph 局部 state
│   │   ├── experience/
│   │   │   ├── graph.py
│   │   │   └── nodes.py
│   │   ├── jd/
│   │   │   ├── graph.py
│   │   │   └── nodes.py
│   │   ├── artifact/
│   │   │   ├── graph.py
│   │   │   ├── nodes.py
│   │   │   └── registry.py         # artifact type 注册表（type → default context_hints）
│   │   └── export/
│   │       ├── graph.py
│   │       └── nodes.py
│   │
│   ├── tools/                      # Tool 层（Tool Registry + 各工具实现）
│   │   ├── registry.py             # 统一注册表，graphs 层通过此处获取工具列表
│   │   ├── base.py                 # Tool 协议定义（name / description / schema / execute）
│   │   ├── experience/
│   │   │   ├── list.py
│   │   │   ├── get.py
│   │   │   ├── save.py
│   │   │   ├── update.py
│   │   │   ├── delete.py
│   │   │   ├── import_text.py
│   │   │   ├── import_file.py
│   │   │   ├── accept_candidate.py
│   │   │   ├── reject_candidate.py
│   │   │   └── match_jd.py
│   │   ├── jd/
│   │   │   ├── list.py
│   │   │   ├── get.py
│   │   │   └── save.py
│   │   ├── resume/
│   │   │   ├── list.py
│   │   │   ├── get.py
│   │   │   ├── generate.py
│   │   │   ├── revise_item.py
│   │   │   └── accept_variant.py
│   │   ├── artifact/
│   │   │   ├── create.py
│   │   │   └── get.py
│   │   └── evidence/
│   │       ├── show.py
│   │       └── check_claims.py
│   │
│   ├── domain/                     # 业务领域层（无框架依赖，纯业务逻辑）
│   │   ├── experience/
│   │   │   ├── models.py           # Pydantic domain models
│   │   │   ├── service.py          # 业务逻辑
│   │   │   └── repository.py       # Repository 接口（Protocol）
│   │   ├── jd/
│   │   │   ├── models.py
│   │   │   ├── service.py
│   │   │   └── repository.py
│   │   ├── resume/
│   │   │   ├── models.py
│   │   │   ├── service.py
│   │   │   └── repository.py
│   │   ├── artifact/
│   │   │   ├── models.py
│   │   │   ├── service.py
│   │   │   └── repository.py
│   │   ├── user/
│   │   │   ├── models.py           # User + UserProfile
│   │   │   ├── service.py
│   │   │   └── repository.py
│   │   └── preference/
│   │       ├── models.py           # PreferenceBank models
│   │       ├── service.py          # 自动提取 + 显式设置 + consolidation
│   │       └── repository.py
│   │
│   ├── rag/                        # RAG 服务（独立，可单独升级检索策略）
│   │   ├── base.py                 # Retriever 协议
│   │   ├── guideline/
│   │   │   ├── service.py          # Guideline RAG 检索
│   │   │   ├── ingestion.py        # Guideline 入库
│   │   │   └── repository.py
│   │   └── evidence/
│   │       ├── service.py          # Evidence RAG 检索
│   │       ├── claim_extractor.py  # 从经历提取 claims
│   │       ├── indexer.py          # Claim 图索引
│   │       └── repository.py
│   │
│   ├── memory/                     # 上下文管理
│   │   ├── thread_state.py         # ThreadState TypedDict 定义
│   │   ├── context_assembly.py     # Context Assembly 逻辑（按 intent 按需拉取）
│   │   └── rolling_summary.py      # 长对话滚动摘要
│   │
│   ├── providers/                  # LLM Provider 抽象
│   │   ├── base.py                 # Provider 协议
│   │   ├── openai_format.py        # OpenAI format（含 DeepSeek 等兼容厂商）
│   │   ├── anthropic_format.py     # Anthropic format
│   │   └── factory.py              # 根据配置返回 provider 实例
│   │
│   ├── infra/                      # 基础设施层（Repository 具体实现）
│   │   ├── db/
│   │   │   ├── connection.py       # asyncpg 连接池
│   │   │   ├── repositories/       # 各 domain repository 的 Postgres 实现
│   │   │   │   ├── experience.py
│   │   │   │   ├── jd.py
│   │   │   │   ├── resume.py
│   │   │   │   ├── artifact.py
│   │   │   │   ├── user.py
│   │   │   │   └── preference.py
│   │   │   └── checkpointer.py     # LangGraph PostgresSaver 初始化
│   │   └── files/
│   │       ├── storage.py          # 文件存储（本地 / S3 可切换）
│   │       └── parser.py           # 文件解析（PDF / Word / 图片 OCR）
│   │
│   └── core/                       # 共享基础（最底层，无业务依赖）
│       ├── config.py               # pydantic-settings 配置
│       ├── types.py                # 共享 ID 类型、枚举等
│       ├── errors.py               # 统一错误类型
│       └── events.py               # SSE 事件类型定义
│
├── tests/
│   ├── unit/                       # 单元测试（domain / tools / rag）
│   ├── integration/                # 集成测试（graphs / api）
│   └── conftest.py
│
├── alembic/                        # 数据库迁移
│   ├── versions/
│   └── env.py
│
├── pyproject.toml
├── CLAUDE.md
└── docs/
    └── new-agent-architecture-plan.md
```

### 16.3 关键设计约束

**graphs/ 层规则：**
- 只能 import `tools/`、`memory/`、`providers/`、`core/`
- 不直接访问数据库，不 import `infra/`
- 每个 subgraph 是独立的 `StateGraph`，通过 `main.py` 组装

**tools/ 层规则：**
- 每个工具是一个独立文件，实现 `Tool` 协议
- 只能 import `domain/` 的 service，不直接访问 repository 或 DB
- 工具通过 `registry.py` 统一注册，新增工具只需创建文件 + 注册，其他代码不变

**domain/ 层规则：**
- 零框架依赖（不 import FastAPI、LangGraph、asyncpg）
- Repository 只定义 `Protocol`（接口），具体实现在 `infra/`
- 通过依赖注入在运行时注入具体 repository 实现

**新增能力的标准步骤：**
1. 新增工具：在 `tools/<domain>/` 创建文件 → 在 `tools/registry.py` 注册 → 完成
2. 新增 artifact 类型：在 `graphs/artifact/registry.py` 添加一行注册 → 完成
3. 新增 subgraph：在 `graphs/` 创建目录 → 在 `graphs/router.py` 添加路由分支 → 完成
4. 新增 LLM provider：在 `providers/` 创建文件 → 在 `providers/factory.py` 注册 → 完成

---

## 十七、Python 依赖版本

```toml
[tool.poetry.dependencies]
python = "^3.12"

# API 层
fastapi = "^0.115.0"
uvicorn = {extras = ["standard"], version = "^0.30.0"}
python-multipart = "^0.0.12"      # 文件上传

# Agent 框架
langgraph = "^0.2.0"
langchain = "^0.3.0"
langchain-openai = "^0.2.0"       # OpenAI format（含 DeepSeek 等兼容厂商）
langchain-anthropic = "^0.3.0"    # Anthropic format

# 数据库
asyncpg = "^0.29.0"
sqlalchemy = {extras = ["asyncio"], version = "^2.0.0"}
alembic = "^1.13.0"
pgvector = "^0.3.0"               # 向量检索
langgraph-checkpoint-postgres = "^2.0.0"  # LangGraph PostgresSaver

# 数据校验与配置
pydantic = "^2.9.0"
pydantic-settings = "^2.5.0"

# 鉴权
python-jose = {extras = ["cryptography"], version = "^3.3.0"}
passlib = {extras = ["bcrypt"], version = "^1.7.4"}

# 文件解析
pypdf = "^4.3.0"                  # PDF 文本提取
python-docx = "^1.1.0"           # Word 文件解析

# 工具
httpx = "^0.27.0"                 # 异步 HTTP 客户端

[tool.poetry.group.dev.dependencies]
pytest = "^8.3.0"
pytest-asyncio = "^0.23.0"
pytest-cov = "^5.0.0"
ruff = "^0.6.0"                   # Lint + format
mypy = "^1.11.0"
```

---

## 十八、Router Node 详细设计

### 18.1 职责

一次结构化 LLM 调用，读取用户消息 + Thread State，输出路由决策。不循环、不调用工具、不需要 memory。

### 18.2 输出 Schema

```python
class RouterOutput(BaseModel):
    target_subgraph: Literal[
        "experience_import",   # 经历导入（文件/文本）
        "jd",                  # JD 保存/分析
        "resume_generation",   # 简历生成/改写
        "artifact",            # 自由文档生成（cover letter / 自我介绍等）
        "export",              # 导出操作
        "open_ended",          # 兜底：意图不明确 / 跨多个领域 / 自由工具调用
    ]
    intent_description: str        # 自然语言描述，传入下游 Node 驱动生成行为
    artifact_type: str | None      # 仅 target_subgraph == "artifact" 时有值
    context_hints: list[str]       # 下游 Context Assembly 的提示，如 ["active_jd", "experiences:backend"]
    extracted_params: dict         # 从用户消息中提取的结构化参数
    confidence: float              # 0~1，低于 0.6 强制路由到 open_ended
```

`extracted_params` 示例：
```json
{
  "target_role": "Backend Engineer",
  "jd_text": "...",           // 用户粘贴的 JD 文本
  "experience_ids": [],       // 用户明确提到的经历 ID
  "resume_id": "pres-xxx",
  "language": "zh-CN"
}
```

### 18.3 System Prompt 结构

```
你是简历助手的意图路由器。根据用户消息和当前会话状态，决定应该交给哪个子流程处理。

## 可用子流程

- experience_import：用户上传文件、粘贴经历文本、想导入/录入经历
- jd：用户粘贴职位描述、想保存 JD、想分析某个 JD
- resume_generation：用户想生成简历、改写简历条目、基于 JD 生成
- artifact：用户想生成文档类内容（cover letter、自我介绍、匹配分析、面试准备等）
- export：用户想导出/下载简历
- open_ended：用户意图不明确，或需要组合多个能力，或在问问题

## 当前会话状态
{thread_state_summary}

## 路由原则
- confidence < 0.6 时，一律路由到 open_ended，不强行猜测
- 用户同时提到 JD 和"生成简历"→ resume_generation，extracted_params 带上 jd_text
- 用户说"帮我写个自我介绍"→ artifact，artifact_type = "self_intro"
- intent_description 写用户真实意图的自然语言描述，供下游 Node 使用，不要只写 action 名

## 输出格式
严格输出 JSON，不要输出其他内容。
```

### 18.4 Thread State Summary 注入

Router 看到的会话状态是精简摘要，不是完整 state：

```python
def build_thread_state_summary(state: ThreadState) -> str:
    parts = []
    if state["active_jd_id"]:
        parts.append(f"当前激活 JD：{state['active_jd_title']}（{state['active_jd_id']}）")
    if state["active_resume_id"]:
        parts.append(f"当前激活简历：{state['active_resume_title']}（{state['active_resume_id']}）")
    if state["referenced_experience_ids"]:
        parts.append(f"本次会话已引用 {len(state['referenced_experience_ids'])} 条经历")
    if state["recent_artifact_ids"]:
        parts.append(f"最近生成的 artifact：{state['recent_artifact_ids'][-1]}")
    return "\n".join(parts) if parts else "（新会话，无激活资源）"
```

---

## 十九、Resume Generation Subgraph State Schema

### 19.1 完整 State 定义

```python
class ResumeGenerationState(TypedDict):
    # ── 输入（来自 ThreadState + Router 路由决策）──
    thread_id: str
    user_id: str
    intent_description: str          # Router 提取的意图描述
    context_hints: list[str]

    # ── JD 上下文 ──
    jd_id: str | None
    jd_text: str | None
    jd_requirements: list[Requirement] | None   # 结构化解析后的 requirements

    # ── Context Assembly 产出 ──
    relevant_experiences: list[ExperienceWithClaims]  # RAG 检索 + claim 提取
    guideline_instructions: list[str]                 # Guideline RAG 检索结果
    evidence_pack: EvidencePack | None                # requirement → evidence 映射
    user_preferences: list[Preference]                # PreferenceBank 查询结果
    user_profile: UserProfile | None

    # ── CoT Planning 产出 ──
    matching_plan: MatchingPlan | None       # 经历 × requirement 匹配方案
    generation_strategy: str | None          # 生成策略的自然语言描述

    # ── 生成产出 ──
    variants: list[ResumeVariant]            # 当前生成的 variants
    current_diff: list[DiffChunk] | None     # 与原简历的 diff（改写场景）

    # ── Self-Review 循环 ──
    review_iteration: int                    # 当前迭代轮次（上限 3）
    review_result: ReviewResult | None
    revision_instruction: str | None         # 给 Revision Node 的具体修改指令

    # ── SSE 事件队列 ──
    pending_sse_events: list[SSEEvent]       # 待推送的 SSE 事件

    # ── 最终输出 ──
    final_variants: list[ResumeVariant] | None
    interrupt_payload: InterruptPayload | None  # 触发 interrupt() 时的 payload
```

### 19.2 关键子类型

```python
class Requirement(BaseModel):
    id: str
    text: str
    category: Literal["technical_skill", "soft_skill", "domain_knowledge",
                       "experience_years", "education", "other"]
    importance: Literal["must_have", "nice_to_have"]

class ExperienceWithClaims(BaseModel):
    experience_id: str
    title: str
    content_snapshot: str
    claims: list[Claim]        # 从经历内容提取的可验证断言
    relevance_score: float     # 与当前 JD/intent 的相关度

class Claim(BaseModel):
    id: str
    text: str                  # 如："设计了支撑千万 QPS 的分布式系统"
    category: str              # skill / achievement / responsibility
    is_quantified: bool

class EvidencePack(BaseModel):
    # requirement_id → 支撑该 requirement 的 claim 列表
    requirement_evidence_map: dict[str, list[Claim]]
    coverage_score: float      # 已覆盖 requirement 数 / 总 requirement 数
    gaps: list[str]            # 没有 evidence 支撑的 requirements

class MatchingPlan(BaseModel):
    matches: list[RequirementMatch]
    gap_requirements: list[str]    # 无法匹配的 requirement
    strategy_notes: str            # CoT 推导出的生成策略说明

class RequirementMatch(BaseModel):
    requirement_id: str
    experience_ids: list[str]
    claim_ids: list[str]
    confidence: float

class ReviewResult(BaseModel):
    verdict: Literal["pass", "needs_revision"]
    issues: list[str]              # 具体问题描述
    revision_instruction: str | None  # 给 Revision Node 的指令

class ResumeVariant(BaseModel):
    id: str
    title: str
    content: str                   # markdown 格式
    score: VariantScore
    evidence_summary: EvidenceSummary
    risk_summary: RiskSummary

class VariantScore(BaseModel):
    overall: float
    relevance: float
    clarity: float
    evidence_strength: float
    quantified_impact: float

class InterruptPayload(BaseModel):
    type: Literal["resume_generation"]
    variants: list[ResumeVariant]
    diff: list[DiffChunk] | None   # 改写场景：与原 resume items 的 diff
    risk_level: Literal["low", "medium", "high"]
    summary: str
```

### 19.3 Node 流转与 State 变更

| Node | 读取 State 字段 | 写入 State 字段 |
|---|---|---|
| Context Assembly | `jd_id`, `intent_description`, `context_hints` | `jd_requirements`, `relevant_experiences`, `guideline_instructions`, `evidence_pack`, `user_preferences`, `user_profile` |
| CoT Planning | 全部 context 字段 | `matching_plan`, `generation_strategy` |
| Draft Generation | `matching_plan`, `generation_strategy`, `evidence_pack` | `variants`, `current_diff`, `pending_sse_events` |
| Self-Review | `variants`, `evidence_pack` | `review_result`, `review_iteration` |
| Revision | `variants`, `review_result` | `variants`（覆盖更新）, `revision_instruction` |
| Output | `variants`, `current_diff` | `final_variants`, `interrupt_payload` |

---

## 二十、Context Assembly Node RAG 融合策略

### 20.1 整体策略：并行检索 + Token 预算管理

Context Assembly 的核心矛盾：要喂给 LLM 的上下文越丰富越好，但 token 有限。解法是**并行检索 + 优先级截断**。

```
┌──────────────────────────────────────────┐
│           并行检索（全部同时发起）           │
│                                          │
│  JD 加载  │ 经历 RAG  │ Guideline RAG   │
│           │           │                 │
│  用户偏好  │ 用户 Profile│ 历史摘要        │
└──────────────────────────────────────────┘
                    │
                    ▼
         ┌──────────────────┐
         │  Evidence Pack   │  ← 基于 JD requirements × experience claims 构建
         │  构建（串行，依赖  │
         │  上面的结果）      │
         └──────────────────┘
                    │
                    ▼
         ┌──────────────────┐
         │  Token 预算分配   │
         │  + 优先级截断     │
         └──────────────────┘
                    │
                    ▼
         ┌──────────────────┐
         │  结构化 Prompt    │
         │  组装输出         │
         └──────────────────┘
```

### 20.2 检索策略

**经历 RAG（关键）：**
- 检索 query = JD 的 requirement 文本 + intent_description 拼接
- 返回 Top-K 经历（K 由 token 预算动态决定，默认 K=8）
- 对每条经历提取 claims（如果 claim 图已建立则直接查，否则实时提取）
- 按 relevance_score 排序，截断到预算

**Guideline RAG：**
- 检索 query = target_role + industry + intent_description
- 返回 Top-5 guideline 指令（每条控制在 1-2 句）
- 优先选与当前 JD 类型最匹配的 guideline

**PreferenceBank 查询：**
- 查询当前用户所有偏好，按 priority 降序
- 只取 category 与当前操作相关的偏好（resume 生成 → style/format/content/tone）

### 20.3 Evidence Pack 构建

```python
async def build_evidence_pack(
    jd_requirements: list[Requirement],
    experiences_with_claims: list[ExperienceWithClaims],
) -> EvidencePack:
    mapping = {}
    for req in jd_requirements:
        matched_claims = []
        for exp in experiences_with_claims:
            for claim in exp.claims:
                score = semantic_similarity(req.text, claim.text)
                if score > EVIDENCE_THRESHOLD:  # 0.65
                    matched_claims.append((claim, score))
        matched_claims.sort(key=lambda x: x[1], reverse=True)
        mapping[req.id] = [c for c, _ in matched_claims[:3]]  # 每个 requirement 最多 3 条 evidence

    covered = sum(1 for v in mapping.values() if v)
    coverage_score = covered / len(jd_requirements) if jd_requirements else 0.0
    gaps = [req.id for req, claims in mapping.items() if not claims]

    return EvidencePack(
        requirement_evidence_map=mapping,
        coverage_score=coverage_score,
        gaps=gaps,
    )
```

### 20.4 Token 预算分配

总预算按模型 context window 动态计算，预留 output token 后分配：

| 内容块 | 优先级 | Token 上限 |
|---|---|---|
| User Profile | 最高（必含） | ~200 |
| JD 原文（截断版） | 高（必含） | ~800 |
| JD 结构化 Requirements | 高（必含） | ~400 |
| 用户偏好 | 高 | ~300 |
| Guideline Instructions | 中 | ~500 |
| Evidence Pack 映射 | 中 | ~800 |
| 经历详情 + claims | 低（按相关度截断） | 剩余预算 |
| 对话历史摘要 | 低 | ~400 |

### 20.5 结构化 Prompt 组装

不是把所有内容平铺，而是组装成让 LLM **显式推理**的结构：

```
## 用户信息
姓名：{name}，职业阶段：{career_stage}，目标岗位：{target_roles}

## 职位要求
**必须具备：**
- [M1] 5年以上 Go/Python 后端开发经验
- [M2] 分布式系统设计能力
**加分项：**
- [N1] Kubernetes 使用经验

## 可用经历与支撑证据
**经历 A**（相关度 0.92）：字节跳动后端工程师
  - 证据 → [M2]：设计并实现支撑千万 QPS 的分布式调度系统
  - 证据 → [M1]：使用 Go 开发核心服务，5年经验
**经历 B**（相关度 0.71）：...

## 覆盖缺口
- [N1] Kubernetes：无直接证据，需谨慎描述或略去

## 写作规范
- 用强动词开头，量化成果
- 避免空洞形容词

## 用户偏好
- 风格简洁，不要冗长铺垫
- 系统规模数据必须体现

## 生成指令
{intent_description}
```

这种结构让 LLM 在生成时直接对照 requirement 找 evidence，而不是自由发挥。

---

## 二十一、PreferenceBank 反馈信号回写机制

### 21.1 三类信号来源

```python
class PreferenceSignal(BaseModel):
    id: str
    user_id: str
    signal_type: Literal["explicit", "rejection", "edit_diff"]
    raw_content: str          # 原始内容（对话片段 / 拒绝原因 / diff 文本）
    generation_context: dict  # 信号发生时的生成上下文（artifact_type, target_role 等）
    created_at: datetime
```

**信号 1：对话显式表达（每轮对话后提取）**

用于检测的 pattern：
- "我（不）喜欢..."、"（不）要..."、"风格偏向..."、"每次都..."
- 检测到后，用小模型调用（Haiku/Flash 级别）提取结构化偏好

**信号 2：用户拒绝 interrupt**

```python
async def handle_interrupt_rejection(
    user_id: str,
    interrupt_payload: InterruptPayload,
    rejection_reason: str | None,
):
    signal = PreferenceSignal(
        signal_type="rejection",
        raw_content=rejection_reason or "用户未给出原因",
        generation_context={
            "artifact_type": interrupt_payload.type,
            "variant_summary": interrupt_payload.variants[0].title,
        },
    )
    await extract_and_save_preference(user_id, signal)
```

**信号 3：用户手动编辑生成内容（diff 分析）**

```python
async def handle_content_edit(
    user_id: str,
    before: str,
    after: str,
    context: dict,
):
    diff = compute_diff(before, after)
    if is_trivial_edit(diff):   # 只改了标点/空格，忽略
        return
    signal = PreferenceSignal(
        signal_type="edit_diff",
        raw_content=format_diff_for_llm(diff),
        generation_context=context,
    )
    await extract_and_save_preference(user_id, signal)
```

### 21.2 偏好提取（LLM 结构化输出）

```python
class ExtractedPreference(BaseModel):
    rule: str                  # 自然语言规则，如"简历 bullet 控制在 15 字以内"
    category: Literal["style", "format", "content", "tone", "length", "language"]
    confidence: float          # 0~1
    scope: str | None          # 适用范围，如"cover_letter" / 全局 None

# System prompt 要求模型从 signal 中提取 1-3 条可操作规则
# 例：diff 显示用户把"负责开发了..."改成"主导设计了..."
# 提取：{"rule": "用'主导'/'设计'等强动词替代'负责'/'参与'", "category": "style"}
```

### 21.3 偏好存储与优先级

```python
class Preference(BaseModel):
    id: str
    user_id: str
    rule: str
    category: str
    source: Literal["explicit", "rejection_signal", "edit_pattern"]
    priority: int              # explicit=100, rejection=70, edit_pattern=50
    confidence: float
    reinforcement_count: int   # 被重复信号强化的次数
    scope: str | None
    created_at: datetime
    last_reinforced_at: datetime | None
```

相似偏好判断：用 embedding 相似度（> 0.85）视为同一条，更新 `reinforcement_count` 和 `confidence`，不重复写入。

### 21.4 Consolidation（定期整合）

每积累 5 条新信号触发一次，或用户显式请求：

```
1. 加载该用户所有偏好
2. 用 LLM 检测矛盾对（如"风格简洁"vs"内容详尽"）
3. 矛盾时：priority 高的保留，低的软删除（标记 deprecated）
4. 合并语义相近的偏好（embedding 相似度 > 0.9）
5. 清理 confidence < 0.3 且 reinforcement_count == 1 的弱信号
```

### 21.5 生成时注入

```python
async def get_active_preferences(
    user_id: str,
    category_filter: list[str] | None = None,
    scope: str | None = None,
) -> list[Preference]:
    prefs = await preference_repo.query(user_id)
    # 显式设置（priority=100）永远优先
    # 按 priority DESC, reinforcement_count DESC 排序
    # 按 category_filter 和 scope 过滤
    return sorted(prefs, key=lambda p: (p.priority, p.reinforcement_count), reverse=True)[:10]
```

---

## 二十二、下一步规划

- [ ] 初始化项目骨架（目录结构、pyproject.toml、alembic 配置）
- [ ] 实现 core 层（config、types、errors、events）
- [ ] 实现 domain 层（models + service + repository protocol）
- [ ] 实现 infra 层（asyncpg 连接池 + repository 实现 + 数据库迁移）
- [ ] 实现 providers 层（OpenAI format + Anthropic format）
- [ ] 实现 Router Node + 主 Graph 骨架
- [ ] 实现第一条完整链路（JD 保存 → 经历匹配）

---

*最后更新：2026-07-04（新增：Router Node、Resume Subgraph State、Context Assembly RAG 融合、PreferenceBank 反馈回写详细设计）*
