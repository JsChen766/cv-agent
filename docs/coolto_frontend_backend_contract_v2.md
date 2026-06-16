# Coolto / 库投 前后端产品契约文档 v2

版本：v2.0  
目标：作为 `cv-agent` 后端与 `cv_agent_frontend` 前端的唯一接口契约（source of truth）。  
适用范围：Product API、Copilot API、Pending Action、文件导入、导出、会话侧边栏、前端 active asset context、DeepSeek V4 Pro 接入。

---

## 0. 本次重新彻查后发现的问题总览

本次问题不是“几个接口字段没对上”，而是以下 8 类契约缺陷叠加：

| 编号 | 问题类别 | 现象 | 严重级别 |
|---|---|---|---|
| C1 | 请求字段不一致 | `importFromText` 前端发 `text`，后端只收 `rawText` | P0 |
| C2 | 业务动作缺后端映射 | 前端有 `rewrite_experience`，后端 `/copilot/actions` 没有 case | P0 |
| C3 | 当前资产 ID 丢失 | 用户说“改这条经历/优化这段简历”，请求体里没有 `experienceId` / `resumeItemId` | P0 |
| C4 | 后端 schema error 泄漏到产品层 | 缺 id 时返回 `xxx is required` / schema validation，而不是 `needs_input` | P0 |
| C5 | 经历正文修改链路不完整 | 后端有 revision 能力，前端没有稳定封装和 UI flow | P0 |
| C6 | Copilot Action 与 Product API 混用不清 | 资产按钮走 Copilot pending action，导致“点了没反应” | P1 |
| C7 | 工具是占位实现 | `show_evidence` 返回空数组；`revise_resume_item` 只是把 instruction 写进条目 | P1 |
| C8 | Workspace patch 字段不统一 | tools 写 `activePanel: "experience_library"`，但 workspace 类型需要 panel/detail 语义，前端无法稳定恢复详情态 | P1 |
| C9 | Accept Variant fallback 不完整 | 前端会构造 `accept` action，但后端 mapExplicitAction 不支持 `accept/reject/prefer` | P1 |
| C10 | JD 输入落库不稳定 | Composer 粘贴 JD 主要走自然语言，没有稳定 `createJD -> activeJDId -> generate` 流程 | P1 |
| C11 | 文件导入可能异步断链 | `/files/:id/parse` 与 `/product/imports/file` 都返回 job，前端依赖 job.output.importJobId，但契约没有强制 job output 结构 | P1 |
| C12 | Export download 不是 envelope | `/exports/:id/download` 返回 raw HTML/PDF，这是合理的，但前端契约必须明确它不是 `{ok,data}` | P2 |
| C13 | SSE completed 事件结构不唯一 | 前端做了多种兼容解析，说明后端 completed event 结构应固定 | P2 |
| C14 | 前端存在中文乱码 | `鎿嶄綔澶辫触` 等乱码需要清理 | P2 |
| C15 | DeepSeek 模型配置需升级 | 当前 README 示例仍有 `deepseek-chat`，目标应支持 `deepseek-v4-pro` 并禁用思考泄漏 | P2 |

---

# 1. 全局响应契约

除下载类接口外，所有 JSON API 必须返回统一 envelope：

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

type ApiFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: unknown;
  };
  meta: {
    requestId: string;
    traceId?: string;
    mode: "postgres" | "in_memory";
    warnings?: string[];
  };
};
```

下载类例外：

```http
GET /exports/:id/download
```

直接返回 HTML/PDF 文件内容，不包 envelope。

---

# 2. 前端请求头契约

前端 `apiRequest` 对非 GET 请求会自动带：

```http
Content-Type: application/json
Accept: application/json
Idempotency-Key: <generated>
```

开发模式可能带：

```http
x-user-id: <dev user id>
```

后端要求：

1. 所有 mutating JSON routes 支持 `Idempotency-Key`。
2. `POST /copilot/chat/stream` 是 SSE，不支持 `Idempotency-Key`。
3. SSE 请求不得被普通 `apiRequest` 调用，应使用 fetch stream。

---

# 3. Active Asset Context Contract（最高优先级）

这是本项目最容易出错的部分。所有“当前这条经历 / 当前 JD / 当前简历条目 / 当前生成版本”的操作，都不能只靠自然语言推断，必须通过 `clientState` 传当前资产上下文。

## 3.1 clientState 标准结构

```ts
type CopilotClientState = {
  locale?: "zh-CN" | "en";

  mainMode?:
    | "chat"
    | "experience_library"
    | "experience_detail"
    | "jd_library"
    | "jd_detail"
    | "resume_library"
    | "resume_detail"
    | "generation_history"
    | "file_history"
    | "export_history";

  activeSessionId?: string;

  activeExperienceId?: string;
  activeJDId?: string;
  activeResumeId?: string;
  activeResumeItemId?: string;
  activeVariantId?: string;
  activeEvidenceId?: string;
  activeImportJobId?: string;
  activeCandidateIds?: string[];

  selectedText?: string;
  selectedSection?: string;

  visibleArtifactTypes?: Array<
    | "experience"
    | "jd"
    | "resume"
    | "resume_item"
    | "variant"
    | "generation"
    | "evidence"
    | "file"
    | "import_candidate"
  >;
  visibleArtifactIds?: string[];

  intentSource?: "composer" | "sidebar" | "artifact_action" | "asset_detail" | "system";
  sourceComponent?: string;
};
```

## 3.2 前端进入详情态的强制动作

### 打开经历详情

```ts
const detail = await getExperience(id);
mainMode.openExperienceDetail(id, detail.experience.title);
mainMode.cacheExperience(detail);
```

禁止只执行：

```ts
mainMode.cacheExperience(detail);
sendPrompt("请基于这条经历给我建议...");
```

### 打开 JD 详情

```ts
const jd = await getJD(id);
mainMode.openJDDetail(id, jd.title || jd.targetRole || "JD 详情");
mainMode.cacheJD(jd);
```

### 打开简历详情

```ts
const resume = await getResume(id);
mainMode.openResumeDetail(id, resume.title || "简历详情");
mainMode.cacheResume(resume);
```

### 选择简历条目

```ts
mainMode.setActiveResume(item.resumeId, item.id);
mainMode.setSelection({
  text: item.contentSnapshot,
  section: item.sectionType,
});
```

### 选择生成版本

```ts
mainMode.setActiveVariant(variant.id);
```

### 选择证据

```ts
mainMode.setActiveEvidence(evidenceId); // 如果没有该方法，需要新增
```

## 3.3 后端 action id fallback 规则

后端处理 `/copilot/actions` 时，所有 id 必须按以下顺序解析：

1. `action.payload.xxxId`
2. `action.variantId`
3. `clientState.activeXXXId`
4. `activeAssetContext.xxx?.id`
5. `workspace.xxxId`
6. `workspace.activeXXXId`
7. 无法解析时，返回 `needs_input`

后端禁止把缺 id 暴露为底层 schema error。

### 3.3.1 rewrite_experience

```ts
experienceId =
  payload.experienceId
  ?? clientState.activeExperienceId
  ?? activeAssetContext.activeExperience?.id
  ?? workspace.activeExperienceId;

content =
  payload.content
  ?? payload.instruction
  ?? payload.selectedText
  ?? clientState.selectedText
  ?? activeAssetContext.activeExperience?.currentRevision?.content;
```

缺 `experienceId`：

```json
{
  "status": "needs_input",
  "missingInputs": ["experienceId"],
  "message": "请先选择一条经历，或打开经历详情后再让我改写。"
}
```

缺 `content/instruction`：

```json
{
  "status": "needs_input",
  "missingInputs": ["content"],
  "message": "请说明你想如何改写这条经历，或先选中要改写的内容。"
}
```

### 3.3.2 optimize_resume_item

```ts
resumeItemId =
  payload.resumeItemId
  ?? clientState.activeResumeItemId
  ?? activeAssetContext.activeResumeItem?.id;

resumeId =
  payload.resumeId
  ?? clientState.activeResumeId
  ?? workspace.resumeId
  ?? activeAssetContext.activeResume?.id;

selectedText =
  payload.selectedText
  ?? payload.instruction
  ?? clientState.selectedText
  ?? activeAssetContext.activeResumeItem?.contentSnapshot;
```

缺 `resumeItemId`：

```json
{
  "status": "needs_input",
  "missingInputs": ["resumeItemId"],
  "message": "请先选择一条简历内容，再让我优化。"
}
```

### 3.3.3 generate_from_jd

```ts
jdId =
  payload.jdId
  ?? clientState.activeJDId
  ?? workspace.jdId
  ?? activeAssetContext.activeJD?.id;

jdText =
  payload.jdText
  ?? activeAssetContext.activeJD?.rawText
  ?? clientState.selectedText;
```

缺 `jdId` 且缺 `jdText`：

```json
{
  "status": "needs_input",
  "missingInputs": ["jdId", "jdText"],
  "message": "请先选择或粘贴一段 JD。"
}
```

### 3.3.4 show_evidence

```ts
evidenceId =
  payload.evidenceId
  ?? clientState.activeEvidenceId;

variantId =
  payload.variantId
  ?? action.variantId
  ?? clientState.activeVariantId
  ?? workspace.activeVariantId;

generationId =
  payload.generationId
  ?? workspace.productGenerationId;
```

缺可定位对象：

```json
{
  "status": "needs_input",
  "missingInputs": ["evidenceId", "variantId", "generationId"],
  "message": "请先选择一个生成版本或证据项。"
}
```

### 3.3.5 export_resume

```ts
resumeId =
  payload.resumeId
  ?? clientState.activeResumeId
  ?? workspace.resumeId
  ?? workspace.activeResume?.id
  ?? activeAssetContext.activeResume?.id;
```

缺 `resumeId`：

```json
{
  "status": "needs_input",
  "missingInputs": ["resumeId"],
  "message": "请先打开一份简历，再进行导出。"
}
```

### 3.3.6 accept / reject / prefer variant

```ts
variantId =
  payload.variantId
  ?? action.variantId
  ?? clientState.activeVariantId
  ?? workspace.activeVariantId;

generationId =
  payload.generationId
  ?? workspace.productGenerationId;
```

缺 `variantId`：

```json
{
  "status": "needs_input",
  "missingInputs": ["variantId"],
  "message": "请先选择一个生成版本。"
}
```

缺 `generationId` 且动作需要写入生成历史：

```json
{
  "status": "needs_input",
  "missingInputs": ["generationId"],
  "message": "当前生成记录缺失，请重新生成后再保存。"
}
```

---

# 4. Product API 契约

## 4.1 Experiences

### GET `/product/experiences?limit=100`

返回：

```ts
type ProductExperience = {
  id: string;
  userId?: string;
  category: "work" | "project" | "education" | "award" | "skill" | "other";
  title: string;
  organization?: string;
  role?: string;
  tags: string[];
  status: "active" | "archived" | "deleted" | string;
  currentRevisionId?: string;
  content?: string;
  createdAt: string;
  updatedAt: string;
};
```

### POST `/product/experiences`

请求：

```ts
{
  title: string;
  content: string;
  category?: "work" | "project" | "education" | "award" | "skill" | "other";
  organization?: string;
  role?: string;
  tags?: string[];
}
```

目标返回契约：

```ts
type CreateExperienceResponse = {
  experience: ProductExperience;
  revision: ProductExperienceRevision;
};
```

兼容要求：

- 如果后端历史上直接返回 `ProductExperience`，前端要兼容。
- 但目标契约应统一为 `{ experience, revision }`，因为创建经历本质会同时创建 revision。

### GET `/product/experiences/:id`

返回：

```ts
type ProductExperienceDetail = {
  experience: ProductExperience;
  revisions: ProductExperienceRevision[];
  variants?: ProductExperienceVariant[];
};
```

### PATCH `/product/experiences/:id`

只改元信息，不直接改正文。

请求：

```ts
{
  title?: string;
  organization?: string;
  role?: string;
  tags?: string[];
  category?: ProductExperienceCategory;
}
```

返回：

```ts
ProductExperience
```

### POST `/product/experiences/:id/revisions`

保存经历正文新版本。前端“改写经历后保存”必须走它。

请求：

```ts
{
  content: string;
  source?: "manual" | "import" | "copilot" | "resume_upload";
  structured?: unknown;
}
```

返回：

```ts
ProductExperienceRevision
```

额外要求：

- 创建 revision 后，后端必须把 experience.currentRevisionId 更新为新 revision id。
- 前端保存后必须重新拉取 `/product/experiences/:id` 或本地更新 activeExperience。

### POST `/product/experiences/:id/variants`

请求：

```ts
{
  revisionId: string;
  content: string;
  variantType?: "full" | "medium" | "short" | "jd_tailored" | "custom";
  language?: "zh" | "en";
  targetJdId?: string;
}
```

返回：

```ts
ProductExperienceVariant
```

---

## 4.2 Imports

### POST `/product/imports/text`

目标请求：

```ts
{
  rawText: string;
  source?: "composer" | "manual" | "paste" | string;
}
```

兼容请求：

```ts
{
  text: string;
  source?: string;
}
```

后端必须兼容：

```ts
const rawText = body.rawText ?? body.text;
```

返回：

```ts
type ProductImportDetail = {
  job: {
    id: string;
    status: "pending" | "extracting" | "candidates_ready" | "confirmed" | "failed" | string;
    errorMessage?: string;
  };
  candidates: ProductImportCandidate[];
};
```

### POST `/product/imports/file`

请求：

```ts
{
  fileId: string;
}
```

返回：

```ts
{
  job: {
    id: string;
    status: string;
  };
}
```

后台 job 完成后必须在 `job.output.importJobId` 中写入真实 import job id：

```ts
type BackgroundJobOutputForImportFile = {
  importJobId: string;
  candidateCount?: number;
};
```

### GET `/product/imports/:id`

返回：

```ts
ProductImportDetail
```

### POST `/product/import-candidates/:id/accept`

返回：

```ts
{
  candidate: ProductImportCandidate;
  experience: ProductExperience;
}
```

前端必须在 accept 后刷新：

- sidebar
- experience list
- active candidate status

### POST `/product/import-candidates/:id/reject`

返回：

```ts
ProductImportCandidate
```

---

## 4.3 JDs

### GET `/product/jds?limit=100`

返回：

```ts
ProductJDRecord[]
```

### POST `/product/jds`

请求：

```ts
{
  rawText: string;
  title?: string;
  company?: string;
  targetRole?: string;
}
```

兼容请求：

```ts
{
  jdText: string;
  title?: string;
  company?: string;
  targetRole?: string;
}
```

返回：

```ts
type ProductJDRecord = {
  id: string;
  userId?: string;
  title: string;
  company?: string;
  targetRole?: string;
  rawText: string;
  requirements?: unknown;
  createdAt: string;
  updatedAt: string;
};
```

前端要求：

- 粘贴 JD 后，如果用户选择保存，必须先调用 `POST /product/jds`。
- 保存成功后执行：
  - `mainMode.openJDDetail(jd.id, jd.title || jd.targetRole || "JD 详情")`
  - `mainMode.cacheJD(jd)`
  - 刷新 sidebar / JD list。

### GET `/product/jds/:id`

返回：

```ts
ProductJDRecord
```

---

## 4.4 Resumes

### GET `/product/resumes?limit=100`

返回：

```ts
ProductResume[]
```

### POST `/product/resumes`

请求：

```ts
{
  title?: string;
  targetRole?: string;
  jdId?: string;
}
```

返回：

```ts
ProductResume
```

### GET `/product/resumes/:id`

返回：

```ts
type ProductResumeDetail = ProductResume & {
  items: ProductResumeItem[];
};
```

前端打开简历详情必须执行：

```ts
const resume = await getResume(id);
mainMode.openResumeDetail(id, resume.title || "简历详情");
mainMode.cacheResume(resume);
```

### POST `/product/resumes/:id/items`

请求：

```ts
{
  title: string;
  contentSnapshot: string;
  sectionType?: "experience" | "education" | "project" | "skill" | "award" | "summary" | "other";
  sourceExperienceId?: string;
  sourceVariantId?: string;
  sourceArtifactId?: string;
}
```

返回：

```ts
ProductResumeItem
```

### PATCH `/product/resume-items/:id`

请求：

```ts
{
  title?: string;
  contentSnapshot?: string;
  hidden?: boolean;
  pinned?: boolean;
}
```

返回：

```ts
ProductResumeItem
```

### POST `/product/resumes/:id/reorder`

请求：

```ts
{
  orderedIds: string[];
}
```

返回：

```ts
ProductResumeItem[]
```

---

## 4.5 Generations

### POST `/product/generations/from-jd`

资产面板“基于 JD 生成简历”必须优先走这个直接 Product API，而不是 Copilot Action。

请求：

```ts
{
  jdId?: string;
  jdText?: string;
  targetRole?: string;
}
```

至少需要 `jdId` 或 `jdText`。

返回：

```ts
type GenerationFromJdResponse = {
  generationId: string;
  jd: ProductJDRecord;
  variants: ProductVariant[];
  generation: ProductGeneration;
};
```

注意：后端内部 `ProductGeneratedVariant` 与前端展示用 `ProductVariant` 不完全一致。此接口必须直接返回前端展示所需的 `ProductVariant[]`，不能只返回内部 `ProductGeneratedVariant[]`。

目标 `ProductVariant`：

```ts
type ProductVariant = {
  id: string;
  artifactId: string | null;
  title: string;
  content: string;
  role: "recommended" | "alternative" | "safe" | "quantified" | "experimental" | string;
  status: "ready" | "needs_confirmation" | "unsafe" | "accepted" | "rejected" | string;
  score?: {
    overall?: number;
    relevance?: number;
    clarity?: number;
    evidenceStrength?: number;
    quantifiedImpact?: number;
  };
  badges?: Array<{ label: string; tone: "neutral" | "positive" | "warning" | "danger" | string }>;
  reason?: string;
  evidenceSummary?: {
    coverageLabel: string;
    items: Array<{
      id: string;
      title: string;
      quote?: string;
      explanation: string;
      confidence?: number;
    }>;
  };
  riskSummary?: {
    level: string;
    unsupportedClaims: string[];
    missingEvidence: string[];
    warnings: string[];
  };
  missingInfo?: string[];
  sourceExperienceIds?: string[];
  sourceEvidenceIds?: string[];
  actions?: ProductAction[];
  raw?: Record<string, unknown>;
  createdAt?: string;
};
```

前端收到后必须更新：

```ts
chat.workspace = {
  ...chat.workspace,
  productGenerationId: generationId,
  jdId: jd.id,
  activeVariantId: variants[0]?.id,
  variants,
  status: "ready",
  activePanel: "variants",
};
mainMode.setActiveJD(jd.id);
mainMode.setActiveVariant(variants[0]?.id || "");
```

### GET `/product/generations?limit=100`

返回：

```ts
ProductGeneration[]
```

### GET `/product/generations/:id`

目标返回：

```ts
type ProductGenerationDetail = ProductGeneration & {
  jd?: ProductJDRecord;
  resume?: ProductResumeDetail | ProductResume;
  variants: ProductVariant[];
};
```

兼容要求：

- 如果历史上只返回 `outputSnapshot.variants`，前端可 fallback。
- 但目标契约必须显式返回 `variants`。

### POST `/product/generations/:id/accept-variant`

请求：

```ts
{
  variantId: string;
  resumeId?: string;
}
```

返回：

```ts
type AcceptVariantResponse = {
  generation: ProductGeneration;
  resume: ProductResumeDetail;
  item: ProductResumeItem;
  variant: ProductVariant;
};
```

当前后端若只返回 `resume` 是不够的，目标契约应包含 `generation/item/variant`，便于前端更新 UI。

---

# 5. Files API 契约

### POST `/files/upload`

请求：

```ts
{
  fileName: string;
  mimeType: string;
  base64: string;
}
```

返回：

```ts
type UploadedFile = {
  id: string;
  userId?: string;
  originalName: string;
  name?: string;
  mimeType: string;
  sizeBytes: number;
  status?: string;
  parserStatus?: string;
  parserError?: string;
  createdAt: string;
  updatedAt: string;
};
```

### GET `/files?limit=100`

返回：

```ts
UploadedFile[]
```

### GET `/files/:id`

返回：

```ts
UploadedFile
```

### POST `/files/:id/parse`

返回：

```ts
{
  job: {
    id: string;
    status: string;
  };
}
```

job 完成后必须可通过 `/jobs/:id` 读取到：

```ts
{
  status: "completed";
  output: {
    parsedDocumentId: string;
    fileId: string;
  };
}
```

### GET `/files/:id/parsed-document`

返回：

```ts
type ParsedDocument = {
  id: string;
  fileId: string;
  text: string;
  parserStatus: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
};
```

---

# 6. Jobs API 契约

### GET `/jobs?limit=100`

返回：

```ts
BackgroundJob[]
```

### GET `/jobs/:id`

返回：

```ts
type BackgroundJob = {
  id: string;
  userId?: string;
  type: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  progress?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};
```

### POST `/jobs/:id/cancel`

返回：

```ts
BackgroundJob
```

---

# 7. Exports API 契约

### POST `/exports/resumes/:resumeId`

请求：

```ts
{
  format: "html" | "pdf";
  templateId?: string;
}
```

返回：

```ts
type CreateExportResponse = {
  exportRecord: ResumeExport;
  job?: BackgroundJob;
};
```

### GET `/exports?limit=100`

返回：

```ts
ResumeExport[]
```

### GET `/exports/:id`

返回：

```ts
ResumeExport
```

### GET `/exports/:id/download`

返回 raw file，不包 envelope。

---

# 8. Copilot Chat API 契约

## 8.1 POST `/copilot/chat`

请求：

```ts
type CopilotChatInput = {
  sessionId?: string;
  message: string;
  resumeText?: string;
  jdText?: string;
  targetRole?: string;
  clientState?: CopilotClientState;
};
```

返回：

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

后端要求：

1. 不暴露 chain-of-thought。
2. 不暴露 provider raw payload。
3. 不暴露 system prompt。
4. 不暴露 API key。
5. `raw.toolResults` 可保留 sanitized summary，但不能泄漏内部敏感参数。

## 8.2 POST `/copilot/chat/stream`

请求同 `/copilot/chat`。

SSE event 固定格式：

```sse
event: agent.turn.started
data: {"type":"agent.turn.started","sessionId":"...","turnId":"...","createdAt":"...","label":"开始处理请求","status":"running"}

event: agent.completed
data: {"type":"agent.completed","response": CopilotChatResponse}
```

后端必须保证 completed event 至少满足：

```ts
{
  type: "agent.completed";
  response: CopilotChatResponse;
}
```

前端可兼容 `payload.response`，但后端目标契约固定用 `response`。

---

# 9. Copilot Actions 契约

## 9.1 POST `/copilot/actions`

请求：

```ts
type CopilotActionInput = {
  sessionId: string;
  turnId?: string;
  action: {
    type: ProductActionType;
    variantId?: string;
    payload?: Record<string, unknown>;
  };
  clientState?: CopilotClientState;
};
```

返回：

```ts
CopilotChatResponse
```

`raw.actionResults` 必须包含每个 action 的产品语义状态：

```ts
type CopilotActionResult = {
  actionType?: string;
  status: "success" | "needs_input" | "needs_confirmation" | "failed";
  message?: string;
  reason?: string;
  pendingActionId?: string;
  missingInputs?: string[];
  exportRecord?: CopilotExportRecord;
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

## 9.2 支持的 action type

```ts
type ProductActionType =
  | "accept"
  | "reject"
  | "prefer"
  | "confirm_metric"
  | "revise_more_conservative"
  | "revise_more_quantified"
  | "show_evidence"
  | "explain_choice"
  | "generate_from_jd"
  | "optimize_resume_item"
  | "rewrite_experience"
  | "export_resume";
```

后端必须支持以上 action type。暂不实现业务的，也必须返回 `needs_input` 或 `failed` 的产品语义结果，不能返回 unsupported action，除非该 action type 完全不在枚举内。

---

## 9.3 generate_from_jd

映射到 tool：

```ts
generate_resume_from_jd
```

默认写操作需要确认：

第一次返回：

```json
{
  "status": "needs_confirmation",
  "actionType": "generate_resume_from_jd",
  "pendingActionId": "..."
}
```

确认后返回：

```json
{
  "status": "success",
  "actionType": "generate_resume_from_jd",
  "variantId": "...",
  "metadata": {
    "generationId": "...",
    "variantCount": 1
  }
}
```

workspace 必须包含：

```ts
{
  productGenerationId: string;
  jdId: string;
  activePanel: "variants";
  activeVariantId: string;
  variants: ProductVariant[];
  status: "ready";
}
```

---

## 9.4 rewrite_experience

前端 action：

```ts
{
  type: "rewrite_experience",
  payload: {
    experienceId?: string;
    instruction?: string;
    selectedText?: string;
    content?: string;
  }
}
```

后端行为：

1. 解析 experienceId，使用 fallback 规则。
2. 如果缺 experienceId，返回 `needs_input`。
3. 先生成 rewrittenText 或 revision preview。
4. 写入数据库前必须 pending confirmation。
5. 确认后调用 `update_experience` 或 `create_experience_revision`。
6. 成功后创建 revision，不直接覆盖旧 revision。

返回 actionResult：

```json
{
  "status": "needs_confirmation",
  "actionType": "rewrite_experience",
  "pendingActionId": "...",
  "revisionSuggestion": {
    "kind": "experience",
    "sourceId": "pexp-...",
    "sourceTextPreview": "...",
    "rewrittenText": "...",
    "usedModel": true
  }
}
```

确认后：

```json
{
  "status": "success",
  "actionType": "rewrite_experience",
  "revisionSuggestion": {
    "kind": "experience",
    "sourceId": "pexp-...",
    "rewrittenText": "..."
  },
  "metadata": {
    "experienceId": "pexp-...",
    "revisionId": "pexprev-..."
  }
}
```

---

## 9.5 optimize_resume_item

前端 action：

```ts
{
  type: "optimize_resume_item",
  payload: {
    resumeId?: string;
    resumeItemId?: string;
    selectedText?: string;
    instruction?: string;
  }
}
```

后端当前 `revise_resume_item` 不能简单把 `instruction` 写进 `contentSnapshot`。目标行为：

1. 读取原 resume item。
2. 使用模型或规则生成 rewrittenText。
3. 返回 confirmation preview。
4. 用户确认后更新 `contentSnapshot`。

第一次返回：

```json
{
  "status": "needs_confirmation",
  "actionType": "optimize_resume_item",
  "pendingActionId": "...",
  "revisionSuggestion": {
    "kind": "resume_item",
    "sourceId": "presitem-...",
    "sourceTextPreview": "...",
    "rewrittenText": "...",
    "usedModel": true
  }
}
```

确认后：

```json
{
  "status": "success",
  "actionType": "optimize_resume_item",
  "revisionSuggestion": {
    "kind": "resume_item",
    "sourceId": "presitem-...",
    "rewrittenText": "..."
  }
}
```

---

## 9.6 show_evidence / explain_choice

目标行为：

- 如果传 `evidenceId`，返回该 evidence。
- 如果传 `variantId` + `generationId`，返回该 variant 的 evidenceSummary、sourceExperienceIds、sourceEvidenceIds、riskSummary。
- 如果没有真实证据，不得静默返回空数组，应返回明确提示。

成功返回：

```json
{
  "status": "success",
  "actionType": "show_evidence",
  "evidenceId": "...",
  "variantId": "...",
  "metadata": {
    "evidence": [],
    "sourceExperienceIds": [],
    "sourceEvidenceIds": [],
    "riskSummary": {}
  }
}
```

无证据但定位成功：

```json
{
  "status": "success",
  "actionType": "show_evidence",
  "message": "当前版本暂无可展示证据，请先补充经历素材或重新生成。",
  "metadata": {
    "empty": true
  }
}
```

定位失败：

```json
{
  "status": "needs_input",
  "actionType": "show_evidence",
  "missingInputs": ["variantId", "generationId"],
  "message": "请先选择一个生成版本或证据项。"
}
```

---

## 9.7 export_resume

写操作需要确认。

第一次返回：

```json
{
  "status": "needs_confirmation",
  "actionType": "export_resume",
  "pendingActionId": "..."
}
```

确认后：

```json
{
  "status": "success",
  "actionType": "export_resume",
  "exportRecord": {
    "id": "...",
    "resumeId": "...",
    "format": "html",
    "status": "pending",
    "jobId": "..."
  }
}
```

---

## 9.8 accept / reject / prefer

### accept

优先走 Product API：

```http
POST /product/generations/:id/accept-variant
```

但如果前端走 `/copilot/actions`，后端也必须支持：

```json
{
  "type": "accept",
  "variantId": "pvar-...",
  "payload": {
    "generationId": "pgen-...",
    "resumeId": "pres-..."
  }
}
```

成功返回：

```json
{
  "status": "success",
  "actionType": "accept",
  "variantId": "pvar-...",
  "metadata": {
    "generationId": "pgen-...",
    "resumeId": "pres-...",
    "resumeItemId": "presitem-..."
  }
}
```

### reject / prefer

可以先只更新 workspace，不入库：

```json
{
  "status": "success",
  "actionType": "reject",
  "variantId": "pvar-..."
}
```

---

# 10. Pending Actions 契约

### GET `/copilot/pending-actions?sessionId=...`

返回：

```ts
PendingAction[]
```

### POST `/copilot/pending-actions/:id/confirm`

返回：

```ts
CopilotChatResponse
```

确认后：

- `raw.actionResults` 必须有最终 action result。
- 如果是生成简历，workspace.variants 必须非空。
- 如果是 export，actionResult.exportRecord 必须存在。
- 如果是 rewrite/optimize，actionResult.revisionSuggestion 必须存在。

### POST `/copilot/pending-actions/:id/cancel`

返回：

```ts
PendingAction | CopilotChatResponse
```

目标建议统一返回：

```ts
PendingAction
```

前端可以继续兼容两种。

---

# 11. Auth API 契约

### GET `/auth/me`

返回：

```ts
{
  user: {
    id: string;
    email?: string;
    displayName?: string;
    roles?: string[];
  }
}
```

### POST `/auth/dev-login`

请求：

```ts
{
  email: string;
  displayName?: string;
}
```

返回：

```ts
{
  user: User;
}
```

### POST `/auth/logout`

返回：

```ts
{
  loggedOut: true;
}
```

---

# 12. DeepSeek V4 Pro 接入契约

后端环境变量目标：

```env
AGENT_PROVIDER=deepseek
AGENT_MODEL=deepseek-v4-pro
AGENT_BASE_URL=https://api.deepseek.com
AGENT_API_KEY=...
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=llm
ARTIFACT_GENERATOR_MODE=llm
CRITIC_AGENT_MODE=llm
REVISION_AGENT_MODE=llm
ALLOW_MOCK_RUNTIME=false
ALLOW_DETERMINISTIC_RUNTIME=false
```

调用约束：

1. DeepSeek 的 reasoning/thinking 内容不得返回给前端。
2. 后端只保存和返回最终用户可见结果、工具结果摘要和安全 trace。
3. JSON 输出必须 schema validate。
4. 模型失败时必须转为产品错误，不得抛出 provider raw error。
5. 缺参数时优先 `needs_input`，不是让 LLM 自己瞎猜 id。

---

# 13. 前端必须修复的点

## P0

1. `importFromText` 改为发送 `{ rawText: text, source }`。
2. 增加 `createExperienceRevision` / `updateExperienceContent` API wrapper。
3. 打开经历/JD/简历详情时必须调用 `openExperienceDetail/openJDDetail/openResumeDetail`。
4. `rewriteActiveExperience` 必须确保 `activeExperienceId` 存在，否则前端先提示用户选择经历。
5. `optimizeActiveResumeItem` 必须确保 `activeResumeItemId` 和 selectedText 存在。
6. 资产面板“基于 JD 生成”按钮直接走 `generateFromJD({ jdId })`，不要依赖 Copilot confirmation。
7. 生成成功后必须写入 chat.workspace / mainMode。
8. 修复中文乱码。

## P1

1. Composer 粘贴 JD 增加“保存 JD”流程。
2. show evidence 需要传 `variantId/generationId/evidenceId`。
3. accept variant 优先 Product API，fallback Copilot Action 时 payload 必须带 generationId。
4. Pending action confirmation 后，按 action type 做 UI merge。
5. 补 activeEvidenceId。
6. 统一 workspace `activePanel` 枚举。

---

# 14. 后端必须修复的点

## P0

1. `/product/imports/text` 兼容 `rawText` 和 `text`。
2. `/copilot/actions` 支持 `rewrite_experience`。
3. `/copilot/actions` 支持 `accept/reject/prefer`，至少不要 unsupported。
4. 所有 explicit action 实现 id fallback。
5. 缺 id 返回 `needs_input` 产品语义，不返回 schema error。
6. `ProductGeneration/from-jd` 返回前端可展示的 `ProductVariant[]`，不是内部 variant。
7. `/product/generations/:id` 显式返回 `variants`。
8. `accept-variant` 返回 `{ generation, resume, item, variant }`。
9. `revise_resume_item` 不能把 instruction 原样写入 contentSnapshot，必须生成 rewrittenText 或至少把 selectedText + instruction 区分开。
10. `show_evidence` 不能静默空数组。

## P1

1. workspace patch 加入 `activeExperienceId` / `activeJDId` / `activeResumeItemId` 等字段。
2. pending action result 中必须带 `pendingActionId`。
3. confirm 后 raw.actionResults 必须保留最终 action result。
4. SSE completed event 固定 `data.response`。
5. background job output 结构固定。

---

# 15. 契约测试清单

## 后端测试

1. `POST /product/imports/text` 接受 `{ rawText }`。
2. `POST /product/imports/text` 接受 `{ text }`。
3. `POST /product/experiences/:id/revisions` 创建 revision 后，`GET /product/experiences/:id` 能看到新 revision。
4. `/copilot/actions rewrite_experience` 无 `experienceId` 时返回 `needs_input`，不是 unsupported。
5. `/copilot/actions rewrite_experience` 有 `activeExperienceId` 时创建 pending action。
6. confirm rewrite 后创建 revision。
7. `/copilot/actions optimize_resume_item` 无 `resumeItemId` 时返回 `needs_input`。
8. `/copilot/actions generate_from_jd` 可从 `clientState.activeJDId` fallback。
9. confirm generate 后 workspace.variants 非空。
10. `/product/generations/from-jd` 返回 `generationId/jd/variants/generation`。
11. `/product/generations/:id` 返回 `variants`。
12. `/product/generations/:id/accept-variant` 返回 `generation/resume/item/variant`。
13. `/copilot/actions show_evidence` 不再静默空数组。
14. `/exports/resumes/:resumeId` 返回 exportRecord 和 job。
15. `/copilot/chat/stream` completed event 包含 `response`。

## 前端测试 / 手工验证

1. 登录成功。
2. 打开经历库。
3. 粘贴一段经历并导入候选。
4. 接受候选后经历库出现新经历。
5. 点击经历，进入经历详情，`activeExperienceId` 存在。
6. 在经历详情说“帮我改写这条经历”，请求带 `clientState.activeExperienceId`。
7. 保存改写后，revision 列表增加。
8. 粘贴 JD 并保存，`activeJDId` 存在。
9. 资产面板点击“基于 JD 生成”，直接出现 variants。
10. 选择 variant，`activeVariantId` 存在。
11. 接受 variant 后生成/打开简历，`activeResumeId` 存在。
12. 选择简历条目，`activeResumeItemId` 和 `selectedText` 存在。
13. 点击优化条目，不再报缺 resumeItemId。
14. 导出简历，能看到 export record。
15. 下载 HTML/PDF 正常。
16. 所有中文错误提示无乱码。

---

# 16. 后端 Claude Code Prompt

```text
当前只操作后端仓库：cv-agent。不要修改任何前端文件。

请先阅读本契约文档 coolto_frontend_backend_contract_v2.md，并严格以它作为本次修复的唯一接口契约。

目标：修复 cv-agent 与 cv_agent_frontend 的产品接口和 Copilot Action 不一致问题，尤其是经历导入、经历改写、JD 输入、生成简历、缺少 id、pending action、variant 保存、证据查看等链路。

必须完成 P0：

1. 修复 POST /product/imports/text：
   - 同时接受 body.rawText 和 body.text。
   - rawText 优先，text 兼容。
   - 不允许再因为前端发送 text 报 rawText is required。

2. 修复经历正文 revision 契约：
   - 确认 POST /product/experiences/:id/revisions 可创建 revision。
   - 创建 revision 后必须更新 experience.currentRevisionId。
   - GET /product/experiences/:id 返回 { experience, revisions, variants? }。
   - 如当前缺 variants 可先返回空数组或不返回，但 revisions 必须稳定。

3. 修复 /copilot/actions explicit action：
   - AgentOrchestrator.mapExplicitAction 必须支持：
     - rewrite_experience
     - accept
     - reject
     - prefer
     - generate_from_jd
     - optimize_resume_item
     - show_evidence / explain_choice
     - export_resume
   - 不允许前端枚举内 action 返回 unsupported action。

4. 实现 Active Asset Context fallback：
   所有 action 解析 id 必须按顺序读取：
   - action.payload.xxxId
   - action.variantId
   - clientState.activeXXXId
   - activeAssetContext.xxx?.id
   - workspace.xxxId / workspace.activeXXXId
   - 仍缺失则返回 actionResult.status=needs_input

5. 缺 id 不得抛 schema error：
   - rewrite_experience 缺 experienceId 返回：
     “请先选择一条经历，或打开经历详情后再让我改写。”
   - optimize_resume_item 缺 resumeItemId 返回：
     “请先选择一条简历内容，再让我优化。”
   - generate_from_jd 缺 jdId/jdText 返回：
     “请先选择或粘贴一段 JD。”
   - export_resume 缺 resumeId 返回：
     “请先打开一份简历，再进行导出。”
   - show_evidence 缺定位对象返回：
     “请先选择一个生成版本或证据项。”

6. rewrite_experience：
   - 映射到 update_experience 或新增 create_experience_revision / rewrite_experience tool。
   - 写入前必须 pending confirmation。
   - 确认后创建 ProductExperienceRevision，source=copilot。
   - actionResult 必须包含 revisionSuggestion 和 metadata.experienceId/revisionId。

7. optimize_resume_item：
   - 不能把 instruction 原样写进 contentSnapshot。
   - 必须区分 sourceText/selectedText 与 instruction。
   - 先生成 rewrittenText 或至少构造明确的 rewrittenText preview。
   - 写入前 pending confirmation。
   - 确认后 PATCH resume item contentSnapshot。
   - actionResult 必须包含 revisionSuggestion。

8. generate_from_jd：
   - 继续支持 pending confirmation。
   - 能从 clientState.activeJDId fallback。
   - confirm 后 workspace.variants 必须非空。
   - raw.actionResults 必须包含 generationId 和 variantCount。

9. Product generation API：
   - POST /product/generations/from-jd 返回：
     { generationId, jd, variants, generation }
   - variants 必须是前端 ProductVariant[]，不是内部 ProductGeneratedVariant[]。
   - GET /product/generations/:id 显式返回 variants。
   - POST /product/generations/:id/accept-variant 返回：
     { generation, resume, item, variant }

10. show_evidence：
    - 不要静默返回空 evidence。
    - 如果能通过 variantId/generationId 找到 variant，就返回 evidenceSummary/sourceExperienceIds/sourceEvidenceIds/riskSummary。
    - 如果没有证据，返回 success + message “当前版本暂无可展示证据...”。
    - 如果无法定位，返回 needs_input。

11. Pending action：
    - needs_confirmation 的 actionResult 必须有 pendingActionId。
    - confirm 后 response.raw.actionResults 必须包含最终 success actionResult。
    - confirm generate/rewrite/optimize/export 后前端能从 response 里恢复结果。

12. SSE：
    - /copilot/chat/stream 的 completed event 固定发送：
      event: agent.completed
      data: { type: "agent.completed", response: CopilotChatResponse }

13. DeepSeek V4 Pro：
    - 支持 AGENT_MODEL=deepseek-v4-pro。
    - 不返回 reasoning_content / chain-of-thought。
    - 所有 LLM JSON 输出必须 schema validate。
    - provider raw error 不得直出给前端。

14. 增加或更新测试：
    - imports text/rawText 兼容
    - experience revisions
    - rewrite_experience needs_input
    - rewrite_experience pending + confirm creates revision
    - optimize_resume_item needs_input
    - generate_from_jd activeJDId fallback + confirm variants
    - generation from-jd variants shape
    - accept-variant response shape
    - show_evidence non-empty semantic response
    - SSE completed response shape

保持：
- envelope { ok, data, meta }
- 不添加数据库 foreign key
- 不泄漏 chain-of-thought、provider raw payload、system prompt、API key、内部敏感 tool arguments

完成后运行：
npm run typecheck
npm run test
```

---

# 17. 前端 Claude Code Prompt

```text
当前只操作前端仓库：cv_agent_frontend。不要修改后端文件。

请先阅读本契约文档 coolto_frontend_backend_contract_v2.md，并严格以它作为本次修复的唯一接口契约。

目标：修复前端与 cv-agent 后端的产品接口和 Copilot Action 对齐问题，尤其是经历导入、经历详情、经历改写、JD 保存、生成简历、缺少 id、pending action、variant 保存、证据查看等链路。

必须完成 P0：

1. 修 src/services/productApi.ts：
   - importFromText 入参可以继续是 { text, source }
   - 请求体必须改为 { rawText: input.text, source: input.source }
   - 保持兼容，不大改 UI 调用点。

2. 增加经历 revision API：
   - createExperienceRevision(id, { content, source, structured? })
   - POST /product/experiences/:id/revisions
   - source 默认 "manual" 或由调用方传 "copilot"。
   - 增加类型 ProductExperienceRevision / ProductExperienceDetail 保持契约。

3. 修经历详情状态：
   - 打开经历时必须：
     const detail = await getExperience(id)
     mainMode.openExperienceDetail(id, detail.experience.title)
     mainMode.cacheExperience(detail)
   - 不得只 cacheExperience 后直接 sendPrompt。
   - 确保 buildCopilotClientState 能带 activeExperienceId。
   - 如果用户点击“改写经历”但没有 activeExperienceId，前端先提示“请先选择一条经历”。

4. 修 JD 详情状态：
   - 打开 JD 时必须：
     const jd = await getJD(id)
     mainMode.openJDDetail(id, jd.title || jd.targetRole || "JD 详情")
     mainMode.cacheJD(jd)
   - 保存 JD 后更新 activeJDId/sidebar/JD list。
   - Composer 粘贴 JD 不要只是插入提示词；至少提供明确“保存 JD”流程，调用 createJD({ rawText })。

5. 修简历详情与条目选择状态：
   - 打开简历时必须：
     const resume = await getResume(id)
     mainMode.openResumeDetail(id, resume.title || "简历详情")
     mainMode.cacheResume(resume)
   - 选择条目时必须设置：
     activeResumeId
     activeResumeItemId
     selectedText
     selectedSection
   - 触发 optimize_resume_item 前检查 resumeItemId 和 selectedText。

6. 基于 JD 生成简历：
   - 资产面板里的“基于 JD 生成”按钮不要默认走 /copilot/actions。
   - 改为直接调用 generateFromJD({ jdId })。
   - 成功后把 response.variants 写入 chat.workspace：
     productGenerationId
     jdId
     variants
     activeVariantId
     activePanel="variants"
     status="ready"
   - 同步 mainMode.activeJDId / activeVariantId。
   - 刷新 generation history/sidebar。
   - 聊天自然语言生成可以继续走 /copilot/chat 或 /copilot/actions。

7. accept variant：
   - 如果 chat.workspace.productGenerationId 存在，优先调用 POST /product/generations/:id/accept-variant。
   - payload 带 variantId 和 resumeId。
   - 成功后更新：
     chat.workspace.activeResume
     chat.workspace.resumeId
     mainMode.cacheResume(result.resume)
     sidebar
   - 如果 fallback 到 Copilot action，payload 必须带 generationId。

8. rewrite_experience Copilot action：
   - buildRewriteExperienceAction 必须带：
     experienceId: contextSnapshot.selectedExperienceId
     selectedText: contextSnapshot.selectedText 或 activeExperience 当前 revision content
     instruction
   - 如果缺 id，不要发请求，先 toast。
   - 如果后端返回 needs_confirmation，展示 pending action。
   - confirm 后如果返回 revisionSuggestion，更新 activeExperience 或重新拉取 getExperience。

9. show evidence：
   - showEvidence 必须带 variantId/evidenceId/generationId 中至少一个。
   - 从 chat.workspace.productGenerationId、activeVariantId fallback。
   - 前端展示“暂无证据”而不是空白。

10. Pending action confirmation：
    - confirm 后按 action type merge UI：
      - generate_resume_from_jd: merge variants
      - rewrite_experience: reload active experience
      - optimize_resume_item: reload active resume
      - export_resume: merge export record
    - 不能只依赖通用 applyCopilotResponse。

11. 修中文乱码：
    - 搜索并替换乱码，例如 “鎿嶄綔澶辫触” -> “操作失败”。

12. 补 activeEvidenceId：
    - 如果 mainMode / clientState 没有 activeEvidenceId，增加。
    - selectEvidence(id) 应设置 activeEvidenceId，而不是把 evidence id 塞进 selectedSection。

13. 类型更新：
    - ProductGenerationDetail 必须显式支持 variants。
    - AcceptVariantResponse 支持 generation/resume/item/variant。
    - CopilotActionResult 支持 missingInputs、revisionSuggestion、exportRecord。
    - 不要用 any 绕过关键字段。

完成后运行：
npm run typecheck
```


---

# 18. 阶段 1–8b 累积新增字段（Phase 9 契约整理）

> 本节由阶段 9（前后端契约整理）落地。汇总阶段 1 到阶段 8b 在主链路（ToolResult / assistantMessage / variants / ResumeExport / qualityReport）上引入的全部**可选、向后兼容**新增字段，方便前端按需逐步接入。
>
> **核心承诺**：
>
> 1. 本节列出的字段全部为 `optional`。前端不读它们，旧链路依然可用。
> 2. 没有任何旧字段被改名、被删除、被重新定义。
> 3. 后端不会因为前端没传新字段而拒绝请求。
> 4. 与本节相关的环境变量都默认关闭；关闭时所有新增字段均为 `undefined`，输出与阶段 1 之前完全一致。

## 18.0 兼容性等级速查

| 标签 | 含义 |
|------|------|
| `optional` | 字段可能为 `undefined`，前端可安全忽略 |
| `legacy-preserved` | 旧字段保持原状，shape 与语义不变 |
| `frontend-recommended` | 建议前端有 UI 容器后接入 |
| `additive-enum` | 既有枚举增加新值，前端遇到未知值需做 fallback |
| `env-gated` | 仅在指定环境变量打开时才会被填充 |

## 18.1 ToolResult 结构化字段（阶段 1）

来源：`src/agent-core/tools/ToolResult.ts`。这些字段位于旧字段 `{status, message, data, workspacePatch, actionResult, pendingActionId, visibility}` 之外，全部为 `optional`：

```ts
type ToolResult = {
  // —— 旧字段（保持不变） ——
  status: "success" | "needs_input" | "failed";
  message?: string;
  data?: unknown;
  workspacePatch?: Record<string, unknown>;
  actionResult?: Record<string, unknown>;
  pendingActionId?: string;
  visibility?: ToolResultVisibility;

  // —— 阶段 1 新增（全部 optional，全部 additive） ——
  resultKind?: string;
  summaryFacts?: string[];
  entities?: Array<{ type: string; id?: string; title?: string; data?: unknown }>;
  evidence?: Array<{ sourceId?: string; claim?: string; support?: string; confidence?: number }>;
  warnings?: string[];
  nextActionHints?: Array<{ type: string; label: string; payload?: Record<string, unknown> }>;
};
```

`resultKind` 常见取值：`generation_completed` / `match_completed` / `export_pending` / `export_ready` / `variant_accepted` / `needs_input`。

前端可见入口：
- `CopilotChatResponse.raw.toolResults[]`：完整 ToolResult 数组（含上述 6 个新字段）。
- `assistantMessage.metadata.displaySnapshot.toolResults[]`：display snapshot 精简版。

接入建议：阶段 1 字段对前端 UI 来说完全可选——它们主要服务于阶段 2 的 Narrator 自动撰文。前端如要在调试面板里展示，可优先展示 `resultKind` + `nextActionHints[].label` 作为"快捷回复 chip"。

## 18.2 Narrator 自然语言回复（阶段 2）

仅运行时行为变化，**没有 schema 变化**。当 `ENABLE_NARRATOR=true` 且 Narrator 模型客户端已注入时，4 个 success 分支（`generation_completed` / `match_completed` / `variant_accepted` / `export_ready`）的 `assistantMessage.content` 会基于 §18.1 的结构化字段动态撰文，而不再是模板字符串。失败分支与 `needs_confirmation` 分支保持模板字符串不变。

兼容性：`legacy-preserved`。前端继续把 `assistantMessage.content` 当作不透明的自然语言文本展示在聊天区即可；`role` / `kind` / `metadata` shape 都没变。

`env-gated`：`ENABLE_NARRATOR`（默认未设置 = 关闭）。关闭时输出与阶段 2 之前**逐字节一致**。

## 18.3 ResumeDocument / variants / accept items（阶段 3）

来源：`src/product/types.ts`。

```ts
type ResumeDocument = {
  schemaVersion: 1;
  sections: ResumeDocumentSection[];
};
type ResumeDocumentSection = {
  id: string;
  type: ProductResumeItem["sectionType"];
  title: string;
  order: number;
  items: ResumeDocumentItem[];
};
type ResumeDocumentItem = {
  id: string;
  title: string;
  subtitle?: string;
  period?: string;
  location?: string;
  bullets: ResumeDocumentBullet[];
  sourceExperienceId?: string;
  evidenceStrength?: "low" | "medium" | "high";
  relevanceScore?: number;
};
type ResumeDocumentBullet = {
  id: string;
  text: string;
  evidenceIds?: string[];
};
```

暴露位置：`ProductGenerationVariant.resumeDocument?: ResumeDocument`。旧字段 `ProductGenerationVariant.content: string`（markdown 全文）保持不变，仍是规范文本来源。

`accept-variant` 请求体新增可选 `items?: ResumeItemSeed[]`：调用方可显式指定要落到 resume 的 items；省略时仍走旧的"从 content 自动派生 items"路径。

导出下载响应的 `Content-Disposition` 现在使用 RFC 5987（`filename*=UTF-8''…`）以正确处理非 ASCII 文件名；旧的 `filename=` 头作为 fallback 同时存在。

`[action]` / `[confirm]` 占位符现在尊重 `clientState.locale`；其他文案不变。

兼容性：`optional`、`legacy-preserved`。

## 18.4 模板钩子（阶段 4）

导出请求体新增可选 `templateId`：

```ts
type ResumeExportRequest = {
  format: "pdf" | "html";
  templateId?: "default" | "one-page-modern" | string;
  // …其他既有可选字段保持不变
};
```

`templateId="default"` 与阶段 4 之前的 HTML 输出**逐字节一致**。

模板可能在 HTML 中输出以下 `data-*` 钩子，供阶段 5 测量与前端高亮使用：

```text
data-template       简历根节点
data-density        简历根节点（"standard" | "compact" | …）
data-section-type   每个 section 元素
data-item-id        每个 item 元素
data-bullet-id      每个 bullet 元素
```

前端如忽略这些属性，渲染行为不变。前端如需在简历预览里做"高亮某条 bullet / 跳转锚点 / 显示 AI 编辑徽章"，建议用 `data-item-id` / `data-bullet-id` 选择器。

兼容性：`optional`、`legacy-preserved`。

## 18.5 ResumeExport.fitReport（阶段 5）

来源：`src/exports/ResumeFitService.ts:31`。仅在导出 `status="completed"` 之后被填充；阶段 5 之前创建的旧 export 该字段为 `undefined`。

```ts
type ResumeFitReport = {
  targetPages: number;
  estimatedPages: number;
  overflowPx: number;
  underflowPx?: number;
  contentHeightPx: number;
  pageUsableHeightPx: number;
  templateId: string;
  density: string;
  measurer: "playwright" | "heuristic";
  measuredAt: string;          // ISO-8601
};
```

兼容性：`optional`、`frontend-recommended`。建议前端做成"折叠的'排版适配'面板"——非必要不展开，避免干扰主流程。

## 18.6 ResumeExport.compressionReport（阶段 6）

来源：`src/exports/ResumeCompressionService.ts:15`。仅在确实跑了规则压缩路径时被填充——`templateId="one-page-modern"` 且 `targetPages=1` 且初始 `overflowPx > 0`。否则为 `undefined`。

```ts
type ResumeCompressionAction =
  | { type: "drop_bullet"; itemId: string; bulletId: string }
  | { type: "shorten_bullet"; itemId: string; bulletId?: string; before: string; after: string }
  | { type: "merge_bullets"; itemId: string; bulletIds: string[]; mergedText: string }
  | { type: "hide_item"; itemId: string; sectionType: string; reason: "low_relevance" }
  | { type: "drop_density"; from: string; to: string };

type ResumeCompressionReport = {
  applied: boolean;
  initialEstimatedPages: number;
  finalEstimatedPages: number;
  initialOverflowPx: number;
  finalOverflowPx: number;
  iterations: number;
  actions: ResumeCompressionAction[];
  densityBefore: string;
  densityAfter: string;
  stillOverflowing: boolean;
  reason: "overflow_resolved" | "no_more_strategies" | "iteration_limit";
};
```

阶段 6 是 warn-only：`stillOverflowing=true` **不会**阻断导出。

兼容性：`optional`、`frontend-recommended`。建议前端用"小字说明"展示，例如："为了适配一页，AI 自动隐藏了 1 条经历的 2 个 bullet"，**不要**用大 banner 干扰主流程。

## 18.7 ResumeExport.editReport（阶段 7）

来源：`src/exports/ResumeLLMFitEditor.ts:71`。仅在 LLM Fit Editor 真正运行时被填充——需要 (a) `ENABLE_LLM_FIT_EDITOR=true`、(b) 已注入 frontDesk 模型客户端、(c) 阶段 6 之后简历仍 overflow 或 underflow ≥ 240 px。否则为 `undefined`。

```ts
type ResumeFitEditorReason =
  | "no_model_client" | "no_actions" | "schema_invalid"
  | "model_error" | "regression" | "edits_applied" | "all_rejected";

type ResumeFitEditorReport = {
  applied: boolean;
  fallback: boolean;
  trigger: "shrink_to_fit" | "fill_underflow" | null;
  reason: ResumeFitEditorReason;
  initialEstimatedPages: number;
  finalEstimatedPages: number;
  initialOverflowPx: number;
  finalOverflowPx: number;
  initialUnderflowPx: number;
  finalUnderflowPx: number;
  actions: Array<{
    type: "shorten_bullet" | "rephrase_bullet" | "drop_bullet" | "expand_bullet";
    itemId: string;
    bulletId: string;
    before?: string;
    after?: string;
  }>;
  rejectedActions?: Array<{ type: string; itemId?: string; bulletId?: string; reason: string }>;
  notes?: string;
  llmReason?: string;
  measuredAt: string;
};
```

阶段 7 同样是 warn-only。LLM 失败时 `applied=false` / `fallback=true` / `reason` 给出诊断枚举。

兼容性：`optional`、`env-gated`（`ENABLE_LLM_FIT_EDITOR`）、`frontend-recommended`。建议前端做成"AI 自动调整记录"折叠区，列出每条 `actions` 的 before/after。

## 18.8 ResumeExport.qualityReport（阶段 8）

来源：`src/exports/ResumeQualityService.ts:47`。仅在导出 `status="completed"` 且产生了 `fitReport` 时被填充。**始终是建议性的**——即使 `hasCriticalRisks=true` 也**不会**阻断导出。

```ts
type ResumeQualityDimension =
  | "authenticity" | "jd_match" | "evidence" | "metric" | "expression" | "layout";

type ResumeQualityRiskLevel = "low" | "medium" | "high" | "critical";

type ResumeQualityRisk = {
  id: string;
  level: ResumeQualityRiskLevel;
  dimension: ResumeQualityDimension;
  message: string;
  itemId?: string;
  bulletId?: string;
};

type ResumeQualitySuggestion = {
  id: string;
  dimension: ResumeQualityDimension;
  message: string;
  itemId?: string;
  bulletId?: string;
};

type ResumeQualityReport = {
  overallScore: number;            // 0..100，权重 auth25/jd25/ev20/metric10/expr10/layout10
  authenticityScore: number;
  jdMatchScore: number;
  evidenceScore: number;
  metricScore: number;
  expressionScore: number;
  layoutScore: number;
  risks: ResumeQualityRisk[];
  suggestions: ResumeQualitySuggestion[];
  unsupportedClaims: string[];
  hasCriticalRisks: boolean;
  generatedAt: string;
  criticReview?: ResumeQualityCriticReview;   // 见 §18.9
};
```

持久化：存放于 `resume_export.quality_report JSONB` 列（迁移 `0015_resume_quality_report.sql`）。

兼容性：`optional`、`frontend-recommended`。建议前端：
- 顶部用 `overallScore` 做主指标；
- 下方用 6 个 0–100 数值条展示六个维度；
- `hasCriticalRisks=true` 时给一条**显眼但非阻断**的 banner，把 `risks.filter(r => r.level === "critical")` 渲染成可点击的 itemId/bulletId 锚点；
- `suggestions` 折叠在"还可以更好"小节；
- `unsupportedClaims` 在简历预览里给命中 bullet 一个浅黄底色 + tooltip "无证据支撑"。

## 18.9 qualityReport.criticReview（阶段 8b）

来源：`src/exports/ResumeQualityCriticService.ts:70`。**与 `qualityReport` 共享同一 `quality_report JSONB` 列**，无新数据库迁移。仅在 `ENABLE_LLM_QUALITY_CRITIC=true` 且模型客户端已注入且规则评分（§18.8）成功产出时才会被填充，否则 `undefined`。

```ts
type ResumeQualityCriticReason =
  | "no_model_client"
  | "disabled_by_env"
  | "no_rule_report"
  | "schema_invalid"
  | "model_error"
  | "ok";

type ResumeQualityCriticReview = {
  applied: boolean;     // true ⇒ LLM 成功产出可解析的 JSON
  fallback: boolean;    // true ⇒ 走了任意 fallback 路径
  reason: ResumeQualityCriticReason;
  semanticJdMatchScore?: number;
  expressionQualityScore?: number;
  authenticityRisks: Array<{
    id: string;
    level: "low" | "medium" | "high" | "critical";
    message: string;
    itemId?: string;
    bulletId?: string;
    evidenceMissing?: boolean;
  }>;
  rewriteSuggestions: Array<{
    id: string;
    itemId?: string;
    bulletId?: string;
    before?: string;
    suggestion: string;
    reason: string;
  }>;
  missingEvidence: Array<{ id: string; bulletId?: string; claim: string; reason: string }>;
  overallComment?: string;
  rejectedReferences?: Array<{
    kind: "risk" | "suggestion" | "missingEvidence";
    itemId?: string;
    bulletId?: string;
    why: "unknown_item" | "unknown_bullet";
  }>;
  llmReason?: string;
  generatedAt: string;
};
```

`hasCriticalRisks` 语义微扩展：单独由 LLM 给出的 `critical` 风险**不会**自动把 `hasCriticalRisks` 翻为 `true`。只有当 LLM 风险与规则层"互相印证"时才升格——具体当 LLM 风险的 `bulletId` 出现在规则层 `unsupportedBulletIds` 或 `noEvidenceBulletIds`，或 LLM 风险 message 与规则层 `unsupportedClaims` 文本互相包含。结果**永远不会比规则层更激进**。

兼容性：`optional`、`env-gated`（`ENABLE_LLM_QUALITY_CRITIC`）、`frontend-recommended`。

前端建议：
- `criticReview.applied===true` 时在质量面板里开"AI 评审"折叠区；
- `semanticJdMatchScore` / `expressionQualityScore` 与规则层并排展示，差异较大时做"两位评审意见不一致"小提示；
- `rewriteSuggestions` 折叠成纯文本提示卡片，**不要**直接调 mutation 改简历，等阶段 9/10 给出明确入口；
- `missingEvidence` 与阶段 1 的"补充经历"路径打通；
- `rejectedReferences` 是诊断信号（LLM 在编 id），**不要**展示给最终用户。

## 18.10 新增可选环境变量

| 变量 | 默认 | 打开时效果 | 关闭时行为 |
|------|------|-----------|-----------|
| `ENABLE_NARRATOR` | unset（关） | 4 个 success 分支的 `assistantMessage.content` 改为动态撰文（§18.2） | 模板字符串，逐字节复刻阶段 2 之前的输出 |
| `ENABLE_LLM_FIT_EDITOR` | unset（关） | 检测到导出仍 overflow / underflow 时可能填充 `editReport`（§18.7） | `editReport` 始终为 `undefined` |
| `ENABLE_LLM_QUALITY_CRITIC` | unset（关） | 在 `qualityReport` 上追加 `criticReview` 第二意见（§18.9） | `criticReview` 始终为 `undefined` |

三个变量相互独立。任意一个的开/关都不会改变既有字段的 shape。任意一个都**不是**后端启动或既有路由可用的必要条件。

## 18.11 前端展示推荐（非强制）

| 数据 | 推荐 UI 位置 |
|------|------------|
| `assistantMessage.content`（Narrator） | 聊天气泡（保持现状） |
| `raw.toolResults[].summaryFacts` / `entities` / `evidence` | 可选调试面板，无需用户可见卡片 |
| `raw.toolResults[].nextActionHints` | 在 assistant 消息下方做"快捷回复 chip" |
| `variants[].resumeDocument` | 存在时优先用结构化 editor；否则 fallback 到 `content` markdown |
| `templateId` | 导出对话框的模板选择器；当前内置 `default` 与 `one-page-modern` |
| `fitReport` | 导出详情页"排版适配"折叠面板 |
| `compressionReport` | 小字 footer：「为了适配一页，AI 自动……」，不要打断主流程 |
| `editReport` | 折叠的 LLM 编辑差异列表，与简历预览的 `data-bullet-id` 高亮联动 |
| `qualityReport` | 6 条 0–100 分数条；`hasCriticalRisks` 时给非阻断 banner；suggestions 折叠 |
| `qualityReport.criticReview` | 在质量面板下追加"AI 评审"子区，仅作建议文本，不要做"一键应用" |

## 18.12 阶段 9 测试

新增 `tests/phase9ContractAdditive.test.ts`，断言：

1. 既有 envelope / endpoint / export 字段全部保持不变。
2. 阶段 1–8b 全部新增字段**要么不存在，要么 shape 与本节定义匹配**——从不必填，从不出现意外类型。
3. 三个环境变量（`ENABLE_NARRATOR` / `ENABLE_LLM_FIT_EDITOR` / `ENABLE_LLM_QUALITY_CRITIC`）全部 unset 时，所有新增字段为 `undefined`，行为与阶段 1 之前 byte-for-byte 一致（在适用维度上）。

测试**不**强制任何新字段必须存在，符合阶段 9 的"不引入 required 字段"指令。
