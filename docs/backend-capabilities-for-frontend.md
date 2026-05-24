# 后端能力说明：给前端的产品化展示指南

本文档描述当前后端已经具备的能力、接口形态、核心数据结构、Copilot 工作区如何驱动前端展示，以及前端应该如何组织个性化界面。

适用范围：

- 前端页面、侧边栏、对话区、简历编辑器、经历库、JD 库、生成结果页、证据面板、导出面板。
- 当前仓库后端接口，不包含未来规划接口。
- 所有接口默认以 Fastify 注册，返回 JSON envelope，除 SSE 和下载接口外。

## 1. 通用约定

### 1.1 API 返回 envelope

成功响应：

```ts
type ApiSuccess<T> = {
  ok: true;
  data: T;
  meta: {
    requestId: string;
    traceId?: string;
    mode: "postgres" | "in_memory";
    warnings?: string[];
  };
};
```

失败响应：

```ts
type ApiFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
  };
  meta: {
    requestId: string;
    traceId?: string;
    mode: "postgres" | "in_memory";
    warnings?: string[];
  };
};
```

前端建议：

- 所有普通接口先判断 `ok`。
- `meta.requestId` / `meta.traceId` 可放到错误详情抽屉或 debug 面板。
- `meta.warnings` 如果存在，可在开发环境顶部显示非阻塞提示。

### 1.2 鉴权与请求头

后端支持多种 auth resolver，前端本地开发常见方式：

- Cookie session：`/auth/dev-login` 会设置 HttpOnly cookie。
- Dev header：部分环境可通过 `x-user-id` 识别用户。
- Bearer/static auth 取决于后端环境配置。

通用请求头：

```http
content-type: application/json
x-request-id: optional-client-request-id
x-trace-id: optional-client-trace-id
idempotency-key: required-for-important-writes-if-client-wants-replay-safety
```

写接口通常通过 `withIdempotency` 包裹。前端对保存、确认、导出、生成等动作建议传 `idempotency-key`。

SSE 接口 `/copilot/chat/stream` 不支持 `idempotency-key`。

### 1.3 Canonical ID 规则

Agent 工具链对写操作要求 canonical ID。前端不要自己造业务 ID，应使用后端返回的 ID。

常见 ID 前缀：

| 类型 | 前缀 | 示例 |
|---|---|---|
| Experience | `pexp-` | `pexp-uuid` |
| JD | `pjd-` | `pjd-uuid` |
| Resume | `pres-` | `pres-uuid` |
| Resume item | `presitem-` | `presitem-uuid` |
| Variant | `pvar-` / `pexpvar-` | `pvar-uuid` |
| Generation | `pgen-` | `pgen-uuid` |
| Experience revision | `pexprev-` | `pexprev-uuid` |
| Import job | `pimp-` | `pimp-uuid` |
| Import candidate | `pimpcand-` | `pimpcand-uuid` |

前端重点：

- 点击某个经历、JD、简历、variant 后，把对应 ID 放入 `clientState`。
- 触发写动作时传明确 ID，不要传标题、公司名、自然语言别名。
- 如果后端返回 `needs_input` 且 `missingInputs` 包含某个 ID，前端应引导用户重新选择具体资源。

## 2. Copilot 是前端主体验入口

前端要做“个性化展示”，核心不要只展示聊天文本，而是消费 `CopilotChatResponse` 中的结构化字段：

```ts
type CopilotChatResponse = {
  sessionId: string;
  turnId: string;
  assistantMessage: CopilotMessage;
  timeline: ProductTimelineItem[];
  workspace: CopilotWorkspace;
  nextActions: ProductAction[];
  suggestedPrompts?: SuggestedPrompt[];
  raw: CopilotRawSection;
};
```

建议页面布局：

- 左侧：session 列表、最近简历、最近 JD、最近经历、最近生成结果。
- 中间：聊天流 + timeline。
- 右侧主工作区：由 `workspace.activePanel` 决定展示哪个产品面板。
- 底部或右侧浮层：pending confirmation / action result / evidence drawer。

### 2.1 `workspace.activePanel` 驱动主面板

```ts
type activePanel =
  | "variants"
  | "experience_library"
  | "resume_history"
  | "resume_editor"
  | "jd_library"
  | "import_candidates";
```

展示建议：

| activePanel | 前端主区域 |
|---|---|
| `variants` | 展示生成的简历 variants、分数、证据、风险、操作按钮 |
| `experience_library` | 展示经历库列表或经历详情 |
| `resume_history` | 展示简历列表 |
| `resume_editor` | 展示简历编辑器、简历条目、导出入口 |
| `jd_library` | 展示 JD 列表或 JD 详情 |
| `import_candidates` | 展示导入候选经历，允许接受/拒绝 |

### 2.2 `workspace.active` 是当前选中资源

```ts
active?: {
  jdId?: string;
  jdDraftId?: string;
  experienceId?: string;
  experienceDraftId?: string;
  resumeId?: string;
  resumeItemId?: string;
  variantId?: string;
};
```

前端应同步维护 `clientState`：

```ts
type CopilotClientState = {
  locale?: string;
  mainMode?: string;
  activeSessionId?: string;
  activeJDId?: string;
  activeResumeId?: string;
  activeExperienceId?: string;
  activeVariantId?: string;
  activeResumeItemId?: string;
  selectedText?: string;
  selectedSection?: string;
  intentSource?: "composer" | "sidebar" | "artifact_action" | "asset_detail" | "system";
  sourceComponent?: string;
  visibleArtifactTypes?: string[];
  visibleArtifactIds?: string[];
};
```

前端建议：

- 用户点击 variant card：设置 `activeVariantId`。
- 用户打开简历编辑器：设置 `activeResumeId`。
- 用户选中某条简历 bullet：设置 `activeResumeItemId`，如果有选中文本再设置 `selectedText`。
- 用户打开经历详情：设置 `activeExperienceId`。
- 用户打开 JD：设置 `activeJDId`。

这些状态会影响 Agent hydrator 和 scope guard。传错 ID 会被后端拒绝，不会静默写错资源。

## 3. Copilot 接口

### 3.1 发送普通聊天

`POST /copilot/chat`

请求：

```json
{
  "sessionId": "cs-optional-existing-session",
  "message": "帮我根据这个 JD 生成简历",
  "resumeText": "可选：用户粘贴的简历文本",
  "jdText": "可选：用户粘贴的 JD 文本",
  "targetRole": "Frontend Engineer",
  "clientState": {
    "locale": "zh-CN",
    "activeJDId": "pjd-...",
    "activeResumeId": "pres-...",
    "activeVariantId": "pvar-..."
  }
}
```

返回：`ApiSuccess<CopilotChatResponse>`。

展示方式：

- `assistantMessage.content` 放聊天气泡。
- `timeline` 放运行摘要或右侧动态事件。
- `workspace` 更新主工作区。
- `raw.pendingActions` 如果有，显示确认卡片。
- `raw.actionResults` 用于显示 action 状态、缺失输入、证据、导出记录等。

### 3.2 SSE 流式聊天

`POST /copilot/chat/stream`

请求 body 同 `/copilot/chat`，但不能带 `idempotency-key`。

返回是 `text/event-stream`。

事件格式：

```text
event: agent.tool.started
data: {"type":"agent.tool.started","sessionId":"...","turnId":"...","label":"...","toolName":"...","status":"running"}
```

事件类型：

```ts
type AgentStreamEventType =
  | "agent.turn.started"
  | "agent.thinking"
  | "agent.route.started"
  | "agent.route.completed"
  | "agent.agent.started"
  | "agent.agent.completed"
  | "agent.tool.started"
  | "agent.tool.completed"
  | "agent.tool.failed"
  | "agent.pending_action.created"
  | "agent.critic.started"
  | "agent.critic.completed"
  | "agent.workspace.updated"
  | "agent.message.delta"
  | "agent.message.completed"
  | "agent.completed"
  | "agent.failed";
```

前端展示建议：

- 顶部显示当前阶段：route、agent、tool、critic。
- `agent.tool.started` 后显示工具执行中。
- `agent.pending_action.created` 显示确认卡。
- `agent.completed` 的 `response` 是完整 `CopilotChatResponse`，用它刷新整个工作区。
- `agent.failed` 显示错误 toast 和调试 ID。

### 3.3 显式产品动作

`POST /copilot/actions`

适合按钮点击，不适合自然语言输入。

请求：

```json
{
  "sessionId": "cs-...",
  "turnId": "ct-optional",
  "action": {
    "type": "accept",
    "variantId": "pvar-...",
    "payload": {
      "generationId": "pgen-...",
      "resumeId": "pres-optional"
    }
  },
  "clientState": {
    "activeVariantId": "pvar-...",
    "activeResumeId": "pres-..."
  }
}
```

支持的 `action.type`：

| action type | 当前后端行为 |
|---|---|
| `accept` | 映射到 `accept_generation_variant`，需要 confirmation |
| `reject` | 当前返回 `needs_input` / 产品消息，不做真实写入 |
| `prefer` | 返回让用户说明偏好的提示 |
| `show_evidence` | 展示 variant/evidence 证据 |
| `explain_choice` | 同 `show_evidence` |
| `generate_from_jd` | 映射到 `generate_resume_from_jd`，需要 confirmation |
| `optimize_resume_item` | 映射到 `revise_resume_item`，需要 confirmation |
| `rewrite_experience` | 映射到 `update_experience`，需要 confirmation |
| `export_resume` | 映射到 `export_resume`，需要 confirmation |
| `confirm_metric` | 暂未完整实现，返回说明 |
| `revise_more_conservative` | 暂未完整实现，返回说明 |
| `revise_more_quantified` | 暂未完整实现，返回说明 |

## 4. Pending Actions 确认机制

高风险或写操作不会直接执行，会生成 pending action。

### 4.1 PendingAction 结构

```ts
type PendingAction = {
  id: string;                 // pa-...
  userId: string;
  sessionId: string;
  turnId?: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  status: "pending" | "confirmed" | "cancelled" | "executed" | "expired" | "failed";
  title: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  affectedResources: Array<{ type: "experience" | "jd" | "resume" | "export"; id?: string; title?: string }>;
  preview?: { before?: unknown; after?: unknown };
  createdAt: string;
  expiresAt: string;
};
```

### 4.2 Pending action 接口

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/copilot/pending-actions?sessionId=cs-...` | 当前用户 pending action 列表 |
| `GET` | `/copilot/pending-actions/:id` | pending action 详情 |
| `POST` | `/copilot/pending-actions/:id/confirm` | 确认并执行，返回 `CopilotChatResponse` |
| `POST` | `/copilot/pending-actions/:id/cancel` | 取消 pending action |

前端展示建议：

- 如果 `raw.actionResults[].status === "needs_confirmation"`，显示确认卡。
- 确认卡显示：`summary`、`riskLevel`、`affectedResources`、`preview.before/after`。
- 点击确认调用 `/copilot/pending-actions/:id/confirm`。
- confirm 返回完整 `CopilotChatResponse`，前端用返回的 `workspace` 刷新 UI。
- 如果 confirm 返回 `needs_input`，说明 pending action 已失效、ID 不合法或 scope 不匹配，应提示用户重新发起。

## 5. Copilot Session / Sidebar / Dashboard

### 5.1 Session 列表

`GET /copilot/sessions?limit=30`

返回 active sessions。

展示建议：

- 左侧会话列表。
- 用 `title` / `targetRole` / `updatedAt` 展示。

### 5.2 Session 详情

`GET /copilot/sessions/:id`

返回：

```ts
{
  session: CopilotSession;
  messages: CopilotMessage[];
  workspace: CopilotWorkspace | null;
  turns: CopilotTurn[];
  detailWarnings?: Array<{ source: string; message: string }>;
}
```

展示建议：

- `messages` 渲染聊天记录。
- `workspace` 恢复右侧主工作区。
- `turns` 可做 debug timeline。
- `detailWarnings` 表示局部加载失败，页面不应整体崩溃。

### 5.3 更新 Session

`PATCH /copilot/sessions/:id`

请求：

```json
{
  "title": "我的前端求职会话",
  "status": "active"
}
```

`status` 可为 `active | archived | deleted`。

### 5.4 Sidebar

`GET /copilot/sidebar`

返回：

```ts
{
  recentSessions: Array<{ id: string; title?: string | null; updatedAt: string; targetRole?: string | null; status?: string }>;
  recentResumes: ProductResumeSummary[];
  recentJDs: ProductJDSummary[];
  recentExperiences: ProductExperienceSummary[];
  recentGenerations: Array<{ id: string; targetRole?: string; jdId?: string; resumeId?: string; createdAt: string }>;
  recentActivities: Array<{ id: string; type: string; title: string; description?: string | null; createdAt: string }>;
}
```

### 5.5 Product Dashboard

`GET /product/dashboard`

返回 sidebar 内容加计数：

```ts
{
  experienceCount: number;
  resumeCount: number;
  jdCount: number;
  generationCount: number;
  recentSessions: ...
}
```

展示建议：

- 首页概览卡：经历数、简历数、JD 数、生成次数。
- 最近活动 feed。
- 最近生成结果入口。

## 6. Product REST 能力

这些接口适合前端做确定性 CRUD；Copilot 接口适合智能流程和按钮动作。

### 6.1 Experience 经历库

核心类型：

```ts
type ProductExperience = {
  id: string;
  userId: string;
  category: "work" | "project" | "education" | "award" | "skill" | "other";
  title: string;
  organization?: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  tags: string[];
  status: "active" | "archived" | "deleted";
  currentRevisionId?: string;
  createdAt: string;
  updatedAt: string;
};

type ProductExperienceRevision = {
  id: string;
  experienceId: string;
  userId: string;
  content: string;
  structured?: unknown;
  source: "manual" | "import" | "copilot" | "resume_upload";
  createdAt: string;
};
```

接口：

| Method | Path | Body | 返回 |
|---|---|---|---|
| `GET` | `/product/experiences?limit=50` | - | `ProductExperienceSummary[]` |
| `POST` | `/product/experiences` | `{ title, content, category?, organization?, role?, tags? }` | `{ experience, revision }` |
| `GET` | `/product/experiences/:id` | - | `{ experience, revisions, variants }` |
| `PATCH` | `/product/experiences/:id` | `{ title?, organization?, role?, tags? }` | `ProductExperience` |
| `POST` | `/product/experiences/:id/revisions` | `{ content, source?, structured? }` | `ProductExperienceRevision` |
| `POST` | `/product/experiences/:id/variants` | `{ revisionId, content, variantType?, language?, targetJdId? }` | `ProductExperienceVariant` |

展示建议：

- 经历列表卡：`title`、`organization`、`role`、`category`、`tags`、`updatedAt`。
- 经历详情：左边 metadata，右边 current revision 文本；下方 revisions 时间线。
- Copilot 改写经历时，pending action preview 可展示 before/after。

### 6.2 JD 库

核心类型：

```ts
type ProductJDRecord = {
  id: string;
  userId: string;
  title: string;
  company?: string;
  targetRole?: string;
  rawText: string;
  requirements?: unknown;
  createdAt: string;
  updatedAt: string;
};
```

接口：

| Method | Path | Body | 返回 |
|---|---|---|---|
| `GET` | `/product/jds?limit=50` | - | `ProductJDSummary[]` |
| `POST` | `/product/jds` | `{ rawText 或 jdText, title?, company?, targetRole? }` | `ProductJDRecord` |
| `GET` | `/product/jds/:id` | - | `ProductJDRecord` |

展示建议：

- JD 列表：职位、公司、目标角色、更新时间。
- JD 详情：`rawText` 文本预览，右侧放“生成简历”按钮。
- 调用 `generate_from_jd` action 时传 `jdId` 或 `jdText`。

### 6.3 Resume 简历库与编辑器

核心类型：

```ts
type ProductResume = {
  id: string;
  userId: string;
  title: string;
  targetRole?: string;
  jdId?: string;
  templateId?: string;
  status: "draft" | "ready" | "archived";
  createdAt: string;
  updatedAt: string;
};

type ProductResumeItem = {
  id: string;
  resumeId: string;
  userId: string;
  sourceExperienceId?: string;
  sourceVariantId?: string;
  sourceArtifactId?: string;
  sectionType: "experience" | "education" | "project" | "skill" | "award" | "summary" | "other";
  title: string;
  contentSnapshot: string;
  orderIndex: number;
  hidden: boolean;
  pinned: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type ProductResumeDetail = ProductResume & { items: ProductResumeItem[] };
```

接口：

| Method | Path | Body | 返回 |
|---|---|---|---|
| `GET` | `/product/resumes?limit=50` | - | `ProductResumeSummary[]` |
| `POST` | `/product/resumes` | `{ title?, targetRole?, jdId? }` | `ProductResume` |
| `GET` | `/product/resumes/:id` | - | `ProductResumeDetail` |
| `POST` | `/product/resumes/:id/items` | `{ title, contentSnapshot, sectionType?, sourceExperienceId?, sourceVariantId?, sourceArtifactId? }` | `ProductResumeItem` |
| `PATCH` | `/product/resume-items/:id` | `{ title?, contentSnapshot?, hidden?, pinned? }` | `ProductResumeItem` |
| `POST` | `/product/resumes/:id/reorder` | `{ orderedIds: string[] }` | 更新后的 items/order 结果 |

展示建议：

- Resume editor 按 `sectionType` 分组。
- 每个 item 展示 `title`、`contentSnapshot`、source 信息、隐藏/置顶状态。
- 用户选择 item 后设置 `clientState.activeResumeItemId`。
- “优化这条”按钮走 `/copilot/actions` 的 `optimize_resume_item`。

### 6.4 Import 导入经历

接口：

| Method | Path | Body | 返回 |
|---|---|---|---|
| `POST` | `/product/imports/text` | `{ rawText 或 text }` | `{ job, candidates }` |
| `POST` | `/product/imports/file` | `{ fileId }` | `{ job }` |
| `GET` | `/product/imports/:id` | - | `{ job, candidates }` |
| `POST` | `/product/import-candidates/:id/accept` | - | accepted candidate / created experience |
| `POST` | `/product/import-candidates/:id/reject` | - | rejected candidate |

类型：

```ts
type ProductImportCandidate = {
  id: string;
  jobId: string;
  userId: string;
  title: string;
  category: ProductExperienceCategory;
  organization?: string;
  role?: string;
  content: string;
  structured?: unknown;
  status: "pending" | "accepted" | "rejected" | "merged";
  createdAt: string;
  updatedAt: string;
};
```

展示建议：

- 导入后进入 `import_candidates` 面板。
- 每个 candidate 用卡片展示 title/category/org/role/content。
- 接受后进入经历库；拒绝后从候选列表淡出或标记 rejected。

### 6.5 Generation 生成结果

接口：

| Method | Path | Body | 返回 |
|---|---|---|---|
| `GET` | `/product/generations?limit=50` | - | `ProductGeneration[]` |
| `GET` | `/product/generations/:id` | - | generation + `variants` |
| `POST` | `/product/generations/from-jd` | `{ jdId? 或 jdText?/rawText?/text?, targetRole? }` | `{ generationId, jd, variants, generation }` |
| `POST` | `/product/generations/:id/accept-variant` | `{ variantId, resumeId? }` | `{ generation, resume, item, variant }` |

`ProductVariant` 是前端最适合做个性化展示的结构：

```ts
type ProductVariant = {
  id: string;
  title: string;
  content: string;
  role: "recommended" | "alternative" | "safe" | "quantified" | "experimental";
  status: "ready" | "needs_confirmation" | "unsafe" | "accepted" | "rejected";
  score: {
    overall?: number;
    relevance?: number;
    clarity?: number;
    evidenceStrength?: number;
    quantifiedImpact?: number;
  };
  badges: Array<{ label: string; tone: "neutral" | "positive" | "warning" | "danger" }>;
  reason: string;
  evidenceSummary: {
    coverageLabel: string;
    items: Array<{ id: string; title: string; quote?: string; explanation: string; confidence?: number }>;
  };
  riskSummary: {
    level: string;
    unsupportedClaims: string[];
    missingEvidence: string[];
    warnings: string[];
  };
  missingInfo: string[];
  sourceExperienceIds: string[];
  sourceEvidenceIds: string[];
  raw: Record<string, unknown>;
  createdAt: string;
};
```

展示建议：

- Variant 卡片顶部：`title` + `role` badge。
- 主体：`content`，可做逐段高亮。
- 分数：用雷达图或横向 score bars 展示 `overall/relevance/clarity/evidenceStrength/quantifiedImpact`。
- 证据：显示 `evidenceSummary.coverageLabel` 和 `items`。
- 风险：如果 `riskSummary.level` 高，显示 warning panel。
- 缺失信息：用 `missingInfo` 做补充材料 checklist。
- 按钮：接受、查看证据、偏好调整、导出。

## 7. Evidence 证据能力

前端可通过 `/copilot/actions` 调用：

```json
{
  "sessionId": "cs-...",
  "action": {
    "type": "show_evidence",
    "variantId": "pvar-..."
  },
  "clientState": {
    "activeVariantId": "pvar-..."
  }
}
```

也可传：

- `variantId`
- `evidenceId`
- `evidenceChainId`
- `generationId`
- 兼容字段 `id`

当前重要行为：

- `variantId`：展示该 variant 的 evidence。
- `evidenceId`：展示包含该 evidence 的 variant/evidence summary。
- `evidenceChainId`：按 evidence chain / variant 查找。
- `generationId-only`：目前返回 `needs_input`，`reason = generation_evidence_lookup_not_supported`。
- 不会 fallback 到 `workspace.variants[0]`。

前端展示建议：

- Evidence drawer 展示 `actionResult.metadata.evidence`。
- 如果 `reason === "generation_evidence_lookup_not_supported"`，提示用户先选择一个具体版本。
- 如果 `reason === "evidence_chain_not_available"`，提示当前版本证据不足，可引导补充经历库。

## 8. Export 导出能力

### 8.1 Copilot 导出

通过 `/copilot/actions`：

```json
{
  "sessionId": "cs-...",
  "action": {
    "type": "export_resume",
    "payload": {
      "resumeId": "pres-...",
      "format": "html",
      "templateId": "optional"
    }
  }
}
```

会生成 pending action，确认后创建 export job。

### 8.2 REST 导出

| Method | Path | Body | 返回 |
|---|---|---|---|
| `POST` | `/exports/resumes/:resumeId` | `{ format?: "html" | "pdf", templateId? }` | `{ exportRecord, job }` |
| `GET` | `/exports?limit=50` | - | `ResumeExport[]` |
| `GET` | `/exports/:id` | - | `ResumeExport` |
| `GET` | `/exports/:id/download` | - | HTML text 或 PDF bytes |
| `DELETE` | `/exports/:id` | - | deleted export record |

注意：

- `ResumeExportFormat` 类型里有 `docx`，但当前 route 只接受 `html | pdf`。
- 下载接口不包 JSON envelope，直接返回文件内容。

## 9. Files 与 Jobs

### 9.1 文件上传和解析

接口：

| Method | Path | Body | 返回 |
|---|---|---|---|
| `POST` | `/files/upload` | multipart `file` 或 `{ base64, fileName, mimeType }` | `UploadedFile` |
| `GET` | `/files?limit=50` | - | `UploadedFile[]` |
| `GET` | `/files/:id` | - | `UploadedFile` |
| `DELETE` | `/files/:id` | - | deleted file |
| `POST` | `/files/:id/parse` | - | `{ job }` |
| `GET` | `/files/:id/parsed-document` | - | `ParsedDocument` |

类型：

```ts
type UploadedFile = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: "uploaded" | "parsed" | "failed" | "deleted";
  parserStatus?: string;
  parserError?: string;
  textDocumentId?: string;
  createdAt: string;
  updatedAt: string;
};
```

### 9.2 后台 Job

接口：

| Method | Path | Body | 返回 |
|---|---|---|---|
| `GET` | `/jobs?limit=50` | - | `BackgroundJob[]` |
| `POST` | `/jobs` | `{ type, input?, runAfter? }` | `BackgroundJob` |
| `GET` | `/jobs/:id` | - | `BackgroundJob` |
| `POST` | `/jobs/:id/cancel` | - | `BackgroundJob` |

Job 类型：

```ts
type BackgroundJobType =
  | "import_pdf"
  | "export_pdf"
  | "rebuild_index"
  | "long_generation"
  | "parse_document"
  | "import_resume_file"
  | "export_resume_html"
  | "export_resume_pdf";
```

展示建议：

- 文件解析、导入、导出都可以统一放到 job drawer。
- 根据 `status` 和 `progress` 展示进度条。
- `errorMessage` 进入失败详情。

## 10. Auth 与 API Keys

接口：

| Method | Path | Body | 返回 |
|---|---|---|---|
| `GET` | `/auth/me` | - | `{ user }` |
| `POST` | `/auth/dev-login` | `{ email?, displayName? }` | `{ user }`，并设置 cookie |
| `POST` | `/auth/logout` | - | `{ loggedOut: true }` |
| `GET` | `/auth/api-keys` | - | user api keys |
| `POST` | `/auth/api-keys` | `{ provider, label, apiKey, baseUrl?, model? }` | created key |
| `DELETE` | `/auth/api-keys/:id` | - | disabled key |

`provider` 可为：

- `deepseek`
- `openai`
- `compatible`

前端展示建议：

- 设置页可做 API key 管理。
- `model` / `baseUrl` 用于兼容供应商配置。

## 11. Agent 工具能力清单

前端一般不直接调用工具，而是通过 `/copilot/chat` 或 `/copilot/actions` 间接触发。

可用工具可通过：

`GET /copilot/agent-debug/tools`

返回：

```ts
Array<{
  name: string;
  ownerAgent: string;
  mutability: "read" | "write" | "delete" | "export";
  requiresConfirmation: boolean;
  riskLevel: "low" | "medium" | "high";
}>
```

当前工具能力：

| 工具 | 能力 | 是否确认 |
|---|---|---|
| `list_experiences` | 列经历库，更新 workspace.experiences | 否 |
| `search_experiences` | 搜索经历 | 否 |
| `get_experience` | 取经历详情和 revisions | 否 |
| `prepare_save_experience_from_text` | 预览保存经历 | 否 |
| `save_experience_from_text` | 保存经历 | 是 |
| `prepare_update_experience` | 预览经历更新 | 否 |
| `update_experience` | 更新经历 metadata / 创建 revision | 是 |
| `prepare_delete_experience` | 预览删除经历 | 否 |
| `delete_experience` | archive 经历 | 是 |
| `list_jds` | 列 JD | 否 |
| `get_jd` | 取 JD | 否 |
| `prepare_save_jd_from_text` | 预览保存 JD | 否 |
| `save_jd_from_text` | 保存 JD | 是 |
| `list_resumes` | 列简历 | 否 |
| `get_resume` | 取简历详情和 items | 否 |
| `generate_resume_from_jd` | 基于 JD 生成 variants | 是 |
| `accept_generation_variant` | 接受 variant 并保存到简历 | 是 |
| `revise_resume_item` | 改写一个 resume item | 是 |
| `show_evidence` | 展示 variant/evidence 证据 | 否 |
| `check_unsupported_claims` | 检查夸大/不可证实表达 | 否 |
| `prepare_export_resume` | 预览导出 | 否 |
| `export_resume` | 创建导出 job | 是 |

## 12. ToolResult / ActionResult 展示规则

工具返回统一形态：

```ts
type ToolResult = {
  status: "success" | "needs_input" | "failed";
  message?: string;
  data?: unknown;
  workspacePatch?: Record<string, unknown>;
  actionResult?: Record<string, unknown>;
  pendingActionId?: string;
  visibility?: "internal" | "user_summary" | "action_required" | "error_user_visible";
};
```

前端不直接拿 `workspacePatch` 合并；后端已经把结果合并到 `response.workspace`。

展示建议：

- `visibility = "internal"`：不要当聊天文本展示，可用于 debug 或产品面板。
- `visibility = "user_summary"`：可作为聊天摘要或 toast。
- `visibility = "action_required"`：显示确认/输入要求。
- `visibility = "error_user_visible"`：显示错误或缺失输入提示。

`raw.actionResults` 是前端更适合消费的动作状态：

```ts
type CopilotActionResult = {
  actionType?: string;
  status: "success" | "needs_input" | "needs_confirmation" | "failed";
  message?: string;
  reason?: string;
  pendingActionId?: string;
  missingInputs?: string[];
  exportRecord?: { id: string; resumeId?: string; format?: string; status?: string; jobId?: string; createdAt?: string };
  revisionSuggestion?: {
    kind: "resume_item" | "experience" | "variant";
    sourceId?: string;
    sourceTextPreview?: string;
    rewrittenText?: string;
    usedModel?: boolean;
  };
  evidenceId?: string;
  variantId?: string;
  metadata?: Record<string, unknown>;
};
```

状态处理：

| status | UI |
|---|---|
| `success` | 成功 toast，刷新对应面板 |
| `needs_input` | 缺信息提示，按 `missingInputs` 引导选择资源 |
| `needs_confirmation` | 显示 pending action 确认卡 |
| `failed` | 错误提示，可打开 debug trace |

## 13. 前端个性化展示建议

### 13.1 Variant 对比页

用 `workspace.variants` 渲染：

- 大卡片：recommended variant。
- 小卡片：alternative / safe / quantified。
- 卡片内部：
  - `score` 做图表。
  - `badges` 做彩色标签。
  - `riskSummary` 做风险条。
  - `evidenceSummary.items` 做证据脚注。
  - `missingInfo` 做“还需要补充”的 checklist。

按钮：

- 接受：`POST /copilot/actions` `type=accept`
- 查看证据：`type=show_evidence`
- 导出：如果已有 resume，`type=export_resume`

### 13.2 简历编辑器

用 `workspace.activeResume` 或 `GET /product/resumes/:id`。

展示：

- 左侧 section navigation。
- 中间 resume items，可 inline edit。
- 右侧 Copilot suggestions。
- 选中 item 后发送 `clientState.activeResumeItemId`。

优化 item：

```json
{
  "sessionId": "cs-...",
  "action": {
    "type": "optimize_resume_item",
    "payload": {
      "resumeItemId": "presitem-...",
      "instruction": "更简洁，保留指标"
    }
  },
  "clientState": {
    "activeResumeId": "pres-...",
    "activeResumeItemId": "presitem-..."
  }
}
```

### 13.3 经历库

用 `GET /product/experiences` 或 `workspace.experiences`。

展示：

- 列表卡：title/org/role/category/tags。
- 详情页：metadata + current revision。
- 改写经历：
  - 前端应先让模型/用户产生明确 rewritten content。
  - `update_experience` 不会把 selectedText 或 original text 当成写入内容。
  - 如果没有 rewritten content，后端会返回 `needs_input`。

### 13.4 证据抽屉

触发 `show_evidence` 后，从 `raw.actionResults[].metadata` 或 `raw.toolResults[].data` 取：

- evidence items
- sourceExperienceIds
- sourceEvidenceIds
- riskSummary

展示：

- 证据标题、解释、confidence。
- source experience ID 可链接到经历详情。
- 如果证据缺失，显示补充经历库 CTA。

### 13.5 Pending confirmation 层

统一确认弹层：

- 标题：`pendingAction.title`
- 描述：`pendingAction.summary`
- 风险：`riskLevel`
- 影响资源：`affectedResources`
- preview：before/after diff
- 按钮：Confirm / Cancel

Confirm 后直接用返回的 `CopilotChatResponse.workspace` 替换当前 workspace。

## 14. 当前安全约束对前端的影响

后端现在会强制执行：

- 模型生成的非 canonical ID 不可信。
- 写操作需要 scope guard，跨 session/workspace/resource 会被拒绝。
- confirmation 阶段会重新校验 ID、schema、scope。
- `show_evidence generationId-only` 不会 fallback active variant。
- `revise_resume_item` 必须是 `presitem-*` 且属于 `workspace.activeResume.items`。
- `update_experience` patch 只允许安全字段：`title/category/organization/role/startDate/endDate/tags`。
- `patch.content` 不会写入正文；正文只能走明确 `content`。

前端因此应该：

- 始终传后端返回的 ID。
- 每次按钮动作都带上最新 `clientState`。
- 遇到 `needs_input` 不要自动重试，应让用户重新选择资源。
- confirmation 卡过期或被拒绝后，重新发起动作。

## 15. 已知限制

- generation-level evidence lookup 目前不支持；必须选具体 variant 或 evidence。
- `/exports/resumes/:resumeId` route 当前只接受 `html | pdf`，虽然类型层存在 `docx`。
- `revise_resume_item` scope guard 当前依赖 `workspace.activeResume.items`；repository-level item ownership API 还未暴露。
- 某些中文 message 在当前代码中存在编码显示问题；前端应优先使用结构化 `status/reason/actionType` 驱动 UI，用户文案可在前端本地化覆盖。
- `confirm_metric`、`revise_more_conservative`、`revise_more_quantified` 目前是占位动作，会返回提示而非真实变更。

## 16. 推荐前端接入优先级

1. 接入 `/copilot/sidebar` 和 `/copilot/sessions/:id`，先恢复会话和 workspace。
2. 用 `/copilot/chat` 或 `/copilot/chat/stream` 驱动主对话。
3. 用 `workspace.activePanel` 切换右侧产品面板。
4. 完成 variants 展示：score、badges、risk、evidence、missingInfo。
5. 完成 pending action 统一确认弹层。
6. 完成 resume editor 的 item 选择与 `optimize_resume_item`。
7. 完成 evidence drawer。
8. 完成 export job 状态和下载。

