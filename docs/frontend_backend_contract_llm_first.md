# Coolto 后端 API 使用链路与前端集成契约文档

> **面向前端开发者**。基于 `src/` 最新代码梳理，每条结论均有源文件引用。
> 生成日期：2025-07-17

---

## 一、后端当前运行前提

### 1.1 必须配置的环境变量

| 变量 | 用途 | 默认值 | 关键代码位置 |
|---|---|---|---|
| `DATABASE_URL` | PostgreSQL 连接串。不设置则使用 in-memory 模式 | (无) | [src/api/kernel/createKernel.ts:61](src/api/kernel/createKernel.ts:61) |
| `AUTH_MODE` | 认证模式：`dev_header` / `bearer_static` / `cookie_session` / `disabled` | development→`dev_header`，production→必须设置 | [src/platform/config.ts:137-147](src/platform/config.ts:137-147) |
| `DEEPSEEK_API_KEY` | DeepSeek API Key（主路径） | (无) | [src/agent-core/runtime/AgentRuntimeConfig.ts:24-26](src/agent-core/runtime/AgentRuntimeConfig.ts:24-26) |
| `AGENT_API_KEY` | 通用 Agent API Key（备选） | (无) | 同上 |
| `AGENT_MODEL_API_KEY` | Agent 模型 API Key（备选） | (无) | 同上 |
| `AGENT_MODEL_PROVIDER` | 模型提供商：`deepseek` / `openai` / `compatible` | `deepseek` | [src/agent-core/runtime/AgentRuntimeConfig.ts:21](src/agent-core/runtime/AgentRuntimeConfig.ts:21) |
| `AGENT_PROVIDER` | `AGENT_MODEL_PROVIDER` 的替代名 | (同 AGENT_MODEL_PROVIDER) | 同上 |
| `AGENT_MODEL` | 模型名称 | `deepseek-chat`（API kernel）或 `deepseek-v4-pro`（runtime config） | [src/api/kernel/createKernel.ts:194](src/api/kernel/createKernel.ts:194) |
| `DEEPSEEK_BASE_URL` | DeepSeek API 基础 URL（备选） | (无) | [src/agent-core/runtime/AgentRuntimeConfig.ts:34-36](src/agent-core/runtime/AgentRuntimeConfig.ts:34-36) |
| `AGENT_BASE_URL` | 通用 Agent 基础 URL（备选） | (无) | 同上 |
| `AGENT_MODEL_BASE_URL` | Agent 模型基础 URL（备选） | (无) | 同上 |
| `JOB_WORKER_ENABLED` | 是否启用后台 Job Worker | `false` | [src/platform/config.ts:86](src/platform/config.ts:86) |
| `FILE_UPLOAD_ENABLED` | 是否启用文件上传 | `true` | [src/platform/config.ts:91](src/platform/config.ts:91) |
| `PDF_RENDERER` | PDF 渲染器：`none` / `playwright` / `external` | `none` | [src/platform/config.ts:164](src/platform/config.ts:164) |

### 1.2 无 LLM Key 时的行为

- **不会产出伪 AI 结果**。所有 LLM 调用路径在缺少 API Key 时，会通过 `isDeterministicFallbackAllowed()` 守卫检查 [src/product/deterministicFallbackGuard.ts:13](src/product/deterministicFallbackGuard.ts:13)。
- 仅在 `NODE_ENV=test` 时启用确定性 fallback；development/production 下返回明确错误。
- 文本导入（LLMExperienceExtractor）无 Key 时：返回 `needs_input`，message 为 "AI model could not extract any experience from this text." [src/agent-tools/experience/prepareSaveExperienceFromText.tool.ts:62](src/agent-tools/experience/prepareSaveExperienceFromText.tool.ts:62)
- JD 生成（LLMGenerationService）无 Key 时：抛出 `Error("LLM_PROVIDER_NOT_CONFIGURED: ...")` [src/product/services/index.ts:447-452](src/product/services/index.ts:447-452)
- Copilot 对话无 Key 时：kernel 启动 warning 为 `"DEEPSEEK_API_KEY, AGENT_MODEL_API_KEY, or AGENT_API_KEY is not set. Agent model calls are disabled."` [src/api/kernel/createKernel.ts:217](src/api/kernel/createKernel.ts:217)；LLM 工具调用返回 `llmNotAvailableResult()` 含 `reason: "model_not_available"` [src/product/deterministicFallbackGuard.ts:17](src/product/deterministicFallbackGuard.ts:17)

### 1.3 in_memory 模式的限制

触发条件：`DATABASE_URL` 未设置时自动进入 [src/api/kernel/createKernel.ts:61-62](src/api/kernel/createKernel.ts:61-62)。

限制：
- **所有数据在进程重启后丢失**（经历、JD、简历、session、pending action 均存储在内存中）。
- Pending action 会随进程重启丢失。
- 仅适合本地临时调试或测试。

---

## 二、全局 API 响应格式

### 2.1 成功 Envelope

```json
{
  "ok": true,
  "data": { /* 业务数据 */ },
  "meta": {
    "requestId": "req-xxx",
    "traceId": "trace-xxx",
    "mode": "postgres" | "in_memory",
    "warnings": ["..."]   // 仅在有 warning 时出现
  }
}
```

定义：[src/api/response.ts:11-15](src/api/response.ts:11-15)

### 2.2 失败 Envelope

```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Experience not found.",
    "details": {},        // 可选
    "retryable": true     // 可选，仅可重试错误含此字段
  },
  "meta": {
    "requestId": "req-xxx",
    "traceId": "trace-xxx",
    "mode": "postgres" | "in_memory"
  }
}
```

定义：[src/api/response.ts:17-25](src/api/response.ts:17-25)

### 2.3 例外接口

| 接口 | 格式 | 原因 |
|---|---|---|
| `GET /exports/:id/download` | 直接返回文件流，不包 envelope | 下载接口 |
| `POST /copilot/chat/stream` | `text/event-stream`（SSE），不是 JSON | 流式事件 |

---

## 三、认证、幂等、限流契约

### 3.1 认证

| AUTH_MODE | 前端传参方式 | 用户 ID 来源 |
|---|---|---|
| `dev_header` | 每个请求 Header `x-user-id: <your-id>` | Header 值直接作为 userId [src/api/auth/DevHeaderAuthResolver.ts:8-11](src/api/auth/DevHeaderAuthResolver.ts:8-11) |
| `bearer_static` | Header `Authorization: Bearer <token>` | 服务端配置的固定 userId [src/api/auth/BearerStaticAuthResolver.ts](src/api/auth/BearerStaticAuthResolver.ts) |
| `cookie_session` | Cookie `coolto_session` | Session 中存储的 userId，**当前为 Stub 实现** |
| `bearer_token` / `service` | **预留，未实现** | [src/api/auth/createAuthResolver.ts:38-41](src/api/auth/createAuthResolver.ts:38-41) |

**前端要求**：
- 开发环境使用 `dev_header`，`x-user-id` **必须稳定**（同一用户的数据隔离依赖这个 ID）。
- 切换用户 ID 会看到完全不同的数据视图。

### 3.2 幂等键（Idempotency-Key）

所有**写操作**（POST / PATCH / DELETE）必须带 Header：

```
Idempotency-Key: <uuid>
```

定义：[src/api/idempotency.ts](src/api/idempotency.ts) + [src/platform/types.ts:1-30](src/platform/types.ts:1-30)

规则：
1. 同一 `Idempotency-Key` + 同一 body → **幂等 replay**，返回首次结果。
2. 同一 `Idempotency-Key` + 不同 body → **409 CONFLICT**，错误码 `IDEMPOTENCY_CONFLICT`。
3. `POST /copilot/chat/stream` **禁止**带 `Idempotency-Key`，否则返回 400 [src/api/routes/copilot.ts:87-89](src/api/routes/copilot.ts:87-89)。

### 3.3 限流

错误码 `RATE_LIMITED`（429）。配额耗尽时返回 `QUOTA_EXCEEDED`。

前端提示建议：`"请求过于频繁，请稍后再试。"`

---

## 四、Product API 使用链路

### 4.1 Experiences（经历管理）

#### GET /product/experiences

- **用途**：获取当前用户的所有经历列表
- **请求体**：无。Query 参数 `?limit=N` 可选
- **返回 data**：`ProductExperienceSummary[]`

```json
[
  {
    "id": "exp-xxx",
    "category": "work",
    "title": "Senior Engineer at Acme",
    "organization": "Acme Corp",
    "role": "Senior Engineer",
    "startDate": "2020-01",
    "endDate": "2023-06",
    "sourceDocumentId": null,
    "status": "active",
    "currentRevisionId": "rev-xxx",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "...",
    "content": "Led a team of 5 engineers...",  // Summary 字段
    "structured": { "highlights": [...] }
  }
]
```

类型：[src/product/types.ts:129](src/product/types.ts:129)
路由：[src/api/routes/product.ts:27-31](src/api/routes/product.ts:27-31)

#### POST /product/experiences

- **用途**：手动创建一条经历（带初始 revision）
- **请求体**：

```json
{
  "title": "Senior Engineer",
  "content": "Led a team of 5 engineers...",
  "category": "work",
  "organization": "Acme Corp",    // 可选
  "role": "Senior Engineer",      // 可选
  "startDate": "2020-01",         // 可选
  "endDate": "2023-06",           // 可选
  "tags": ["leadership"],         // 可选
  "structured": {                 // 可选
    "highlights": ["..."],
    "metrics": [{"name": "revenue", "value": "+30%"}]
  },
  "sourceDocumentId": "file-xxx"  // 可选
}
```

- `category` 枚举：`work` | `internship` | `project` | `education` | `award` | `skill` | `other`
- **返回 data**：`ProductExperience`（含 `id`, `currentRevisionId`）
- **成功后**：刷新经历列表、sidebar

路由：[src/api/routes/product.ts:33-48](src/api/routes/product.ts:33-48)

#### GET /product/experiences/:id

- **用途**：获取经历详情（含所有 revisions 和 variants）
- **返回 data**：

```json
{
  "experience": { /* ProductExperience */ },
  "revisions": [
    {
      "id": "rev-xxx",
      "experienceId": "exp-xxx",
      "content": "Led a team...",
      "structured": {...},
      "source": "manual" | "import" | "copilot" | "resume_upload",
      "createdAt": "..."
    }
  ],
  "variants": [
    {
      "id": "var-xxx",
      "experienceId": "exp-xxx",
      "revisionId": "rev-xxx",
      "variantType": "full" | "medium" | "short" | "jd_tailored" | "custom",
      "language": "zh" | "en",
      "targetJdId": null,
      "content": "...",
      "evidenceIds": [],
      "score": null,
      "status": "active" | "archived",
      "createdAt": "..."
    }
  ]
}
```

路由：[src/api/routes/product.ts:50-60](src/api/routes/product.ts:50-60)

#### PATCH /product/experiences/:id

- **用途**：更新经历元数据，可选同时创建新 revision
- **请求体**：

```json
{
  "title": "Updated Title",       // 可选 - 元数据 patch
  "category": "work",             // 可选
  "organization": "...",          // 可选
  "role": "...",                  // 可选
  "startDate": "...",             // 可选
  "endDate": "...",               // 可选
  "tags": ["..."],                // 可选
  "sourceDocumentId": "...",      // 可选
  "content": "New content...",    // 可选 - 传了则创建新 revision
  "structured": { ... }           // 可选 - 传了则创建新 revision
}
```

- **返回 data**：
  - 仅元数据 patch → `ProductExperience`
  - 含 content/structured → `{ experience: ProductExperience, revision: ProductExperienceRevision }`
- **关键逻辑**：传 `content` 或 `structured` 时，后端自动创建新 revision 并更新 `currentRevisionId` [src/api/routes/product.ts:62-100](src/api/routes/product.ts:62-100)

#### POST /product/experiences/:id/revisions

- **用途**：直接为经历创建新 revision（不修改元数据）
- **请求体**：

```json
{
  "content": "New revision content",
  "source": "copilot",            // 可选：manual | import | copilot | resume_upload
  "structured": { ... }           // 可选
}
```

路由：[src/api/routes/product.ts:102-112](src/api/routes/product.ts:102-112)

#### POST /product/experiences/:id/variants

- **用途**：为经历创建展示变体（不同长度/风格）
- **请求体**：

```json
{
  "revisionId": "rev-xxx",
  "content": "Short version...",
  "variantType": "short",         // 可选：full | medium | short | jd_tailored | custom
  "language": "zh",               // 可选：zh | en
  "targetJdId": "jd-xxx"          // 可选
}
```

路由：[src/api/routes/product.ts:114-126](src/api/routes/product.ts:114-126)

---

### 4.2 Imports（经历导入）

#### 文本导入链路（推荐前端优先接）

**POST /product/imports/text**

- **请求体**：

```json
{
  "rawText": "2019-2022 在字节跳动担任高级产品经理，负责抖音电商...",
  "text": "同上，rawText 的别名"      // rawText 和 text 选一即可
}
```

- **返回 data**：

```json
{
  "job": {
    "id": "import-xxx",
    "userId": "...",
    "sourceType": "text",
    "status": "candidates_ready",
    "rawText": "...",
    "createdAt": "...",
    "updatedAt": "..."
  },
  "candidates": [
    {
      "id": "cand-xxx",
      "jobId": "import-xxx",
      "title": "高级产品经理",
      "category": "work",
      "organization": "字节跳动",
      "role": "高级产品经理",
      "startDate": "2019",
      "endDate": "2022",
      "content": "...",
      "structured": { "highlights": [...], "metrics": [...] },
      "status": "pending",
      "sourceDocumentId": null,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

- **LLM 路径**：文本导入使用 `LLMExperienceExtractor`，由 LLM 从原始文本中提取结构化经历 [src/product/LLMExperienceExtractor.ts](src/product/LLMExperienceExtractor.ts)。
- **无 LLM Key 时**：返回错误，不返回伪 candidate。
- **成功后**：前端展示 candidates 列表，引导用户选择 accept/reject。

路由：[src/api/routes/product.ts:146-158](src/api/routes/product.ts:146-158)

#### 文件导入链路（异步 Job）

**POST /product/imports/file**

- **请求体**：

```json
{
  "fileId": "file-xxx"
}
```

- **返回 data**：

```json
{
  "job": {
    "id": "job-xxx",
    "userId": "...",
    "type": "import_resume_file",
    "status": "pending",
    "input": { "fileId": "file-xxx" },
    "progress": 0,
    "createdAt": "..."
  }
}
```

- **完整链路**：

```
POST /files/upload        → 获取 fileId
POST /product/imports/file → 创建 import_resume_file job → 返回 jobId
GET  /jobs/:jobId         → 轮询直到 status=completed
                             job.output.importJobId 是关键字段
GET  /product/imports/:importJobId → 获取 import job + candidates
POST /product/import-candidates/:id/accept → 接受 candidate → 创建经历
```

路由：[src/api/routes/product.ts:160-173](src/api/routes/product.ts:160-173)

#### GET /product/imports/:id

返回 `{ job: ProductImportJob, candidates: ProductImportCandidate[] }`。

#### POST /product/import-candidates/:id/accept

接受一条 candidate，自动创建对应经历（含初始 revision）。

路由：[src/api/routes/product.ts:180-183](src/api/routes/product.ts:180-183)

#### POST /product/import-candidates/:id/reject

拒绝一条 candidate。

路由：[src/api/routes/product.ts:185-188](src/api/routes/product.ts:185-188)

---

### 4.3 JDs（职位描述）

#### GET /product/jds

- **返回 data**：`ProductJDSummary[]`，不含 `rawText` 字段

#### POST /product/jds

- **请求体**：

```json
{
  "rawText": "岗位职责：1. 负责...",       // 必填（也接受 jdText 字段作为别名）
  "title": "高级前端工程师",                // 可选
  "company": "Acme Corp",                  // 可选
  "targetRole": "前端开发"                  // 可选
}
```

- **兼容说明**：前端可传 `jdText` 替代 `rawText`，后端接受两者 [src/api/routes/product.ts:135](src/api/routes/product.ts:135)。
- **requirements**：`ProductJDRecord.requirements` 字段存在但当前**未由 LLM 自动解析**，需要 LLM 分析 JD 后通过 Copilot 更新。
- **保存后**：前端应设置 `activeJDId` 为返回的 `jd.id`。

路由：[src/api/routes/product.ts:131-143](src/api/routes/product.ts:131-143)

#### GET /product/jds/:id

返回完整 `ProductJDRecord`（含 `rawText`）。

---

### 4.4 Resumes（简历管理）

#### GET /product/resumes

返回 `ProductResumeSummary[]`

#### POST /product/resumes

```json
{
  "title": "我的简历",      // 可选
  "targetRole": "前端开发", // 可选
  "jdId": "jd-xxx"         // 可选
}
```

#### GET /product/resumes/:id

返回 `ProductResumeDetail`（`ProductResume & { items: ProductResumeItem[] }`）[src/product/types.ts:134](src/product/types.ts:134)。

#### POST /product/resumes/:id/items

```json
{
  "title": "Senior Engineer at Acme",
  "contentSnapshot": "Led a team of 5...",    // 注意：字段名是 contentSnapshot 不是 content
  "sectionType": "experience",                // experience | education | project | skill | award | summary | other
  "sourceExperienceId": "exp-xxx",            // 可选 - 关联来源经历
  "sourceVariantId": "var-xxx",               // 可选
  "sourceArtifactId": "art-xxx"               // 可选
}
```

**关键字段说明**：ResumeItem 的内容字段叫 `contentSnapshot`，不是 `content`。来源关联字段可追溯该简历条目来自哪条经历/版本。

#### PATCH /product/resume-items/:id

```json
{
  "title": "...",             // 可选
  "contentSnapshot": "...",   // 可选
  "hidden": true,             // 可选 - 隐藏该项
  "pinned": true              // 可选 - 置顶该项
}
```

路由：[src/api/routes/product.ts:170-180](src/api/routes/product.ts:170-180)

#### POST /product/resumes/:id/reorder

```json
{
  "orderedIds": ["item-3", "item-1", "item-2"]
}
```

路由：[src/api/routes/product.ts:182-186](src/api/routes/product.ts:182-186)

---

### 4.5 Generations（JD 简历生成）

#### POST /product/generations/from-jd

- **请求体**：

```json
{
  "jdId": "jd-xxx",           // jdId 或 jdText 二选一，至少一个
  "jdText": "岗位职责：...",   // 也接受 rawText / text 别名
  "targetRole": "前端开发"     // 可选
}
```

- **返回 data**：

```json
{
  "generationId": "gen-xxx",
  "jd": { /* ProductJDRecord */ },
  "variants": [
    {
      "id": "gv-xxx",
      "artifactId": null,
      "title": "版本 A - 推荐",
      "content": "Led a team...",
      "role": "recommended",           // recommended | alternative | safe | quantified | experimental
      "status": "ready",               // ready | needs_confirmation | unsafe | accepted | rejected
      "score": {
        "overall": 85,
        "relevance": 90,
        "clarity": 80,
        "evidenceStrength": 70,
        "quantifiedImpact": 85
      },
      "badges": [
        { "label": "量化充分", "tone": "positive" }
      ],
      "reason": "该版本基于你在 Acme 的经历生成，与 JD 匹配度高。",
      "evidenceSummary": {
        "coverageLabel": "80% 有证据支撑",
        "items": [
          {
            "id": "ev-xxx",
            "title": "团队管理经验",
            "quote": "Led a team of 5 engineers",
            "explanation": "对应 JD 中'团队管理能力'要求",
            "confidence": 0.9
          }
        ]
      },
      "riskSummary": {
        "level": "low",                 // low | medium | high | critical
        "unsupportedClaims": [],
        "missingEvidence": [],
        "warnings": []
      },
      "missingInfo": [],
      "sourceExperienceIds": ["exp-xxx"],
      "sourceEvidenceIds": ["ev-xxx"],
      "actions": [
        { "id": "act-1", "type": "accept", "label": "采用此版本", "variantId": "gv-xxx", "primary": true },
        { "id": "act-2", "type": "reject", "label": "不采用", "variantId": "gv-xxx", "primary": false },
        { "id": "act-3", "type": "show_evidence", "label": "查看证据", "variantId": "gv-xxx", "primary": false }
      ],
      "raw": {},
      "createdAt": "..."
    }
  ],
  "generation": { /* ProductGeneration */ }
}
```

- **这是 LLMGenerationService 主路径** [src/product/LLMGenerationService.ts](src/product/LLMGenerationService.ts)。
- **无经历证据时**：`evidenceSummary.items` 为空，`riskSummary.level` 为 `high` 或 `critical`，`missingInfo` 列出缺失信息。前端应展示为 **"高风险：需确认"** 而非异常。
- **成功后**：前端应设置 `activeJDId`、`activeVariantId`（列表首个）、`productGenerationId`。

路由：[src/api/routes/product.ts:199-216](src/api/routes/product.ts:199-216)

#### GET /product/generations

返回 `ProductGeneration[]` 列表。

#### GET /product/generations/:id

返回 `ProductGeneration & { variants: ProductVariant[] }`。
variants 由后端从 `outputSnapshot` 中提取并用 `toWorkspaceVariant()` 转换 [src/api/routes/product.ts:194-197](src/api/routes/product.ts:194-197)。

#### POST /product/generations/:id/accept-variant

- **请求体**：

```json
{
  "variantId": "gv-xxx",
  "resumeId": "resume-xxx"     // 可选 - 目标简历 ID
}
```

- **行为**：将选定的 variant 内容保存到简历中（创建或更新 `ResumeItem`）。
- **成功后**：前端应刷新简历详情（`GET /product/resumes/:id`）和生成详情。

路由：[src/api/routes/product.ts:218-226](src/api/routes/product.ts:218-226)

---

## 五、Files / Jobs API 使用链路

### 5.1 Files

#### POST /files/upload

支持两种上传方式：

**方式 A - multipart/form-data**：
```
Content-Type: multipart/form-data; boundary=...
字段名: file
```

**方式 B - JSON base64**：
```json
{
  "base64": "SGVsbG8gV29ybGQ=",
  "fileName": "resume.pdf",
  "mimeType": "application/pdf"
}
```

- **支持的 MIME 类型**（默认配置）：
  - `application/pdf`
  - `application/vnd.openxmlformats-officedocument.wordprocessingml.document`（DOCX）
  - `text/plain`（TXT）
- 可通过 `FILE_ALLOWED_MIME_TYPES` 环境变量扩展。

- **返回 data**：`UploadedFile`

```json
{
  "id": "file-xxx",
  "userId": "...",
  "originalName": "resume.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 12345,
  "storageProvider": "local",
  "storageKey": "...",
  "sha256": "...",
  "status": "uploaded",
  "createdAt": "...",
  "updatedAt": "..."
}
```

路由：[src/api/routes/files.ts:21-27](src/api/routes/files.ts:21-27)

#### POST /files/:id/parse

触发文档解析（异步 job）。创建 `parse_document` job。

返回：
```json
{
  "job": {
    "id": "job-xxx",
    "type": "parse_document",
    "status": "pending",
    "input": { "fileId": "file-xxx" }
  }
}
```

路由：[src/api/routes/files.ts:52-65](src/api/routes/files.ts:52-65)

#### GET /files/:id/parsed-document

解析完成后获取文本内容：

```json
{
  "id": "doc-xxx",
  "userId": "...",
  "fileId": "file-xxx",
  "sourceType": "pdf" | "docx" | "text" | "paste",
  "text": "Full extracted text...",
  "metadata": {},
  "createdAt": "..."
}
```

路由：[src/api/routes/files.ts:67-71](src/api/routes/files.ts:67-71)

### 5.2 Jobs

#### GET /jobs / GET /jobs/:id

返回 `BackgroundJob`。

Job 关键字段：

```json
{
  "id": "job-xxx",
  "type": "parse_document" | "import_resume_file" | "export_resume_html" | "export_resume_pdf" | ...,
  "status": "pending" | "running" | "completed" | "failed" | "cancelled",
  "input": {},
  "output": {
    "importJobId": "...",      // import_resume_file job 完成后有此字段
    "exportId": "...",         // export job 完成后有此字段
    "textDocumentId": "...",   // parse_document job 完成后有此字段
    "resultRef": "..."         // 通用结果引用
  },
  "errorMessage": "...",
  "progress": 85,
  "progressMessage": "Extracting text...",
  "attempts": 1,
  "createdAt": "...",
  "updatedAt": "...",
  "completedAt": "..."
}
```

类型定义：[src/platform/types.ts:107-133](src/platform/types.ts:107-133)

#### POST /jobs/:id/cancel

取消一个 pending/running 的 job。

### 5.3 文件导入经历的完整链路

```
1. POST /files/upload
   → 返回 { fileId }

2. POST /files/:fileId/parse（可选，也可跳过直接做 import）
   → 返回 { job: { id: parseJobId } }

3. POST /product/imports/file { fileId }
   → 返回 { job: { id: importJobId, status: "pending" } }

4. GET /jobs/:importJobId（轮询，每 1-2 秒）
   → 直到 status = "completed" 且有 output.importJobId
   → 如果 status = "failed"，展示 errorMessage

5. GET /product/imports/:output.importJobId
   → 返回 { job: ProductImportJob, candidates: ProductImportCandidate[] }

6. 前端展示 candidates 供用户选择 accept/reject
   → POST /product/import-candidates/:id/accept
   → POST /product/import-candidates/:id/reject

7. Accept 成功后刷新经历库、candidate 状态、sidebar
```

### 5.4 Background Worker

**⚠️ TODO：生产环境 BackgroundWorker 需要单独启动。**

当前 `server.ts` [src/api/server.ts](src/api/server.ts) 仅启动 API server，不自动启动 `BackgroundWorker`。

`BackgroundWorker` 代码已完备 [src/jobs/BackgroundWorker.ts](src/jobs/BackgroundWorker.ts)，在 `JOB_WORKER_ENABLED=true` 时需要通过以下方式之一启动：

- **方案 A**：在 `server.ts` 中检查 `JOB_WORKER_ENABLED` 并调用 `new BackgroundWorker(kernel).start()`。
- **方案 B**：单独进程运行 worker。

**当前影响**：如果不启动 worker，所有异步 job（文件解析、文件导入、导出）会一直停留在 `pending` 状态。前端轮询会无限等待。

**前端建议**：如果 job 超过合理时间未完成（如 60 秒），展示 "后台任务处理器未启动，请联系管理员" 或不依赖 job 完成直接给用户 fallback 体验。

---

## 六、Copilot Chat API 契约

### 6.1 POST /copilot/chat

**请求体**：

```json
{
  "sessionId": "sess-xxx",        // 可选 - 不传则创建新 session
  "message": "帮我基于 JD 生成简历",
  "resumeText": "...",            // 可选
  "jdText": "...",                // 可选
  "targetRole": "前端开发",        // 可选
  "clientState": {                // 推荐 - 当前上下文（见第八节）
    "activeSessionId": "sess-xxx",
    "activeExperienceId": "exp-xxx",
    "activeJDId": "jd-xxx",
    "activeResumeId": "resume-xxx",
    "activeResumeItemId": "item-xxx",
    "activeVariantId": "gv-xxx",
    "activeEvidenceId": "ev-xxx",
    "activeImportJobId": "import-xxx",
    "activeCandidateIds": ["cand-xxx"],
    "selectedText": "...",
    "selectedSection": "...",
    "visibleArtifactTypes": ["experience", "variant"],
    "visibleArtifactIds": ["exp-xxx"],
    "intentSource": "composer",
    "sourceComponent": "ChatInput",
    "locale": "zh",
    "mainMode": "resume_builder"
  }
}
```

类型定义：[src/copilot/types.ts:298-306](src/copilot/types.ts:298-306)

**返回 data** (`CopilotChatResponse`)：

```json
{
  "sessionId": "sess-xxx",
  "turnId": "turn-xxx",
  "assistantMessage": {
    "id": "msg-xxx",
    "sessionId": "sess-xxx",
    "turnId": "turn-xxx",
    "role": "assistant",
    "content": "已基于 JD 生成 3 个简历版本...",
    "kind": "plain_text",
    "createdAt": "...",
    "metadata": {
      "productBlocks": [
        {
          "type": "experience_list",
          "title": "经历库",
          "data": { "experiences": [...] }
        }
      ],
      "actionResult": {
        "actionType": "generate_resume_from_jd",
        "status": "success",
        "message": "已生成 3 个版本"
      },
      "workspaceSnapshot": {
        "activePanel": "variants",
        "activeVariantId": "gv-xxx",
        "variantCount": 3,
        "productGenerationId": "gen-xxx"
      },
      "relatedResourceIds": {
        "experienceIds": ["exp-xxx"],
        "generationIds": ["gen-xxx"],
        "resumeIds": ["resume-xxx"]
      }
    }
  },
  "timeline": [
    {
      "id": "tl-xxx",
      "type": "variants_generated",
      "title": "已生成 3 个版本",
      "status": "completed",
      "createdAt": "...",
      "relatedVariantId": "gv-xxx"
    }
  ],
  "workspace": {
    "id": "ws-sess-xxx",
    "sessionId": "sess-xxx",
    "activeVariantId": "gv-xxx",
    "activePanel": "variants",
    "productGenerationId": "gen-xxx",
    "jdId": "jd-xxx",
    "resumeId": "resume-xxx",
    "variants": [ /* ProductVariant[] */ ],
    "experiences": [ /* ProductExperienceSummary[] */ ],
    "jds": [ /* ProductJDSummary[] */ ],
    "resumes": [ /* ProductResumeSummary[] */ ],
    "status": "ready",
    "updatedAt": "..."
  },
  "nextActions": [
    {
      "id": "act-xxx",
      "type": "accept",
      "label": "采用此版本",
      "variantId": "gv-xxx",
      "primary": true
    }
  ],
  "suggestedPrompts": [
    { "label": "让版本更量化", "message": "请让版本 A 更量化" }
  ],
  "raw": {
    "artifactIds": [],
    "evidenceChainIds": [],
    "critiqueItemIds": [],
    "decisionIds": [],
    "agentTrace": { /* agent 内部追踪信息 */ },
    "toolResults": [ /* 工具执行结果 */ ],
    "pendingActions": [ /* 待确认操作 */ ],
    "metadata": {
      "loop": { /* loop 状态 */ },
      "observations": [ /* AgentObservation */ ],
      "agentMessages": [ /* Agent 内部消息 */ ]
    },
    "actionResults": [
      {
        "actionType": "generate_resume_from_jd",
        "status": "success",
        "message": "已生成 3 个版本"
      }
    ]
  }
}
```

类型定义：[src/copilot/types.ts:308-324](src/copilot/types.ts:308-324)

**路由**：[src/api/routes/copilot.ts:28-44](src/api/routes/copilot.ts:28-44)

### 6.2 POST /copilot/chat/stream（SSE）

**⚠️ 禁止带 `Idempotency-Key` Header。**

**请求体**：同 `/copilot/chat`

**返回格式**：`text/event-stream`

```
event: agent.turn.started
data: {"type":"agent.turn.started","sessionId":"sess-xxx","turnId":"turn-xxx","status":"running","label":"开始处理请求",...}

event: agent.thinking
data: {"type":"agent.thinking","label":"正在思考…",...}

event: agent.route.started
data: {"type":"agent.route.started","label":"正在判断任务类型…",...}

event: agent.route.completed
data: {"type":"agent.route.completed","label":"任务类型判断完成","payload":{"routeTo":"architect","responseType":"generate"},"status":"completed",...}

event: agent.plan.snapshot
data: {"type":"agent.plan.snapshot","label":"执行计划","payload":{"steps":[...]},"status":"completed",...}

event: agent.tool.started
data: {"type":"agent.tool.started","toolName":"list_experiences","label":"正在读取经历库…","status":"running",...}

event: agent.tool.completed
data: {"type":"agent.tool.completed","toolName":"list_experiences","label":"经历库读取完成","status":"success",...}

event: agent.pending_action.created
data: {"type":"agent.pending_action.created","label":"需要确认操作","payload":{"pendingActionId":"pa-xxx","summary":"将创建一条新经历"}}

event: agent.completed
data: {"type":"agent.completed","label":"处理完成","status":"success","response":{/* 完整的 CopilotChatResponse */},...}

event: agent.failed
data: {"type":"agent.failed","label":"处理失败","status":"failed","message":"...","payload":{"message":"..."}}
```

完整事件类型定义：[src/agent-core/runtime/AgentStreamEvent.ts](src/agent-core/runtime/AgentStreamEvent.ts)

**前端处理指南**：

| 事件 | 前端行为 |
|---|---|
| `agent.turn.started` | 显示 loading 状态 |
| `agent.thinking` | 显示 "AI 正在思考…" |
| `agent.route.started` / `agent.route.completed` | 内部事件，可选展示 |
| `agent.plan.snapshot` | 内部事件，不要直接展示给用户 |
| `agent.tool.started` / `agent.tool.completed` | 内部事件，不要展示具体工具名 |
| `agent.pending_action.created` | **重要**：展示确认卡片 |
| `agent.completed` | **读取 `response` 字段**，获取完整 CopilotChatResponse（workspace、nextActions、timeline） |
| `agent.failed` | 展示错误消息，允许重试 |

**路由**：[src/api/routes/copilot.ts:79-118](src/api/routes/copilot.ts:79-118)

### 6.3 POST /copilot/actions

显式触发 Copilot action（不走自然语言对话）。

**请求体**：

```json
{
  "sessionId": "sess-xxx",
  "turnId": "turn-xxx",       // 可选
  "action": {
    "type": "generate_from_jd",
    "variantId": "gv-xxx",    // 可选 - 部分 action 需要
    "payload": {               // 可选 - action 参数
      "jdId": "jd-xxx",
      "jdText": "..."
    }
  },
  "clientState": { ... }       // 推荐（见第八节）
}
```

**返回 data**：同 `/copilot/chat` 的 `CopilotChatResponse`。

路由：[src/api/routes/copilot.ts:46-77](src/api/routes/copilot.ts:46-77)

---

## 七、Copilot Actions 新契约

### 7.1 完整 Action Type 列表

所有 action type 定义：[src/copilot/types.ts:162-176](src/copilot/types.ts:162-176)

| Action Type | 用途 | 创建 Pending Action | 依赖的 clientState 字段 |
|---|---|---|---|
| `list_experiences` | 列出经历库 | 否 | (无) |
| `search_experiences` | 搜索经历 | 否 | (无，需 payload.query) |
| `get_experience` / `open_inspector` | 打开经历详情 | 否 | `activeExperienceId` |
| `save_experience_from_text` | 从文本保存经历 | 是（LLM 提取 draft → 确认 → 保存） | (无，需 payload.text) |
| `update_experience` | 更新经历 | 否 | `activeExperienceId` |
| `rewrite_experience` | 改写经历 | 需要 LLM 先生成改写版本 | `activeExperienceId` |
| `match_experience` | 将经历匹配 JD | 否 | `activeExperienceId`, `activeJDId` |
| `generate_from_jd` | 基于 JD 生成简历 | 是（confirm 后执行） | `activeJDId` |
| `accept` | 采用 variant | 是（confirm 后执行） | `activeVariantId`, `activeJDId` |
| `reject` | 拒绝 variant | 否（直接标记） | `activeVariantId` |
| `prefer` | 表达偏好 | 否（要求用户补充描述） | `activeVariantId` |
| `optimize_resume_item` | 优化简历条目 | 是（confirm 后执行） | `activeResumeItemId`, `activeResumeId` |
| `prepare_revise_resume_item` | ⚠️ 内部 tool 名 | prepare 阶段由 Agent 内部调用 | `activeResumeItemId` |
| `revise_resume_item` | ⚠️ 内部 tool 名 | confirm 阶段由 Agent 内部调用 | `activeResumeItemId` |
| `prepare_update_experience` | ⚠️ 内部 tool 名 | prepare 阶段由 Agent 内部调用 | `activeExperienceId` |
| `show_evidence` | 查看证据链 | 否 | `activeVariantId` / `activeEvidenceId` |
| `explain_choice` | 解释选择理由 | 否 | `activeVariantId` / `activeEvidenceId` |
| `export_resume` | 导出简历 | 是（confirm 后执行） | `activeResumeId` |
| `confirm_metric` | 确认指标 | ⚠️ 暂未完整实现 | — |
| `revise_more_conservative` | 更保守地改 | ⚠️ 暂未完整实现 | — |
| `revise_more_quantified` | 更量化地改 | ⚠️ 暂未完整实现 | — |

> **注**：标 ⚠️ 的 "内部 tool 名" 是 Agent 内部使用的 tool 名称，前端看到的 action type 是其用户面形态。例如前端传 `action.type: "rewrite_experience"`，Agent 内部调用 `prepare_update_experience` → 创建 pending action → 用户 confirm → Agent 调用 `update_experience`。

### 7.2 各 Action 详细说明

所有 action 的 ID 解析 fallback 链为：`payload → action.variantId → clientState → activeAssetContext → workspace` [src/agent-core/runtime/AgentOrchestrator.ts:1073-1093](src/agent-core/runtime/AgentOrchestrator.ts:1073-1093)。

#### list_experiences

```json
// 请求
{ "action": { "type": "list_experiences", "payload": { "limit": 20 } } }

// 不创建 pending action，直接返回经历列表
// 返回 workspace.experiences 含经历列表
```

#### search_experiences

```json
// 请求
{ "action": { "type": "search_experiences", "payload": { "query": "字节跳动", "limit": 10 } } }

// 无 query 时返回 needs_input
```

#### get_experience / open_inspector

```json
// 请求
{ "action": { "type": "get_experience" } }
// 依赖 clientState.activeExperienceId
// 无 ID 时返回 needs_input: "Please choose an experience first."
```

#### save_experience_from_text

```json
// 请求
{ "action": { "type": "save_experience_from_text", "payload": { "text": "2019-2022...", "content": "或 content", "rawText": "或 rawText" } } }

// 链路：LLM 提取 draft → 创建 pending action → 前端确认 → 保存经历
// payload.text/content/rawText 任意一个有值即可
// 无文本时返回 needs_input
```

#### rewrite_experience（经历改写链路）

```
用户点击"改写经历"
  ↓
前端调用 POST /copilot/actions { action: { type: "rewrite_experience" } }
  clientState: { activeExperienceId: "exp-xxx" }
  ↓
后端读取 current revision.content
  → LLMRewriteService 生成 revisionSuggestion
  ↓
返回 CopilotChatResponse，其中 assistantMessage.metadata.actionResult 含:
  {
    "revisionSuggestion": {
      "kind": "experience",
      "sourceId": "exp-xxx",
      "sourceTextPreview": "原始开头...",
      "rewrittenText": "改写后的完整文本..."
    }
  }
  ↓
前端展示改写预览卡片（sourceTextPreview + rewrittenText + changes diff）
  ↓
用户确认 → 调用 POST /copilot/pending-actions/:id/confirm
  （或通过 Copilot 对话确认）
  ↓
后端创建新 revision（旧 revision 保留），更新 currentRevisionId
  ↓
前端刷新 GET /product/experiences/:id → 展示新 revision
```

#### optimize_resume_item（简历条目优化链路）

```
用户点击"优化简历条目"
  ↓
前端调用 POST /copilot/actions { action: { type: "optimize_resume_item" } }
  clientState: { activeResumeItemId: "item-xxx", activeResumeId: "resume-xxx" }
  ↓
Agent 内部调用 prepare_revise_resume_item → 创建 pending action
  ↓
返回 CopilotChatResponse，actionResult 含:
  {
    "revisionSuggestion": {
      "kind": "resume_item",
      "sourceId": "item-xxx",
      "sourceTextPreview": "...",
      "rewrittenText": "..."
    }
  }
  ↓
前端展示优化预览卡片
  ↓
用户确认 → POST /copilot/pending-actions/:id/confirm
  ↓
后端调用 revise_resume_item → 更新 ResumeItem.contentSnapshot
  ↓
前端刷新 GET /product/resumes/:id → 展示更新后的条目
```

#### generate_from_jd（基于 JD 生成）

```
方式 A - Product API 直接调用:
  POST /product/generations/from-jd { jdId: "...", jdText: "..." }
  → 同步返回 variants（推荐资产按钮使用）

方式 B - Copilot action:
  POST /copilot/actions { action: { type: "generate_from_jd" } }
  clientState: { activeJDId: "jd-xxx" }
  → 创建 pending action → confirm → 生成 variants

成功后：设置 activeJDId, activeVariantId, productGenerationId
```

#### accept（采用 variant）

```json
// 请求
{ "action": { "type": "accept" } }

// 依赖：clientState.activeVariantId, clientState.activeJDId
// 或 action.variantId

// 返回 needs_input（需要 variantId + generationId）时，前端应引导用户先选择 variant
// confirm 成功后创建 resume item
// 前端刷新：resume detail, generation detail
```

#### show_evidence / explain_choice

```json
// 请求
{ "action": { "type": "show_evidence", "payload": { "evidenceId": "ev-xxx" } } }

// 依赖：clientState.activeVariantId / activeEvidenceId
// 无 ID 时返回 needs_input + missingInputs: ["variantId", "evidenceId", "generationId"]

// 没有证据链时返回 needs_input + data: { evidence: [], empty: true, reason: "evidence_chain_not_available" }
// 前端不要将此视为异常，展示 "暂无证据链" 即可
```

#### export_resume

```json
// 请求
{ "action": { "type": "export_resume", "payload": { "format": "html", "templateId": "tpl-xxx" } } }

// 依赖：clientState.activeResumeId
// 无 resumeId 时返回 needs_input: "请先打开一份简历，再进行导出。"
// 创建 pending action → confirm → 异步导出 job
```

---

## 八、clientState / Active Asset Contract

### 8.1 标准结构

前端**每次调用** Copilot 接口（chat / actions）时，应该传 `clientState`：

```json
{
  "locale": "zh",                          // 语言
  "mainMode": "resume_builder",             // 当前主模式
  "activeSessionId": "sess-xxx",            // 当前 session
  "activeExperienceId": "exp-xxx",          // 当前选中的经历
  "activeJDId": "jd-xxx",                   // 当前选中的 JD
  "activeResumeId": "resume-xxx",           // 当前选中的简历
  "activeResumeItemId": "item-xxx",         // 当前选中的简历条目
  "activeVariantId": "gv-xxx",              // 当前选中的 variant
  "activeEvidenceId": "ev-xxx",             // 当前选中的证据项
  "activeImportJobId": "import-xxx",        // 当前查看的导入 job
  "activeCandidateIds": ["cand-xxx"],       // 当前选中的 candidates
  "selectedText": "选中的文本片段",           // 用户选中的文本
  "selectedSection": "experience",           // 用户当前所在的区块
  "visibleArtifactTypes": ["experience"],    // 前端当前可见的资源类型
  "visibleArtifactIds": ["exp-xxx"],        // 前端当前可见的资源 ID
  "intentSource": "composer",                // 触发来源：composer | sidebar | artifact_action | asset_detail | system
  "sourceComponent": "ChatInput"             // 具体组件名
}
```

类型定义：[src/copilot/types.ts:204-222](src/copilot/types.ts:204-222)

### 8.2 核心规则

1. **所有"当前这条经历/JD/简历条目/版本"不能靠自然语言猜**。必须通过 `clientState.active*Id` 传递。
2. **前端打开详情页时必须设置对应 active id**：
   - 打开经历详情 → `activeExperienceId`
   - 打开 JD 详情 → `activeJDId`
   - 打开简历详情 → `activeResumeId`
   - 点击 variant 卡片 → `activeVariantId`
3. **前端点击卡片按钮时必须传 clientState**。例如点击 variant 卡片上的"采用"按钮，需要传 `activeVariantId` 和 `activeJDId`。
4. **后端 ID 解析 fallback 顺序** [src/agent-core/runtime/AgentOrchestrator.ts:1073-1093](src/agent-core/runtime/AgentOrchestrator.ts:1073-1093)：

```
payload.experienceId
  → action.variantId
  → clientState.activeExperienceId
  → workspace.active.experienceId
  → activeAssetContext.activeExperience.id
```

5. **缺 ID 时返回 `needs_input`**（不是 schema error），含 `missingInputs` 字段指示缺哪个 ID。

---

## 九、Pending Action 契约

### 9.1 API

| 接口 | 用途 |
|---|---|
| `GET /copilot/pending-actions` | 列出当前用户的 pending actions（可选 `?sessionId=` 过滤） |
| `GET /copilot/pending-actions/:id` | 获取单个 pending action 详情 |
| `POST /copilot/pending-actions/:id/confirm` | 确认执行 |
| `POST /copilot/pending-actions/:id/cancel` | 取消 |

路由：[src/api/routes/pendingActions.ts](src/api/routes/pendingActions.ts)

### 9.2 生命周期

```
pending → confirmed → executed  (正常路径)
pending → cancelled              (用户取消)
pending → expired                (过期，30 分钟)
pending → failed                 (执行失败)
```

状态定义：[src/agent-core/confirmation/PendingAction.ts:4](src/agent-core/confirmation/PendingAction.ts:4)

### 9.3 PendingAction 结构

```json
{
  "id": "pa-xxx",
  "userId": "...",
  "sessionId": "sess-xxx",
  "turnId": "turn-xxx",
  "toolName": "save_experience_from_text",
  "toolArguments": { "text": "...", "category": "work" },
  "status": "pending",
  "title": "保存经历",
  "summary": "将从文本中提取一条工作经历并保存到经历库",
  "riskLevel": "low",
  "affectedResources": [
    { "type": "experience", "title": "高级产品经理 - 字节跳动" }
  ],
  "preview": {
    "before": { "title": "（新经历）" },
    "after": { "title": "高级产品经理", "organization": "字节跳动", "content": "..." }
  },
  "createdAt": "...",
  "expiresAt": "..."    // 30 分钟后过期
}
```

### 9.4 Confirm 行为

**幂等性**：重复 confirm 同一 pending action 不会生成新操作。已 `executed` 的 action 返回 `{ status: "needs_input", message: "该操作已确认，无需重复提交。" }` [src/agent-core/confirmation/PendingActionService.ts:98-106](src/agent-core/confirmation/PendingActionService.ts:98-106)。

**Confirm 成功返回**（`CopilotChatResponse`）包含：
- `actionResult`：执行结果
- `workspace`：更新后的 workspace
- `workspacePatch`：本次变更
- `timeline`：相关时间线事件

**前端收到 confirm 成功后应**：
1. **移除对应 pending action 卡片**（从列表中移除）
2. **刷新相关资源**（根据 `affectedResources` 刷新经历/JD/简历）
3. **更新 workspace**（用返回的 workspace 替换本地缓存）
4. **禁止重复 confirm**（按钮变灰或移除）

### 9.5 错误处理

| 错误 | 含义 | 前端行为 |
|---|---|---|
| `PERMISSION_DENIED` + "Pending action not found." | Pending action 不存在或不属于当前用户 | 提示"操作已失效"，移除卡片 |
| `CONFIRMATION_EXPIRED` | 已过期/已取消/已执行 | 提示"操作已失效，请重新发起" |
| `needs_input` + `reason: "tool_not_found"` | 工具已移除 | 提示"操作不可用，请重新发起" |
| `needs_input` + `reason: "pending_action_not_pending"` | 重复确认 | 忽略（幂等），不显示错误 |

---

## 十、LLM-first 错误处理契约

### 10.1 前端必须识别的新错误/状态

| 错误码/状态 | 出现链路 | 用户提示 | 可重试 | 需配 Key | 需补充信息 |
|---|---|---|---|---|---|
| `model_not_available` / `LLM_PROVIDER_NOT_CONFIGURED` | 文本导入、JD 生成、改写经历、所有 LLM 调用 | "AI 模型服务未配置，无法完成智能处理。请检查 API Key 配置。" | 否 | 是 | 否 |
| `llm_not_available` | evidence 检查、claim 验证 | "当前无法验证声明真实性。" | 是 | 是 | 否 |
| `needs_input` | 缺 active id、缺必填参数 | `message` 字段内容（如 "请先选择一条经历"） | 是（补充后） | 否 | 是 |
| `needs_confirmation` | 写操作前（pending action 创建） | "请确认此操作" + pending action 卡片 | — | 否 | 否 |
| `schema_repair_failed` | Agent 输出解析失败 | "AI 在处理时遇到了内部格式问题，请换个说法重试。" | 是 | 否 | 否 |
| `model_call_failed` / `MODEL_FAILED` | LLM 调用超时/失败 | "AI 模型暂时不可用，请稍后重试。" | 是 | 否 | 否 |
| `high_risk` / `riskSummary.level: "high"` | variant 风险评级 | "该版本包含较多缺乏证据支撑的声明，建议核实后使用。" | 不适用 | 否 | 否 |
| `empty_evidence` | evidence 查询无结果 | "当前没有可用的证据链。"（非异常） | 不适用 | 否 | 否 |

### 10.2 错误识别方式

前端需要识别两类：
1. **HTTP 错误 Envelope**：`ok: false` + `error.code`
2. **ToolResult / ActionResult 状态**：`status: "needs_input"`, `status: "needs_confirmation"`, `actionResult.reason: "model_not_available"`

### 10.3 来源文件

- Error codes：[src/api/errors/ErrorCode.ts](src/api/errors/ErrorCode.ts)
- AgentError：[src/agent-core/runtime/AgentError.ts](src/agent-core/runtime/AgentError.ts)
- Deterministic fallback guard：[src/product/deterministicFallbackGuard.ts](src/product/deterministicFallbackGuard.ts)
- ToolResult 状态：[src/agent-core/tools/ToolResult.ts](src/agent-core/tools/ToolResult.ts)
- Error mapper：[src/api/errors/errorMapper.ts](src/api/errors/errorMapper.ts)

---

## 十一、Evidence / Risk 展示契约

### 11.1 数据结构

在 `ProductVariant`（workspace 中的 variant）中 [src/copilot/types.ts:131-159](src/copilot/types.ts:131-159)：

```json
{
  "evidenceSummary": {
    "coverageLabel": "80% 有证据支撑",
    "items": [
      {
        "id": "ev-xxx",
        "title": "团队管理经验",
        "quote": "Led a team of 5 engineers",     // 可选 - 原文引用
        "explanation": "对应 JD 中'团队管理能力'要求",
        "confidence": 0.9                           // 可选 - 置信度 0-1
      }
    ]
  },
  "riskSummary": {
    "level": "low",                   // low | medium | high | critical
    "unsupportedClaims": [            // 缺乏证据的声明
      "通过优化流程提升效率 50%"
    ],
    "missingEvidence": [              // 缺失的证据类型
      "效率提升的具体数据来源"
    ],
    "warnings": [                     // 警告
      "该版本的目标岗位与你的主要经历方向不完全匹配"
    ]
  },
  "missingInfo": [
    "需要补充项目管理的具体成果",
    "需要补充团队规模"
  ],
  "sourceExperienceIds": ["exp-xxx", "exp-yyy"],
  "sourceEvidenceIds": ["ev-xxx"]
}
```

### 11.2 前端展示建议

| 位置 | 展示内容 |
|---|---|
| **Variant 卡片** | risk level badge（绿/黄/橙/红）、coverageLabel |
| **Variant 详情** | evidence items 列表，每项展示 title + quote + explanation + confidence |
| **高风险声明** | 红色/橙色 warning 状态，列出 unsupportedClaims |
| **MissingInfo** | "还需补充的信息" 区域，列出 missingInfo 条目 |
| **无证据但有 items** | `sourceEvidenceIds` 为空但 `evidenceSummary.items` 有内容 → 视为 evidence snapshot，**不是错误** |

### 11.3 特殊场景

- `evidenceSummary.items` 为空 + `sourceEvidenceIds` 为空 → "该版本暂无证据支撑。"
- `riskSummary.level: "critical"` → 强提示用户核实，展示所有 warnings
- `missingInfo` 非空 → 展示 "补充以下信息可获得更好的匹配效果"

---

## 十二、推荐前端集成顺序

按优先级从高到低：

| 序号 | 集成项 | 说明 |
|---|---|---|
| 1 | **统一 API Envelope / Error Handler** | 封装 `{ ok, data/error, meta }` 解析，统一错误提示 |
| 2 | **clientState 全局注入** | 维护全局 `active*Id` 状态，每次 Copilot 请求自动附带 |
| 3 | **Pending Action 卡片生命周期** | SSE 收到 `pending_action.created` → 展示卡片 → confirm/cancel → 移除卡片 |
| 4 | **Product API 基础 CRUD** | 经历/JD/简历的列表、创建、详情、更新 |
| 5 | **文本导入 / 文件导入 Job** | /imports/text 同步路径 + /imports/file 异步 Job 轮询 |
| 6 | **JD 生成 variants** | /product/generations/from-jd → 展示 variant 卡片列表 |
| 7 | **revisionSuggestion 预览卡片** | 改写经历 / 优化简历条目的两阶段交互 |
| 8 | **evidence/risk 展示** | Variant 卡片 + 详情中的证据链、风险评级 |
| 9 | **model_not_available 错误提示** | LLM 不可用时的用户引导（配置 API Key） |
| 10 | **SSE Timeline** | Copilot Chat 流式体验 |

---

## 十三、需要前端配合的 TODO

| # | TODO 项 | 优先级 |
|---|---|---|
| 1 | **每个 Copilot 请求必须传 `clientState.active*Id`**。当前缺少 active id 会导致后端无法识别"当前正在操作哪个资源"，返回 `needs_input` | 🔴 高 |
| 2 | **Pending Action 卡片生命周期管理**。收到 SSE `pending_action.created` 后展示确认卡片；confirm 成功后移除；cancel 后移除 | 🔴 高 |
| 3 | **revisionSuggestion 预览展示**。改写经历/优化简历时，先展示 `sourceTextPreview` + `rewrittenText` 的 diff，用户确认后再提交 | 🔴 高 |
| 4 | **prepare/confirm 两阶段交互**。对于需要 confirm 的操作，前端需处理：第一步展示预览 → 用户确认 → 调用 confirm API → 刷新 | 🔴 高 |
| 5 | **evidence/risk 展示**。Variant 卡片展示 coverageLabel + risk level；详情展示 evidence items | 🟡 中 |
| 6 | **Job 轮询**。文件导入的异步 job 需要前端轮询（每 1-2 秒，最多 30 次），读取 `job.output.importJobId` 后跳转到 GET /product/imports/:importJobId | 🟡 中 |
| 7 | **model_not_available 错误弹窗**。当后端返回 LLM 不可用时，引导用户去配置 API Key（而非展示通用错误） | 🟡 中 |
| 8 | **fallback 不可用引导**。当 LLM 服务不可用且不是测试环境，明确告知"当前功能需要配置 AI 模型服务" | 🟡 中 |
| 9 | **Idempotency-Key 全局注入**。所有 POST/PATCH/DELETE 请求自动生成并附带 UUID Header | 🟢 低 |
| 10 | **SSE 流式事件解析**。`/copilot/chat/stream` 的事件类型解析和对应 UI 更新 | 🟢 低 |

---

## 十四、最终输出

### 14.1 文档文件路径

`docs/frontend_backend_contract_llm_first.md`

### 14.2 代码与契约一致性

当前代码与文档描述一致，未发现代码 bug。以下为两个已知的限制点（已在文档中标记 TODO）：

| 问题 | 详情 | 影响 |
|---|---|---|
| **BackgroundWorker 未自动启动** | `server.ts` 未在 `JOB_WORKER_ENABLED=true` 时启动 `BackgroundWorker` [src/api/server.ts](src/api/server.ts:1-37) | 文件解析/导入/导出 job 会永远 pending，前端轮询无果 |
| **AUTH_MODE `cookie_session` 为 Stub 实现** | [src/api/auth/StubCookieSessionAuthResolver.ts](src/api/auth/StubCookieSessionAuthResolver.ts) 是占位实现 | 生产环境不可用 |

### 14.3 前端最应优先接入的 5 个契约点

1. **clientState.active*Id 传递** — 这是所有 Copilot 功能的基础，缺了它 AI 无法知道你在操作什么。
2. **Pending Action 卡片生命周期** — 所有写操作（保存经历、采用版本、导出）都依赖 confirm 流程。
3. **revisionSuggestion 预览** — 改写经历和优化简历的两阶段 UI 模式。
4. **Product API 完整 CRUD** — 经历/JD/简历的基础数据通路。
5. **LLM-first 错误提示** — `model_not_available` / `needs_input` 等新错误码的用户引导。

### 14.4 当前可能导致前端"看起来跑不通"的后端限制

1. **Job Worker 需手动启动**：如果 `JOB_WORKER_ENABLED` 未设为 `true` 且未手动启动 worker，所有异步 job 会永远停在 `pending`。
2. **in_memory 模式数据不持久**：未设 `DATABASE_URL` 时数据在重启后丢失。
3. **无 LLM Key 时所有智能功能不可用**：需配置 `DEEPSEEK_API_KEY` 或 `AGENT_API_KEY` + `AGENT_MODEL_PROVIDER`。
4. **PDF 导出需额外配置**：`PDF_RENDERER=playwright` 且 Playwright 浏览器已安装，否则返回 503。
5. **Cookie Session 认证为 Stub**：生产环境需使用 `bearer_static` 或自行实现 `cookie_session`。
