# API Contract — 前后端接口文档

> 版本：v1.0 草稿
> 最后更新：2026-07-04

---

## 目录

1. [概述](#一概述)
2. [通用约定](#二通用约定)
3. [SSE 流式事件](#三sse-流式事件)
4. [Copilot 主接口](#四copilot-主接口)
5. [Thread 管理](#五thread-管理)
6. [经历库](#六经历库)
7. [JD 库](#七jd-库)
8. [简历库](#八简历库)
9. [Artifact 库](#九artifact-库)
10. [文件上传与解析](#十文件上传与解析)
11. [用户与偏好](#十一用户与偏好)
12. [侧边栏与仪表盘](#十二侧边栏与仪表盘)
13. [健康检查](#十三健康检查)

---

## 一、概述

### Base URL

```
https://api.yourdomain.com/v1
```

本地开发：
```
http://localhost:8000/v1
```

### 协议约定

- 所有接口使用 HTTPS
- 请求和响应均为 `application/json`，除文件上传（`multipart/form-data`）和 SSE 流式接口
- 所有时间字段均为 ISO 8601 格式（`2026-07-04T12:00:00Z`）
- 字段命名使用 `camelCase`

---

## 二、通用约定

### 2.1 请求头

所有需要鉴权的接口均需携带以下之一：

```http
Cookie: session=<session_token>
```
或
```http
Authorization: Bearer <access_token>
```

通用可选请求头：

```http
X-Request-Id: <client_generated_uuid>     # 客户端自定义请求 ID，便于追踪
X-Idempotency-Key: <uuid>                 # 幂等键，写操作建议携带（重试安全）
```

### 2.2 成功响应 Envelope

```json
{
  "ok": true,
  "data": { },
  "meta": {
    "requestId": "req-550e8400-e29b",
    "traceId": "trace-abc123"
  }
}
```

### 2.3 错误响应 Envelope

```json
{
  "ok": false,
  "error": {
    "code": "EXPERIENCE_NOT_FOUND",
    "message": "Experience pexp-xxx not found",
    "details": null,
    "retryable": false
  },
  "meta": {
    "requestId": "req-550e8400-e29b",
    "traceId": "trace-abc123"
  }
}
```

前端处理建议：先判断 `ok`，`ok=false` 时用 `error.code` 做分支处理，`error.message` 用于 debug/toast，不直接展示给用户。

### 2.4 错误码清单

| code | HTTP 状态 | 含义 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 未登录或 token 过期 |
| `FORBIDDEN` | 403 | 无权访问该资源 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `VALIDATION_ERROR` | 422 | 请求参数校验失败，`details` 含字段级错误 |
| `CONFLICT` | 409 | 幂等键冲突，或资源状态冲突 |
| `RATE_LIMITED` | 429 | 请求过于频繁 |
| `EXPERIENCE_NOT_FOUND` | 404 | 经历不存在 |
| `JD_NOT_FOUND` | 404 | JD 不存在 |
| `RESUME_NOT_FOUND` | 404 | 简历不存在 |
| `ARTIFACT_NOT_FOUND` | 404 | Artifact 不存在 |
| `THREAD_NOT_FOUND` | 404 | 会话不存在 |
| `INTERRUPT_EXPIRED` | 410 | interrupt 已过期或已处理 |
| `FILE_TOO_LARGE` | 413 | 文件超过大小限制（20MB）|
| `FILE_TYPE_NOT_SUPPORTED` | 415 | 不支持的文件类型 |
| `SCOPE_VIOLATION` | 403 | 操作的资源不属于当前用户 |
| `INTERNAL_ERROR` | 500 | 服务器内部错误，`retryable: true` |

### 2.5 ID 前缀规则

| 资源 | 前缀 | 示例 |
|---|---|---|
| Thread（会话） | `thread-` | `thread-uuid` |
| Turn（对话轮次） | `turn-` | `turn-uuid` |
| Experience | `pexp-` | `pexp-uuid` |
| Experience Revision | `pexprev-` | `pexprev-uuid` |
| Import Job | `pimp-` | `pimp-uuid` |
| Import Candidate | `pimpcand-` | `pimpcand-uuid` |
| JD | `pjd-` | `pjd-uuid` |
| Resume | `pres-` | `pres-uuid` |
| Resume Item | `presitem-` | `presitem-uuid` |
| Resume Variant | `pvar-` | `pvar-uuid` |
| Artifact | `art-` | `art-uuid` |
| File | `file-` | `file-uuid` |
| User | `user-` | `user-uuid` |

**前端注意：永远使用后端返回的 ID，不要自行生成业务 ID。**

### 2.6 分页

列表接口统一使用 cursor-based 分页：

请求：
```
GET /product/experiences?limit=20&cursor=pexp-xxx
```

响应 `data`：
```json
{
  "items": [...],
  "nextCursor": "pexp-yyy",   // null 表示已到最后一页
  "hasMore": true
}
```

### 2.7 ClientState

Copilot 相关接口的请求中可携带 `clientState`，用于告知后端前端当前的激活资源：

```typescript
interface ClientState {
  locale?: string                    // "zh-CN" | "en-US"
  activeJdId?: string
  activeResumeId?: string
  activeExperienceId?: string
  activeArtifactId?: string
  activeResumeItemId?: string
  selectedText?: string              // 用户选中的文本片段
  intentSource?: "composer" | "sidebar" | "artifact_action" | "asset_detail"
}
```

后端用 `clientState` 做 scope 校验和上下文注入，前端应保持同步。

---

## 三、SSE 流式事件

### 3.1 连接方式

```http
POST /v1/copilot/chat/stream
Content-Type: application/json
Accept: text/event-stream
```

响应：
```http
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no
```

### 3.2 事件格式

每个事件为：
```
event: <event_type>
data: <json_string>

```

注意：事件间以两个换行符分隔。

### 3.3 完整事件类型清单

#### 阶段类事件（仅用于 UI 进度展示）

**`agent.turn.started`**
```json
{
  "type": "agent.turn.started",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx"
}
```

**`agent.thinking`**
```json
{
  "type": "agent.thinking",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "label": "正在分析意图..."
}
```

**`agent.route.completed`**
```json
{
  "type": "agent.route.completed",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "targetSubgraph": "resume_generation",
  "intentDescription": "基于字节跳动 JD 生成简历，突出分布式系统经验"
}
```

**`agent.node.started`**
```json
{
  "type": "agent.node.started",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "nodeName": "context_assembly",
  "label": "正在检索相关经历..."
}
```

**`agent.node.completed`**
```json
{
  "type": "agent.node.completed",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "nodeName": "context_assembly"
}
```

**`agent.tool.started`**（open_ended 子图内工具调用）
```json
{
  "type": "agent.tool.started",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "toolName": "search_experiences",
  "label": "搜索经历库..."
}
```

**`agent.tool.completed`**
```json
{
  "type": "agent.tool.completed",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "toolName": "search_experiences",
  "status": "success"
}
```

**`agent.tool.failed`**
```json
{
  "type": "agent.tool.failed",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "toolName": "search_experiences",
  "error": "经历库为空"
}
```

---

#### 内容流式事件

**`content.diff.started`**（改写已有内容时，发送原始内容）
```json
{
  "type": "content.diff.started",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "targetId": "presitem-xxx",
  "targetType": "resume_item",
  "before": "负责后台服务开发，提升系统稳定性"
}
```

**`content.diff.delta`**（逐 token 推送新内容）
```json
{
  "type": "content.diff.delta",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "targetId": "presitem-xxx",
  "token": "主导"
}
```

**`content.diff.completed`**（生成完成，包含完整新内容和 diff）
```json
{
  "type": "content.diff.completed",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "targetId": "presitem-xxx",
  "after": "主导设计高并发分布式系统，支撑峰值 1000 万 QPS，系统可用性达 99.99%",
  "diff": [
    { "type": "delete", "value": "负责后台服务开发，提升系统" },
    { "type": "insert", "value": "主导设计高并发分布式系统，支撑峰值 1000 万 QPS，系统" },
    { "type": "equal",  "value": "稳定性" },
    { "type": "insert", "value": "达 99.99%" }
  ]
}
```

`diff` 数组中每个 chunk 的 `type`：`"equal"` | `"insert"` | `"delete"`

---

**`artifact.started`**（文档类内容生成开始）
```json
{
  "type": "artifact.started",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "artifactId": "art-xxx",
  "artifactType": "cover_letter",
  "title": "给字节跳动的 Cover Letter"
}
```

**`artifact.delta`**（逐 token 推送）
```json
{
  "type": "artifact.delta",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "artifactId": "art-xxx",
  "token": "尊敬的"
}
```

**`artifact.completed`**
```json
{
  "type": "artifact.completed",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "artifactId": "art-xxx",
  "content": "# Cover Letter\n\n尊敬的招聘团队..."
}
```

---

#### 消息流事件

**`agent.message.delta`**（助手对话消息逐 token）
```json
{
  "type": "agent.message.delta",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "token": "好的，我"
}
```

**`agent.message.completed`**
```json
{
  "type": "agent.message.completed",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "content": "好的，我已基于字节跳动的 JD 为你生成了 2 个简历版本，请查看右侧画布。"
}
```

---

#### 中断确认事件

**`agent.interrupt`**（需要用户确认，前端展示确认卡并冻结画布）
```json
{
  "type": "agent.interrupt",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "interrupt": {
    "type": "resume_generation",
    "riskLevel": "medium",
    "summary": "即将生成 2 个简历版本并存入简历库，是否确认？",
    "preview": {
      "variants": [
        {
          "id": "pvar-xxx",
          "title": "精简版（推荐）",
          "content": "...",
          "score": { "overall": 0.88, "relevance": 0.91 }
        }
      ],
      "diff": null
    }
  }
}
```

用户确认：`POST /v1/threads/{threadId}/resume`
用户拒绝：`POST /v1/threads/{threadId}/discard`

---

#### 终止事件

**`agent.completed`**（完整响应，前端用此刷新整个 workspace）
```json
{
  "type": "agent.completed",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "response": { /* 完整 CopilotChatResponse，见第四节 */ }
}
```

**`agent.failed`**
```json
{
  "type": "agent.failed",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "LLM 调用超时",
    "retryable": true
  }
}
```

### 3.4 前端处理建议

```typescript
const es = new EventSource('/v1/copilot/chat/stream', { ... })

es.addEventListener('agent.thinking', (e) => {
  const data = JSON.parse(e.data)
  showProgressLabel(data.label)
})

es.addEventListener('content.diff.started', (e) => {
  const { targetId, before } = JSON.parse(e.data)
  canvas.initDiff(targetId, before)
})

es.addEventListener('content.diff.delta', (e) => {
  const { targetId, token } = JSON.parse(e.data)
  canvas.appendToken(targetId, token)
})

es.addEventListener('content.diff.completed', (e) => {
  const { targetId, after, diff } = JSON.parse(e.data)
  canvas.renderDiff(targetId, diff)
})

es.addEventListener('agent.interrupt', (e) => {
  const { interrupt } = JSON.parse(e.data)
  canvas.freeze()
  showConfirmCard(interrupt)
})

es.addEventListener('agent.completed', (e) => {
  const { response } = JSON.parse(e.data)
  workspace.update(response.workspace)
  es.close()
})

es.addEventListener('agent.failed', (e) => {
  const { error } = JSON.parse(e.data)
  showError(error)
  es.close()
})
```

---

## 四、Copilot 主接口

### 4.1 CopilotChatResponse 结构

所有 Copilot 接口（非流式响应、SSE `agent.completed`、interrupt resume 响应）均返回此结构：

```typescript
interface CopilotChatResponse {
  threadId: string
  turnId: string
  assistantMessage: {
    id: string
    role: "assistant"
    content: string           // 对话文字，供聊天气泡展示
    createdAt: string
  }
  workspace: Workspace
  nextActions: ProductAction[]
  suggestedPrompts?: string[] // 建议的后续提问
  interrupt?: InterruptInfo   // 非 null 时表示流程被中断，等待用户确认
}

interface Workspace {
  activePanel: "variants" | "experience_library" | "resume_editor"
              | "jd_library" | "import_candidates" | "artifact_viewer" | null
  active: {
    jdId?: string
    resumeId?: string
    experienceId?: string
    artifactId?: string
    variantId?: string
    resumeItemId?: string
  }
  // 各面板数据（仅当 activePanel 对应时有值）
  variants?: ResumeVariant[]
  activeResume?: ResumeDetail
  experiences?: ExperienceSummary[]
  importCandidates?: ImportCandidate[]
  artifact?: Artifact
}

interface InterruptInfo {
  threadId: string
  type: string
  riskLevel: "low" | "medium" | "high"
  summary: string
  preview: Record<string, unknown>   // 根据 type 不同内容不同
}

interface ProductAction {
  type: string
  label: string
  payload?: Record<string, unknown>
}
```

---

### 4.2 发送消息（非流式）

```http
POST /v1/copilot/chat
```

**Request：**
```json
{
  "threadId": "thread-xxx",        // 可选，不传则创建新会话
  "message": "帮我基于字节跳动这个 JD 生成一份简历",
  "clientState": {
    "locale": "zh-CN",
    "activeJdId": "pjd-xxx",
    "activeResumeId": "pres-xxx"
  }
}
```

**Response：** `ApiSuccess<CopilotChatResponse>`

---

### 4.3 发送消息（SSE 流式）

```http
POST /v1/copilot/chat/stream
Content-Type: application/json
Accept: text/event-stream
```

**Request Body：** 同 4.2

**Response：** SSE 事件流（见第三节）

流结束时的 `agent.completed` 事件包含完整 `CopilotChatResponse`。

---

### 4.4 显式产品动作

适合按钮点击触发的确定性动作，不走自然语言理解。

```http
POST /v1/copilot/actions
```

**Request：**
```json
{
  "threadId": "thread-xxx",
  "action": {
    "type": "optimize_resume_item",
    "payload": {
      "resumeItemId": "presitem-xxx",
      "instruction": "更简洁，保留关键指标"
    }
  },
  "clientState": {
    "activeResumeId": "pres-xxx",
    "activeResumeItemId": "presitem-xxx"
  }
}
```

支持的 `action.type`：

| type | payload 字段 | 说明 |
|---|---|---|
| `optimize_resume_item` | `resumeItemId`, `instruction?` | 改写单条 resume item |
| `rewrite_experience` | `experienceId`, `instruction` | 改写经历 |
| `generate_resume_from_jd` | `jdId?`, `resumeId?` | 基于 JD 生成简历 |
| `accept_variant` | `variantId`, `resumeId?` | 接受并保存 variant |
| `show_evidence` | `variantId` | 查看 variant 证据 |
| `generate_artifact` | `artifactType`, `instruction?` | 生成文档类 artifact |
| `export_resume` | `resumeId` | 触发导出（前端 print-to-PDF）|

**Response：** `ApiSuccess<CopilotChatResponse>`

---

### 4.5 获取会话侧边栏

```http
GET /v1/copilot/sidebar
```

**Response：**
```json
{
  "ok": true,
  "data": {
    "recentThreads": [
      {
        "id": "thread-xxx",
        "title": "字节跳动后端求职",
        "updatedAt": "2026-07-04T10:00:00Z",
        "targetRole": "Backend Engineer"
      }
    ],
    "recentExperiences": [ /* ExperienceSummary[] */ ],
    "recentJds": [ /* JdSummary[] */ ],
    "recentResumes": [ /* ResumeSummary[] */ ],
    "recentArtifacts": [ /* ArtifactSummary[] */ ]
  }
}
```

---

## 五、Thread 管理

### 5.1 获取会话列表

```http
GET /v1/threads?limit=20&cursor=thread-xxx
```

**Response `data`：**
```json
{
  "items": [
    {
      "id": "thread-xxx",
      "title": "字节跳动后端求职",
      "status": "active",
      "targetRole": "Backend Engineer",
      "createdAt": "2026-07-04T09:00:00Z",
      "updatedAt": "2026-07-04T10:30:00Z"
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

---

### 5.2 获取会话详情（含历史消息）

```http
GET /v1/threads/:threadId
```

**Response `data`：**
```json
{
  "thread": {
    "id": "thread-xxx",
    "title": "字节跳动后端求职",
    "status": "active",
    "targetRole": "Backend Engineer",
    "createdAt": "2026-07-04T09:00:00Z",
    "updatedAt": "2026-07-04T10:30:00Z"
  },
  "messages": [
    {
      "id": "msg-xxx",
      "role": "user",
      "content": "帮我生成简历",
      "createdAt": "2026-07-04T09:01:00Z"
    },
    {
      "id": "msg-yyy",
      "role": "assistant",
      "content": "好的，我已生成了 2 个版本...",
      "createdAt": "2026-07-04T09:01:10Z"
    }
  ],
  "workspace": { /* Workspace，恢复上次的激活面板和资源 */ }
}
```

前端重新打开历史会话时，用 `workspace` 恢复右侧面板状态，无需用户重新选择资源。

---

### 5.3 更新会话

```http
PATCH /v1/threads/:threadId
```

**Request：**
```json
{
  "title": "字节跳动后端 2026",
  "status": "archived"
}
```

`status` 可为：`"active"` | `"archived"` | `"deleted"`

**Response `data`：** 更新后的 Thread 对象

---

### 5.4 确认 interrupt（用户同意执行）

```http
POST /v1/threads/:threadId/resume
```

**Request：**
```json
{
  "turnId": "turn-xxx"    // 对应的 turn ID，防止重复确认
}
```

**Response `data`：** 完整 `CopilotChatResponse`

前端收到响应后用 `workspace` 刷新整个右侧面板。

---

### 5.5 拒绝 interrupt（用户取消）

```http
POST /v1/threads/:threadId/discard
```

**Request：**
```json
{
  "turnId": "turn-xxx",
  "reason": "版本风格不对，我想要更简洁的"   // 可选，用于 PreferenceBank 学习
}
```

**Response `data`：**
```json
{
  "discarded": true
}
```

前端将画布恢复到 `before` 状态（`content.diff.started` 里的值）。

---

## 六、经历库

### 经历核心类型

```typescript
interface Experience {
  id: string                // "pexp-xxx"
  userId: string
  category: "work" | "project" | "education" | "award" | "skill" | "other"
  title: string
  organization?: string
  role?: string
  startDate?: string        // "YYYY-MM"
  endDate?: string          // "YYYY-MM" 或 "present"
  tags: string[]
  status: "active" | "archived"
  currentRevisionId?: string
  createdAt: string
  updatedAt: string
}

interface ExperienceRevision {
  id: string                // "pexprev-xxx"
  experienceId: string
  content: string           // 经历正文（markdown）
  source: "manual" | "import" | "copilot"
  createdAt: string
}
```

---

### 6.1 获取经历列表

```http
GET /v1/product/experiences?limit=20&cursor=pexp-xxx&category=work&tags=backend
```

查询参数：
- `category`：筛选分类
- `tags`：逗号分隔的标签筛选
- `q`：关键词搜索（语义搜索）

**Response `data`：**
```json
{
  "items": [
    {
      "id": "pexp-xxx",
      "category": "work",
      "title": "字节跳动 — 后端工程师",
      "organization": "字节跳动",
      "role": "后端工程师",
      "startDate": "2022-03",
      "endDate": "present",
      "tags": ["golang", "distributed-systems"],
      "status": "active",
      "currentRevisionId": "pexprev-xxx",
      "contentSnippet": "负责核心推荐系统后端...",  // 前 100 字
      "updatedAt": "2026-07-01T00:00:00Z"
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

---

### 6.2 获取经历详情

```http
GET /v1/product/experiences/:experienceId
```

**Response `data`：**
```json
{
  "experience": { /* Experience 完整对象 */ },
  "currentRevision": {
    "id": "pexprev-xxx",
    "content": "完整正文 markdown...",
    "source": "copilot",
    "createdAt": "2026-07-01T00:00:00Z"
  },
  "revisions": [ /* 所有历史版本，按时间倒序 */ ]
}
```

---

### 6.3 创建经历

```http
POST /v1/product/experiences
X-Idempotency-Key: <uuid>
```

**Request：**
```json
{
  "title": "字节跳动 — 后端工程师",
  "content": "负责推荐系统后端开发...",
  "category": "work",
  "organization": "字节跳动",
  "role": "后端工程师",
  "startDate": "2022-03",
  "endDate": "present",
  "tags": ["golang", "distributed-systems"]
}
```

**Response `data`：**
```json
{
  "experience": { /* Experience */ },
  "revision": { /* ExperienceRevision */ }
}
```

---

### 6.4 更新经历元数据

更新标题、组织、日期等结构化字段，不更新正文内容。

```http
PATCH /v1/product/experiences/:experienceId
```

**Request（字段均可选）：**
```json
{
  "title": "新标题",
  "organization": "新公司",
  "role": "高级工程师",
  "startDate": "2022-03",
  "endDate": "2025-06",
  "tags": ["golang", "microservices"],
  "status": "archived"
}
```

**Response `data`：** 更新后的 `Experience` 对象

---

### 6.5 新增经历版本（正文更新）

每次修改正文都创建新 revision，不覆盖历史。

```http
POST /v1/product/experiences/:experienceId/revisions
X-Idempotency-Key: <uuid>
```

**Request：**
```json
{
  "content": "更新后的经历正文...",
  "source": "manual"
}
```

**Response `data`：** 新创建的 `ExperienceRevision`

---

### 6.6 删除经历（归档）

```http
DELETE /v1/product/experiences/:experienceId
```

软删除（status 改为 archived），不物理删除。

**Response `data`：** `{ "archived": true }`

---

### 6.7 从文本导入经历

上传一段文本（简历正文、自我介绍等），后端同步解析并返回候选经历列表。

```http
POST /v1/product/import/text
X-Idempotency-Key: <uuid>
```

**Request：**
```json
{
  "text": "2022年3月至今，在字节跳动担任后端工程师，负责推荐系统...\n2019年7月—2022年2月，在某公司担任..."
}
```

**Response `data`：**
```json
{
  "importJobId": "pimp-xxx",
  "candidates": [
    {
      "id": "pimpcand-xxx",
      "title": "字节跳动 — 后端工程师",
      "category": "work",
      "organization": "字节跳动",
      "role": "后端工程师",
      "startDate": "2022-03",
      "endDate": "present",
      "content": "负责推荐系统后端开发...",
      "status": "pending"
    }
  ]
}
```

---

### 6.8 从文件导入经历

先上传文件（见第十节），再用 fileId 触发解析。

```http
POST /v1/product/import/file
X-Idempotency-Key: <uuid>
```

**Request：**
```json
{
  "fileId": "file-xxx"
}
```

**Response `data`：**
```json
{
  "importJobId": "pimp-xxx",
  "candidates": [ /* ImportCandidate[] */ ]
}
```

---

### 6.9 接受导入候选

```http
POST /v1/product/import-candidates/:candidateId/accept
```

**Response `data`：**
```json
{
  "experience": { /* 新建的 Experience */ },
  "revision": { /* 首个 ExperienceRevision */ }
}
```

---

### 6.10 拒绝导入候选

```http
POST /v1/product/import-candidates/:candidateId/reject
```

**Response `data`：** `{ "rejected": true }`

---

## 七、JD 库

### JD 核心类型

```typescript
interface JdRecord {
  id: string             // "pjd-xxx"
  userId: string
  title: string
  company?: string
  targetRole?: string
  rawText: string        // JD 原文
  requirements?: JdRequirement[]   // 解析后的结构化 requirements（异步）
  createdAt: string
  updatedAt: string
}

interface JdRequirement {
  id: string
  text: string
  category: "technical_skill" | "soft_skill" | "domain_knowledge"
           | "experience_years" | "education" | "other"
  importance: "must_have" | "nice_to_have"
}
```

---

### 7.1 获取 JD 列表

```http
GET /v1/product/jds?limit=20&cursor=pjd-xxx
```

**Response `data`：**
```json
{
  "items": [
    {
      "id": "pjd-xxx",
      "title": "字节跳动 — 后端工程师",
      "company": "字节跳动",
      "targetRole": "Backend Engineer",
      "createdAt": "2026-07-03T00:00:00Z",
      "updatedAt": "2026-07-03T00:00:00Z"
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

---

### 7.2 保存 JD

后端保存后自动触发结构化 requirements 解析（同步完成后在 `requirements` 字段返回）。

```http
POST /v1/product/jds
X-Idempotency-Key: <uuid>
```

**Request：**
```json
{
  "rawText": "职位名称：后端工程师\n职位要求：\n1. 5年以上 Go/Python 开发经验...",
  "title": "字节跳动 — 后端工程师",
  "company": "字节跳动",
  "targetRole": "Backend Engineer"
}
```

**Response `data`：** 完整 `JdRecord`（含 `requirements`）

---

### 7.3 获取 JD 详情

```http
GET /v1/product/jds/:jdId
```

**Response `data`：** 完整 `JdRecord`

---

### 7.4 删除 JD

```http
DELETE /v1/product/jds/:jdId
```

**Response `data`：** `{ "deleted": true }`

---

## 八、简历库

### 简历核心类型

```typescript
interface Resume {
  id: string             // "pres-xxx"
  userId: string
  title: string
  targetRole?: string
  jdId?: string          // 关联的 JD
  status: "draft" | "ready" | "archived"
  createdAt: string
  updatedAt: string
}

interface ResumeItem {
  id: string             // "presitem-xxx"
  resumeId: string
  sectionType: "summary" | "experience" | "project" | "education"
              | "skill" | "award" | "other"
  title: string
  contentSnapshot: string   // 当前内容（markdown）
  orderIndex: number
  hidden: boolean
  pinned: boolean
  sourceExperienceId?: string
  sourceVariantId?: string
  createdAt: string
  updatedAt: string
}

interface ResumeDetail extends Resume {
  items: ResumeItem[]
}
```

---

### 8.1 获取简历列表

```http
GET /v1/product/resumes?limit=20&cursor=pres-xxx
```

---

### 8.2 创建空简历

```http
POST /v1/product/resumes
```

**Request：**
```json
{
  "title": "字节跳动投递版",
  "targetRole": "Backend Engineer",
  "jdId": "pjd-xxx"
}
```

**Response `data`：** `Resume` 对象

---

### 8.3 获取简历详情（含所有 items）

```http
GET /v1/product/resumes/:resumeId
```

**Response `data`：** `ResumeDetail`（items 按 `orderIndex` 排序）

---

### 8.4 更新简历基础信息

```http
PATCH /v1/product/resumes/:resumeId
```

**Request：**
```json
{
  "title": "新标题",
  "status": "ready"
}
```

---

### 8.5 新增 Resume Item

```http
POST /v1/product/resumes/:resumeId/items
X-Idempotency-Key: <uuid>
```

**Request：**
```json
{
  "sectionType": "experience",
  "title": "字节跳动 — 后端工程师",
  "contentSnapshot": "主导设计分布式系统...",
  "sourceExperienceId": "pexp-xxx",
  "sourceVariantId": "pvar-xxx"
}
```

**Response `data`：** `ResumeItem`

---

### 8.6 更新 Resume Item

```http
PATCH /v1/product/resume-items/:itemId
X-Idempotency-Key: <uuid>
```

**Request（字段均可选）：**
```json
{
  "contentSnapshot": "更新后的内容...",
  "title": "新标题",
  "hidden": false,
  "pinned": true
}
```

**Response `data`：** 更新后的 `ResumeItem`

---

### 8.7 删除 Resume Item

```http
DELETE /v1/product/resume-items/:itemId
```

**Response `data`：** `{ "deleted": true }`

---

### 8.8 重新排序 Resume Items

```http
POST /v1/product/resumes/:resumeId/reorder
```

**Request：**
```json
{
  "orderedIds": ["presitem-aaa", "presitem-bbb", "presitem-ccc"]
}
```

**Response `data`：** 更新后的 `ResumeItem[]`（按新顺序）

---

### 8.9 Variant 数据结构（生成简历时返回）

Variant 由 Copilot 接口返回（在 `workspace.variants` 中），不通过 REST 接口单独创建。

```typescript
interface ResumeVariant {
  id: string             // "pvar-xxx"
  title: string          // 如"精简版（推荐）"
  content: string        // markdown 格式的简历内容
  score: {
    overall: number      // 0~1
    relevance: number
    clarity: number
    evidenceStrength: number
    quantifiedImpact: number
  }
  evidenceSummary: {
    coverageLabel: string   // 如"覆盖 8/10 个关键要求"
    items: Array<{
      claimText: string
      requirementText: string
      confidence: number
    }>
  }
  riskSummary: {
    level: "low" | "medium" | "high"
    unsupportedClaims: string[]   // 无 evidence 支撑的断言
    warnings: string[]
  }
  missingInfo: string[]   // 无法覆盖的 JD 要求，可提示用户补充经历
}
```

---

## 九、Artifact 库

### Artifact 核心类型

```typescript
interface Artifact {
  id: string             // "art-xxx"
  userId: string
  type: string           // "cover_letter" | "self_intro" | "match_report" | ...
  title: string
  content: string        // markdown 格式正文
  sourceJdId?: string
  sourceExperienceIds: string[]
  createdAt: string
  updatedAt: string
}
```

---

### 9.1 获取 Artifact 列表

```http
GET /v1/product/artifacts?limit=20&cursor=art-xxx&type=cover_letter
```

---

### 9.2 获取 Artifact 详情

```http
GET /v1/product/artifacts/:artifactId
```

**Response `data`：** 完整 `Artifact`

---

### 9.3 更新 Artifact 内容

用户在前端编辑后保存（后端同时记录 edit diff 用于 PreferenceBank 学习）。

```http
PATCH /v1/product/artifacts/:artifactId
X-Idempotency-Key: <uuid>
```

**Request：**
```json
{
  "content": "用户编辑后的 markdown 内容...",
  "title": "新标题"
}
```

**Response `data`：** 更新后的 `Artifact`

---

### 9.4 删除 Artifact

```http
DELETE /v1/product/artifacts/:artifactId
```

**Response `data`：** `{ "deleted": true }`

---

## 十、文件上传与解析

### 10.1 上传文件

```http
POST /v1/files/upload
Content-Type: multipart/form-data
```

**Form Fields：**
- `file`：文件二进制（支持 PDF / .docx / .doc / 图片 PNG/JPG）
- 大小限制：20MB

**Response `data`：**
```json
{
  "fileId": "file-xxx",
  "originalName": "我的简历.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 204800,
  "status": "uploaded",
  "createdAt": "2026-07-04T10:00:00Z"
}
```

---

### 10.2 解析文件（同步）

上传后立即调用解析，接口同步返回解析结果（不超过 30 秒超时）。

```http
POST /v1/files/:fileId/parse
```

**Response `data`：**
```json
{
  "fileId": "file-xxx",
  "status": "parsed",
  "parsedText": "提取出的纯文本内容...",
  "pageCount": 2
}
```

解析完成后可直接用 `parsedText` 调用 `POST /v1/product/import/text`。

错误情况（文件损坏/加密）：
```json
{
  "ok": false,
  "error": {
    "code": "FILE_PARSE_FAILED",
    "message": "PDF 文件已加密，无法提取文本",
    "retryable": false
  }
}
```

---

## 十一、用户与偏好

### 11.1 获取当前用户信息

```http
GET /v1/users/me
```

**Response `data`：**
```json
{
  "id": "user-xxx",
  "email": "user@example.com",
  "createdAt": "2026-01-01T00:00:00Z"
}
```

---

### 11.2 获取用户 Profile

```http
GET /v1/users/me/profile
```

**Response `data`：**
```json
{
  "fullName": "张三",
  "email": "zhangsan@example.com",
  "phone": "+86 138 0000 0000",
  "location": "北京",
  "linkedinUrl": null,
  "githubUrl": "https://github.com/zhangsan",
  "personalWebsite": null,
  "currentTitle": "高级后端工程师",
  "currentCompany": "某公司",
  "yearsOfExperience": 5,
  "careerStage": "senior",
  "targetRoles": ["Backend Engineer", "Tech Lead"],
  "targetIndustries": ["互联网", "AI"],
  "targetLocations": ["北京", "上海", "远程"],
  "preferredLanguage": "zh-CN",
  "resumeStyle": "concise"
}
```

---

### 11.3 更新用户 Profile

```http
PATCH /v1/users/me/profile
```

**Request：** Profile 字段（均可选，只传需要更新的字段）

**Response `data`：** 完整 Profile

---

### 11.4 获取用户偏好列表（PreferenceBank）

```http
GET /v1/users/me/preferences?category=style
```

查询参数：
- `category`：`style` | `format` | `content` | `tone` | `length` | `language`

**Response `data`：**
```json
{
  "items": [
    {
      "id": "pref-xxx",
      "rule": "简历 bullet 控制在 20 字以内，不要冗长铺垫",
      "category": "style",
      "source": "explicit",
      "priority": 100,
      "confidence": 1.0,
      "reinforcementCount": 3,
      "createdAt": "2026-06-01T00:00:00Z"
    }
  ]
}
```

---

### 11.5 手动添加偏好（显式设置）

```http
POST /v1/users/me/preferences
```

**Request：**
```json
{
  "rule": "Cover letter 开头不要用'尊敬的'，改用具体的人名或团队名",
  "category": "tone",
  "scope": "cover_letter"
}
```

**Response `data`：** 新创建的 Preference 对象

---

### 11.6 删除偏好

```http
DELETE /v1/users/me/preferences/:preferenceId
```

**Response `data`：** `{ "deleted": true }`

---

### 11.7 登录

```http
POST /v1/auth/login
```

**Request：**
```json
{
  "email": "user@example.com",
  "password": "..."
}
```

**Response：** 设置 HttpOnly Cookie（`session=<token>`），同时返回：
```json
{
  "ok": true,
  "data": {
    "user": { "id": "user-xxx", "email": "user@example.com" }
  }
}
```

---

### 11.8 登出

```http
POST /v1/auth/logout
```

**Response `data`：** `{ "loggedOut": true }`，清除 session cookie。

---

## 十二、侧边栏与仪表盘

### 12.1 仪表盘概览

```http
GET /v1/dashboard
```

**Response `data`：**
```json
{
  "stats": {
    "experienceCount": 12,
    "resumeCount": 3,
    "jdCount": 5,
    "artifactCount": 8
  },
  "recentThreads": [ /* 最近 5 条会话 */ ],
  "recentActivities": [
    {
      "type": "resume_generated",
      "title": "生成了字节跳动投递版简历",
      "createdAt": "2026-07-04T10:00:00Z"
    }
  ]
}
```

---

## 十三、健康检查

```http
GET /v1/health
```

**Response（无需鉴权）：**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2026-07-04T10:00:00Z"
}
```

---

## 附录 A：前端接入优先级建议

| 优先级 | 接口 | 说明 |
|---|---|---|
| P0 | `POST /auth/login` + `GET /users/me` | 鉴权基础 |
| P0 | `POST /copilot/chat/stream` | 主对话体验 |
| P0 | `GET /threads/:id` + `POST /threads/:id/resume` | 会话恢复 + interrupt 确认 |
| P1 | `GET/POST /product/experiences` | 经历库基础 CRUD |
| P1 | `POST /product/import/text` + candidates accept/reject | 经历导入流程 |
| P1 | `GET/POST /product/jds` | JD 保存 |
| P1 | `GET /product/resumes/:id` | 简历编辑器数据 |
| P2 | `PATCH /product/resume-items/:id` | 简历 item 编辑 |
| P2 | `GET/PATCH /users/me/profile` | 用户 Profile 设置 |
| P2 | `GET /product/artifacts` | Artifact 管理 |
| P3 | `GET/POST /users/me/preferences` | 偏好管理 |
| P3 | `POST /files/upload` + `/parse` | 文件上传解析 |

---

## 附录 B：SSE 事件与前端 UI 对应关系

| SSE 事件 | 前端行为 |
|---|---|
| `agent.thinking` | 顶部显示加载状态，展示 `label` |
| `agent.route.completed` | 显示"正在处理：{targetSubgraph}" |
| `agent.node.started` | 更新进度步骤，展示 `label` |
| `content.diff.started` | 画布打开对应 item，展示原文 |
| `content.diff.delta` | 逐 token 在画布上追加新内容 |
| `content.diff.completed` | 渲染最终 diff 高亮（红删绿增） |
| `artifact.started` | 打开 artifact 面板，展示标题 |
| `artifact.delta` | 逐 token 渲染 markdown |
| `artifact.completed` | 完成 artifact 渲染，显示操作按钮 |
| `agent.message.delta` | 聊天气泡逐字显示 |
| `agent.message.completed` | 聊天气泡定稿 |
| `agent.interrupt` | 画布冻结，弹出确认卡（含 diff 预览）|
| `agent.completed` | 用 `response.workspace` 刷新整个右侧面板，关闭 SSE |
| `agent.failed` | 显示错误 toast，提供重试按钮，关闭 SSE |
