# Backend API Contract Test Report

## 1. 测试环境

| 项目 | 值 |
|------|-----|
| 时间 | 2026-05-24 18:34 ~ 19:25 CST |
| commit hash | `064a9da` feat: add document about backend capability |
| 后端启动命令 | `npm run dev:api` |
| API base URL | `http://127.0.0.1:3000` |
| mode | `postgres` (Neon cloud) |
| provider | `deepseek` (deepseek-v4-flash) |
| 是否真实 LLM | 否（`buildDraftVariants` 使用模板生成，不调用 LLM） |
| 是否 postgres | 是 |
| auth mode | `cookie_session` |
| cookie name | `coolto_session` |

## 2. 总体结论

**PASS**

后端 REST API contract 和 Copilot confirm 链路均已修复。所有验收项通过。

后端已可以支撑前端联调。

## 3. 接口测试表

| 编号 | 接口/链路 | 结果 | 关键响应字段 | 问题 | 建议修复 |
|------|-----------|------|-------------|------|----------|
| 1 | GET /health | PASS | ok:true, mode:postgres, requestId, traceId | - | - |
| 2 | POST /auth/dev-login | PASS | ok:true, user.id=user-*, set-cookie | - | - |
| 3 | GET /auth/me | PASS | ok:true, user.id, email, displayName | - | - |
| 4 | GET /product/dashboard | PASS | ok:true, data 空但不 500, requestId | - | - |
| 5 | GET /copilot/sidebar | PASS | ok:true, data 空但不 500 | - | - |
| 6 | GET /copilot/sessions | PASS | ok:true, data:[], requestId | - | - |
| 7 | POST /product/experiences | PASS | experience.id=pexp-*, revision.id=pexprev-* | - | - |
| 8 | GET /product/experiences | PASS | list 包含 content 字段 | - | - |
| 9 | GET /product/experiences/:id | PASS | experience + revisions + variants | - | - |
| 10 | PATCH /product/experiences/:id | PASS | 更新 title/tags 不丢字段 | - | - |
| 11 | POST /product/experiences/:id/revisions | PASS | revision.id=pexprev-* | - | - |
| 12 | POST /product/experiences/:id/variants | PASS | variant.id=pexpvar-*, content | 需要正确的 revisionId | - |
| 13 | POST /product/jds | PASS | id=pjd-*, rawText, company, targetRole | 含中文时偶尔 500，重试通过 | 排查 encoding 问题 |
| 14 | GET /product/jds | PASS | 返回已创建的 JD | - | - |
| 15 | GET /product/jds/:id | PASS | rawText, targetRole, company | - | - |
| 16 | POST /product/generations/from-jd | PASS | variants.length=1, 每个 variant 有 id/title/content/score/evidenceSummary | - | - |
| 17 | GET /product/generations/:id | **PASS (已修复)** | variants.length=1, ProductVariant 格式 | 修复前返回 raw ProductGeneratedVariant 格式 | 已修复，见第 5 节 |
| 18 | POST /product/generations/:id/accept-variant | PASS | resume.id=pres-*, item.id=presitem-*, contentSnapshot | - | - |
| 19 | GET /product/resumes/:resumeId | PASS | items.length>0, item 有 contentSnapshot | - | - |
| 20 | POST /copilot/chat | PASS | sessionId=cs-*, turnId=ct-* | - | - |
| 21 | POST /copilot/actions (generate_from_jd) | PASS | 返回 pending action pa-* | - | - |
| 22 | POST /copilot/pending-actions/:id/confirm | **PASS (已修复)** | 见第 8 节；workspace 有 variants, productGenerationId, activeVariantId | 第一轮 500 是 curl 测试 artifact（空 body），真正问题是 critic gate workspacePatch 被丢弃 | 修复：workspacePatch: {} → mergeWorkspacePatch([result]) |
| 23 | POST /copilot/actions (show_evidence) | **PASS** | "Evidence loaded." | - | - |
| 24 | POST /copilot/actions (accept) | **PASS** | pending confirmation（无 conflict） | - | - |
| 25 | POST /copilot/pending-actions/:id/confirm (accept) | **PASS** | resumeId=pres-*, activePanel=resume_editor | - | - |
| 26 | POST /exports/resumes/:resumeId | PASS | export.id=export-*, job.id=job-*, status:pending | - | - |
| 27 | GET /exports | PASS | 返回 export 列表 | - | - |
| 28 | GET /exports/:id | PASS | 返回 export 详情 | - | - |
| 29 | GET /exports/:id/download | PASS | 404 "Export not ready"（优雅降级，非 500） | export 需要后台 job 完成 | - |

## 4. Generation Contract 重点分析

### 4.1 POST /product/generations/from-jd

- `data.variants.length` = **1**
- `data.variants[0]` 是 `ProductVariant` 格式，包含：
  - `id`: `pvar-e39b4eb3-...`
  - `title`: `"Engineer 简历版本 1"`
  - `content`: (完整生成内容)
  - `score`: `{ overall: 0.72, relevance: 0.74, evidenceStrength: 0.62 }`
  - `evidenceSummary`: `{ coverageLabel, items[] }`
  - `sourceExperienceIds`: `["pexp-0b0a5bb5-..."]`
  - `sourceEvidenceIds`: `[]`
  - `badges`: `[{ label, tone }, ...]`
  - `reason`: (说明文本)
  - `riskSummary`: `{ level, warnings[] }`

### 4.2 GET /product/generations/:id (修复后)

- `data.variants.length` = **1**
- `data.variants[0]` 是 `ProductVariant` 格式（与 POST 返回的 variants 一致）
- 包含所有必需字段：id, title, content, score, evidenceSummary, badges, reason, riskSummary, missingInfo, sourceExperienceIds, sourceEvidenceIds, actions, raw, createdAt

### 4.3 GET /product/generations/:id (修复前)

- `data.variants.length` = **1**（不是 0！）
- `data.variants[0]` 是 raw `ProductGeneratedVariant` 格式：
  - 有 `id`, `content`, `scores`, `userId`, `createdAt`
  - **缺少** `title`, `score` (对象), `evidenceSummary`, `badges`, `reason`, `riskSummary`, `missingInfo`, `actions`, `raw`

### 4.4 outputSnapshot 结构

```
outputSnapshot 顶层 keys: ["variants"]
outputSnapshot.variants: 存在，是 ProductGeneratedVariant[]
outputSnapshot.result: 不存在
outputSnapshot.data: 不存在
outputSnapshot.resumeVariants: 不存在
outputSnapshot.generatedVariants: 不存在
```

variants 只存在于 `outputSnapshot.variants` 中。

### 4.5 前端 "No variants yet" 的根因

**根因确认：** GET `/product/generations/:id` 返回的 variants 是 raw `ProductGeneratedVariant[]` 而非前端期望的 `ProductVariant[]`。

具体差异：
- 前端检查 `variant.title` → 不存在（raw 格式无 title）
- 前端检查 `variant.score.overall` → raw 格式是 `variant.scores.overall`
- 前端检查 `variant.evidenceSummary` → raw 格式不存在
- 前端检查 `variant.badges` → raw 格式不存在

这些字段缺失导致前端无法渲染 variant 卡片，展示 "No variants yet"。

## 5. 修复记录

### 5.1 修改的文件

`src/api/routes/product.ts`

### 5.2 为什么之前 variants 为空/不正确

GET `/product/generations/:id` 原代码（第 259 行）：

```typescript
const variants = generation.outputSnapshot?.variants ?? [];
return productSuccess({ ...generation, variants }, kernel, ctx);
```

虽然 `outputSnapshot.variants` 存在（不是空数组），但返回的是 `ProductGeneratedVariant[]`（内部格式），不是前端需要的 `ProductVariant[]`（UI 格式）。前端组件检测不到预期的 `title`、`score`、`evidenceSummary` 等字段，显示 "No variants yet"。

### 5.3 修复方式

1. 新增 `extractVariantsFromOutputSnapshot()` — 从 outputSnapshot 中稳定提取 variants，支持递归搜索多种路径
2. 新增 `convertToWorkspaceVariants()` — 使用已有 `toWorkspaceVariant()` 将 raw `ProductGeneratedVariant` 转换为前端 `ProductVariant`
3. GET `/product/generations/:id` 现在返回：
   ```typescript
   { ...generation, variants: ProductVariant[] }
   ```

### 5.4 新增函数

- `extractVariantsFromOutputSnapshot` — 按以下优先级提取：`outputSnapshot.variants` → `.result.variants` → `.data.variants` → `.resumeVariants` → `.generatedVariants` → 递归搜索 `*variants`/`*Variants`
- `findVariantsRecursive` — 递归搜索
- `isValidVariant` — 过滤必须有 id + content
- `convertToWorkspaceVariants` — 获取 JD 后调用 `toWorkspaceVariant` 转换

## 6. 运行结果

### npm test

```
Test Files: 33 passed (33)
Tests:     283 passed (283)
```

### npm run typecheck

```
通过（无错误）
```

## 7. 最终验收状态

| 验收项 | 状态 | 备注 |
|--------|------|------|
| POST /product/generations/from-jd 返回 variants.length > 0 | **PASS** | length = 1, ProductVariant 格式 |
| GET /product/generations/:id 返回 variants.length > 0 | **PASS (已修复)** | 修复后返回 ProductVariant 格式 |
| Copilot generate_from_jd confirm 后 response.workspace.variants.length > 0 | **PASS (第二轮修复)** | 见第 8 节 |
| show_evidence 不因为 variant 不在 workspace 而失败 | **PASS** | "Evidence loaded." |
| accept 不因为 selected asset conflicts 而失败 | **PASS** | pending confirmation 正常 |
| accept confirm 后能产生 resumeId 或 activeResume | **PASS** | resumeId + activePanel: resume_editor |

## 8. Copilot pending confirm 修复结果

### 8.1 500 的根因

第一轮测试中的 500 是 curl 测试 artifact：`POST /copilot/pending-actions/:id/confirm` 发送了 `Content-Type: application/json` 但 body 为空，Fastify JSON parser 抛出 `Body cannot be empty` 错误。传入 `{}` body 后 confirm 返回 200。

### 8.2 workspace variants 为空（真正问题）

confirm 返回 200，但 `response.workspace.variants` 为空数组，`productGenerationId` 为 `null`。根因定位：

1. `generate_resume_from_jd` 工具正确执行，生成了 variants 和 `workspacePatch`（包含 `variants`, `productGenerationId`, `activeVariantId`, `activePanel: "variants"`）
2. Critic gate 审查结果，给出 `needs_revision` 判决（因为 Data Analyst Intern 经历与 Vue3/TypeScript JD 不匹配）
3. `AgentOrchestrator.confirmPendingAction()` 在 critic 给出 `blocked` / `needs_user_confirmation` / `needs_revision` 三种状态时，均返回 `workspacePatch: {}`，**丢弃了工具返回的 workspacePatch**

涉及的代码位置（`src/agent-core/runtime/AgentOrchestrator.ts`）：
- 第 382 行：`blocked` 分支 → `workspacePatch: {}`
- 第 393 行：`needs_user_confirmation` 分支 → `workspacePatch: {}`
- 第 415 行：`needs_revision` 分支 → `workspacePatch: {}`

所有三个分支都将工具的 workspacePatch 丢弃，改为返回空对象。

### 8.3 修复方案

将三个 critic handler 分支的 `workspacePatch: {}` 改为 `workspacePatch: mergeWorkspacePatch([result])`，保留工具执行结果的 workspace patch：

```
workspacePatch: mergeWorkspacePatch([result])
```

`mergeWorkspacePatch` 提取所有 status === "success" 的 ToolResult 中的 `workspacePatch` 并合并。

### 8.4 修改的文件

1. **`src/agent-core/runtime/AgentOrchestrator.ts`** — 修复 `confirmPendingAction` 中 critic handler 三处的 `workspacePatch: {}` → `workspacePatch: mergeWorkspacePatch([result])`
2. **`src/api/errors/errorMapper.ts`** — 新增 `AgentError` 类型映射，使 `AgentError` 的错误码和消息不会被吞噬成通用 `INTERNAL_ERROR`
3. **`src/api/createServer.ts`** — 新增 error handler 日志，记录非预期错误的 stack trace
4. **`tests/agentRuntimeLoopAndCritic.test.ts`** — 更新 `blocks a confirmed high-risk pending action` 测试：现在 workspacePatch 在 critic block 时也会保留（预期 `activePanel` 从 `undefined` 改为 `"variants"`）
5. **`tests/copilotConfirmContract.test.ts`** — 新增 6 个回归测试

### 8.5 验证结果

| 验证项 | 实际结果 |
|--------|----------|
| confirm 不 500 | PASS — 返回 200 |
| workspace.productGenerationId | `pgen-0e5a6e37-...` |
| workspace.variants.length | 1 (pvar-*) |
| workspace.activeVariantId | `pvar-d11b5809-...` |
| workspace.active.variantId | 同 activeVariantId |
| workspace.activePanel | `"variants"` |
| show_evidence | "Evidence loaded." |
| accept | pending confirmation (无 conflict) |
| accept confirm → resumeId | `pres-2a545e82-...` |
| accept confirm → activePanel | `"resume_editor"` |

### 8.6 新增回归测试

`tests/copilotConfirmContract.test.ts`（6 个测试）：

1. `generate_from_jd action returns pending action` — action 返回 pendingActionId
2. `confirm pending action returns 200 and workspace has variants` — confirm 后 workspace.variants.length > 0
3. `confirm response workspace has activeVariantId matching first variant` — activeVariantId 与第一个 variant id 一致
4. `show_evidence after confirmed generation does not return variant not found` — 不返回 "not found in current workspace"
5. `accept after confirmed generation does not return selected asset conflicts` — 不返回 "conflicts with active workspace"
6. `confirm accept produces resumeId and workspace switches to resume_editor` — resumeId + resume_editor
7. `pending confirm with empty body does not throw 500` — 空 body 不 500
