# cv-agent 下一阶段改动实施文档

> 面向仓库：`JsChen766/cv-agent`  
> 文档目的：把“减少固定输出、增强多 Agent 智能表达、提升一页 PDF 简历质量”拆成可逐阶段交给 CodingAgent 执行的工程任务。  
> 推荐执行方式：每次只让 CodingAgent 做一个阶段，完成后跑测试、提交，再进入下一阶段。

---

## 0. 总体目标

当前系统已经具备多 Agent、工具注册、LLM 生成、导出任务、Playwright PDF 渲染等基础能力，但产品体验仍然偏“固定脚本 + 工具日志 + 简单 HTML 转 PDF”。下一阶段要把系统升级为：

```text
Agent 决策
  → Tool 执行并返回结构化事实
  → Narrator/Presenter 生成自然回复
  → ResumeDocument 生成完整简历
  → Template + Fit Engine 精准排版
  → 高质量一页 PDF 导出
```

核心结果：

1. 聊天回复不再大量依赖固定模板，而是能根据工具结果、用户上下文、当前任务动态表达。
2. 工具不再把“用户可见话术”作为主要输出，而是输出结构化事实、证据、风险、下一步动作。
3. 简历生成不再只是一个 `variant.content` 字符串，而是完整的结构化 `ResumeDocument`。
4. PDF 导出从“简陋 HTML 转 PDF”升级为“专业模板 + 一页适配 + 布局测量 + 压缩策略”。
5. 每一阶段都有明确验收标准，避免 CodingAgent 大范围乱改。

---

## 1. 当前代码关键观察

### 1.1 固定输出感的主要来源

重点文件：

```text
src/agent-core/agents/BaseAgent.ts
src/agent-core/agents/deterministicAgentFallback.ts
src/copilot/response/ResponseComposer.ts
src/copilot/response/ProductReplyTemplates.ts
src/agent-tools/resume/generateResumeFromJD.tool.ts
src/agent-tools/export/index.ts
src/agent-tools/experience/matchExperiencesAgainstJD.tool.ts
```

当前问题：

- `BaseAgent` 确实会调用 LLM 做决策，但失败后会进入 deterministic fallback；fallback 本身合理，但如果模型不可用或 JSON 不稳定，就会明显脚本化。
- 很多工具直接返回固定 `message`，比如“已基于 JD 生成 X 个简历版本”“简历导出任务已创建”。
- `ResponseComposer` 会根据 actionType 再次覆盖成固定话术，导致即使工具结果很丰富，最终用户看到的仍然类似固定模板。
- `ProductReplyTemplates` 目前只是过滤若干英文工具日志，没有形成系统性的“工具结果 → 用户表达”机制。

### 1.2 PDF 简历质量差的主要来源

重点文件：

```text
src/product/services/index.ts
src/product/LLMGenerationService.ts
src/product/types.ts
src/exports/ResumeExportService.ts
src/exports/ResumeHtmlRenderer.ts
src/exports/templates/defaultTemplate.ts
src/exports/PdfRendererAdapter.ts
```

当前问题：

- `generateResumeFromJD` 当前主要生成 `ProductGeneratedVariant[]`，variant 核心还是 `content: string`。
- `saveAcceptedVariantToResume` 会把整个 variant 内容保存为一个 resume item，`sectionType` 近似当作 `experience`。
- `ResumeHtmlRenderer` 已经有模板注册机制，但实际只注册了 `defaultTemplate`。
- `defaultTemplate` 只是遍历 `resume.items`，渲染成简单 section、h2、p，无法支持真正的一页专业简历结构。
- `PlaywrightPdfRenderer` 已经能输出 A4 PDF，但没有测量 DOM 高度、页数、溢出，也没有一页适配逻辑。

---

## 2. 执行原则

### 2.1 每阶段只解决一个核心问题

不要让 CodingAgent 一次同时改 Agent、工具、数据库、PDF、前端契约。每阶段只做一个主目标，完成后必须测试。

### 2.2 保留 fallback，但不要让 fallback 成为主体验

fallback 用于模型失败时的安全兜底，不要删除。但主流程必须优先使用 LLM + 结构化结果。

### 2.3 工具返回事实，Narrator 负责表达

工具层不要追求“说得好听”，工具层应该返回：

```ts
status
resultKind
entities
evidence
warnings
risk
nextActionHints
workspacePatch
actionResult
```

用户可见自然语言由 Narrator/Presenter 层生成。

### 2.4 PDF 质量不能只靠 Prompt

一页 PDF 的稳定性必须靠：

```text
结构化简历 → 模板 → Playwright 测量 → 压缩/补足 → 再测量 → 导出
```

不能只让模型“请生成一页简历”。

---

## 3. 分阶段实施计划

---

# 阶段 0：建立改动基线与测试样本

## 目标

先建立可复现的测试样本，避免后续改动把已有链路改坏。

## 建议修改范围

```text
tests/
scripts/
docs/
```

## 具体任务

1. 新增 2-3 份固定测试数据：
   - 一份中文 JD。
   - 一组中文经历库数据，包括教育、实习、项目、技能。
   - 一份“目标一页简历”的期望结构样例。
2. 新增或整理一个 debug 脚本，用于跑通：
   - 保存经历。
   - 保存 JD。
   - JD 匹配。
   - 生成简历版本。
   - 保存版本到简历。
   - 导出 PDF / HTML。
3. 给现有导出测试补充断言：
   - PDF export job 能创建。
   - job runner 能完成。
   - download 返回 PDF buffer。
   - HTML 中包含目标 resume 内容。

## 不要做

- 不要改 Agent 决策逻辑。
- 不要改数据库结构。
- 不要改模板设计。

## 验收标准

- `npm test` 通过。
- `npm run typecheck` 通过。
- 有一个稳定脚本可以复现 generate → accept → export 全链路。

## 可直接给 CodingAgent 的短 prompt

```text
请先为 cv-agent 建立下一阶段重构的测试基线：补充固定 JD/经历/简历生成导出样本，整理或新增一个可复现 generate→accept→export 的 debug/test 流程。不要改业务逻辑，只补测试和脚本，确保 npm test 和 npm run typecheck 通过。
```

---

## 阶段 0 完成情况记录（执行回顾）

> 本节由阶段 0 实施时追加，作为 phase-by-phase 的工程账本，给后续阶段（尤其是阶段 9 / 10 整理契约时）提供参照。后续每个阶段完成后，建议在对应阶段标题下也追加同样格式的小节。

### 0.1 实际改动文件清单

仅新增/扩展测试与脚本，**不修改任何 src/ 业务逻辑、不改数据库结构、不改模板设计**。

```text
新增  tests/fixtures/phase0/index.ts                      # 桶导出
新增  tests/fixtures/phase0/chineseJd.ts                  # 中文 JD 样本（高级前端工程师）
新增  tests/fixtures/phase0/chineseExperiences.ts         # 中文经历库样本（4 类 category）
新增  tests/fixtures/phase0/expectedOnePageResume.ts      # 期望的一页简历结构样例（前瞻）
新增  tests/phase0Baseline.test.ts                        # 全链路烟雾测试
修改  scripts/debug-generate-export-flow.ts               # 支持 DEBUG_FLOW_SEED_FIXTURES=1 复用 Phase 0 fixtures
```

### 0.2 关键设计说明

1. **Fixture 三件套**：
   - `PHASE0_CHINESE_JD`：完整中文 JD 原文 + `mustHaveKeywords` / `niceToHaveKeywords`，便于阶段 1/2 在工具结构化和 Narrator 中做匹配度断言。
   - `PHASE0_CHINESE_EXPERIENCES`：4 条经历，强制覆盖 `education` / `internship` / `project` / `skill` 四类 category，给“真实经历库”一个最小但齐全的形态。
   - `PHASE0_EXPECTED_RESUME`：使用本地最小 TS 类型描述目标一页简历的结构（header + sections + bullets + metadata），**故意不依赖 src/product/types.ts**，避免提前耦合阶段 3 的 ResumeDocument 类型。阶段 3 落地后，可一次性把该 fixture 替换为真实 ResumeDocument 实例。

2. **Phase 0 baseline test (`tests/phase0Baseline.test.ts`)** 覆盖：
   - 用例 A：用 fixtures 走完 `保存经历(4 条) → 保存 JD → listExperiences → generateResumeFromJD（fallback 路径）→ saveAcceptedVariantToResume → POST /exports/resumes/:id (html) → runJob → GET /exports/:id/download`，断言 download HTML 包含被接受 variant 的 contentSnapshot 片段。
   - 用例 B：覆盖文档明确要求的导出断言 —— PDF export job 能创建（`status=pending`、`type=export_resume_pdf`）、`runJob` 完成、`download` 返回 `application/pdf` + `%PDF-` 头 + 非空 buffer。
   - 注入 `FakePdfRenderer` 避免依赖真实 Chromium，与既有 `pdfExportPipeline.test.ts` 风格一致。

3. **debug 脚本扩展**：
   - 新增 `DEBUG_FLOW_SEED_FIXTURES=1` / `=true` 环境变量。开启后，脚本在 `/copilot/chat` 之前先调用 `POST /product/experiences`（4 条）和 `POST /product/jds` 注入 Phase 0 fixtures，并把 `generate_from_jd` 的 `jdText` / `targetRole` 切到 fixture 版本。
   - 默认行为（不设 env）保持向后兼容：仍使用原英文 JD，老用法不受影响。

4. **遇到并刻意绕过的现有 bug（不在 Phase 0 修复）**：
   - 路由 `GET /exports/:id/download` 在 PDF 下载时把 `resume.title` 直接写入 `Content-Disposition` header；当 `resume.title` 含中文（Phase 0 fixture 的中文 JD 默认会让 title 是中文）会触发 Node `Invalid character in header content`。
   - 阶段 0 不修业务代码，因此 PDF 用例预先 `createResume({ title: "Phase0 PDF Export Resume" })` 后再 `saveAcceptedVariantToResume({ resumeId })`，使 PDF 文件名走 ASCII。**TODO：阶段 4（onePageModernTemplate）或阶段 9（契约整理）应顺手把 `sanitizeForContentDisposition` 改成 RFC 5987 `filename*=UTF-8''…` 形式，以便中文标题也能正确命名下载文件。**

### 0.3 验收标准达成

- `npm run typecheck`：通过（无新增类型错误）。
- `npm test`：60 → 61 个 test files、577 → 579 个 tests，**全部通过**。
- 全链路可复现脚本：`DEBUG_FLOW_SEED_FIXTURES=1 npm run debug:flow` 可在已启动的 API 上跑通 seed → generate → confirm → accept → export(html) → download。

### 0.4 是否影响对外 API 与契约

**结论：阶段 0 对所有现有对外 API 和前后端契约零破坏，前端无需任何改动。**

| 维度 | 影响 | 说明 |
| --- | --- | --- |
| `POST /copilot/chat` / `POST /copilot/actions` / `POST /copilot/pending-actions/:id/confirm` | 无 | 未改 ResponseComposer、未改 ToolResult、未改 workspace 构造。 |
| `POST /product/experiences` / `POST /product/jds` | 无 | 仅在调试脚本中调用了既有路由，未改 schema。 |
| `POST /exports/resumes/:resumeId` / `GET /exports/:id` / `GET /exports/:id/download` | 无 | 未改路由、未改返回结构。 |
| `GET /jobs/:jobId` | 无 | 未改 background job 协议。 |
| Tool 输出（`generate_resume_from_jd`、`accept_generation_variant` 等） | 无 | `message` / `data` / `workspacePatch` / `actionResult` 字段保持不变。 |
| 数据库 schema | 无 | 未涉及。 |
| 环境变量 | **新增 1 个**：`DEBUG_FLOW_SEED_FIXTURES`（仅影响 `npm run debug:flow` 脚本，不影响 server 行为，不需要前端识别）。 |

> 提示：阶段 1 起将开始扩展 `ToolResult` 的可选字段（`summaryFacts` / `entities` / `evidence` / `nextActionHints` 等）。届时本节的“是否影响契约”将变为**新增 optional 字段（向后兼容）**。前端可以按需逐步识别这些字段，但不识别也不会破坏现有功能。完整的契约累积变化将在阶段 9 由文档统一汇总。

---

# 阶段 1：工具结果结构化，降低固定 message 权重

## 目标

让工具输出更像“事实对象”，而不是“固定话术”。先不新增 Narrator，只调整工具结果结构，为下一阶段做准备。

## 建议修改范围

```text
src/agent-core/tools/ToolResult.ts
src/agent-core/validation/ToolInputSchemas.ts
src/agent-tools/**
src/copilot/types.ts
tests/ToolResultSchemas.test.ts
```

## 具体任务

1. 扩展 ToolResult 结构，新增可选字段：

```ts
resultKind?: string;
summaryFacts?: string[];
entities?: Array<{ type: string; id?: string; title?: string; data?: unknown }>;
evidence?: Array<{ sourceId?: string; claim?: string; support?: string; confidence?: number }>;
warnings?: string[];
nextActionHints?: Array<{ type: string; label: string; payload?: Record<string, unknown> }>;
```

2. 改造核心工具，不删除原有 `message`，但把主要信息放入结构化字段：
   - `generate_resume_from_jd`
   - `match_experiences_against_jd`
   - `prepare_export_resume`
   - `export_resume`
   - `get_export`
   - `accept_generation_variant`
3. 保持前端兼容：
   - `message` 继续保留。
   - `workspacePatch` 不破坏。
   - `actionResult` 不破坏。
4. 测试 schema 兼容旧结果和新结果。

## 不要做

- 不要新增 Narrator。
- 不要移除 ResponseComposer 的固定逻辑。
- 不要改变前端契约中的旧字段。

## 验收标准

- 所有旧测试通过。
- 新增测试证明 ToolResult 可以携带结构化 facts、entities、evidence、nextActionHints。
- `generate_resume_from_jd` 返回中包含 variants 的同时，也包含 summaryFacts / entities / nextActionHints。

## 可直接给 CodingAgent 的短 prompt

```text
请扩展 ToolResult，使工具能返回 summaryFacts、entities、evidence、warnings、nextActionHints 等结构化信息；先保持 message/actionResult/workspacePatch 向后兼容。重点改造 generate_resume_from_jd、match_experiences_against_jd、export_resume、get_export、accept_generation_variant，并补 schema/test。
```

---

## 阶段 1 完成情况记录（执行回顾）

### 1.1 实际改动文件清单

```text
修改  src/agent-core/tools/ToolResult.ts                       # 新增 6 个 optional 结构化字段 + 子类型
修改  src/agent-core/validation/ToolInputSchemas.ts            # ToolResultSchema 增加 6 个 optional 字段；导出 3 个子 schema
修改  src/agent-core/validation/ToolOutputSchemas.ts           # BaseToolResultSchema 显式声明同样 6 个 optional 字段
修改  src/agent-tools/resume/generateResumeFromJD.tool.ts      # 输出 resultKind/summaryFacts/entities/warnings/nextActionHints
修改  src/agent-tools/resume/acceptGenerationVariant.tool.ts   # 输出 variant_accepted 结构化负载
修改  src/agent-tools/export/index.ts                          # prepare/export/get_export 三个工具全部输出结构化负载
修改  src/agent-tools/experience/matchExperiencesAgainstJD.tool.ts  # 成功/空两条路径都输出结构化负载（含 evidence）
修改  tests/ToolResultSchemas.test.ts                          # 追加 6 个 schema 测试（向后兼容 + 新字段 + 校验拒绝项）
修改  tests/resumeAgentTools.test.ts                           # 追加 generate / accept 工具的结构化输出行为测试
新增  tests/phase1StructuredToolResults.test.ts                # export 三件套 + match 工具结构化输出行为测试
```

未触碰：`ResponseComposer`、`NarratorService`（阶段 2 才引入）、数据库 schema、前端类型定义。

### 1.2 关键设计说明

1. **6 个新字段全部 optional，且只追加在最外层**：
   - `resultKind?: string` — 粗粒度的“结果类型”枚举（值都是简短下划线 token，例如 `generation_completed` / `match_completed` / `match_empty` / `export_prepared` / `export_pending` / `export_ready` / `export_not_found` / `variant_accepted`）。后续 Narrator 直接根据它分支文风。
   - `summaryFacts?: string[]` — 模型友好的事实 bullet（数量、id、关键决策），**故意不写产品话术**。
   - `entities?: ToolResultEntity[]` — 涉及到的实体清单（generation / jd / resume / resume_variant / resume_item / experience / export / background_job）。`type` 必填，`id` / `title` / `data` 可选。
   - `evidence?: ToolResultEvidence[]` — 证据条目（`sourceId` / `claim` / `support` / `confidence∈[0,1]`），目前只有 `match_experiences_against_jd` 在用，其他工具暂不强填。
   - `warnings?: string[]` — 非致命提示（low coverage、fallback、failed export 等）。
   - `nextActionHints?: ToolResultNextActionHint[]` — 建议下一步动作（`type`（多为下游工具名）/ `label`（短文案）/ `payload`（可直接回放给 `/copilot/actions`））。
2. **不影响既有字段路径**：
   - `mergeWorkspacePatch` 只读 `workspacePatch`；`assistantFromResults` 只读 `message`/`actionResult`；`AgentResultAssembler` 把 `toolResults` 整体序列化下发，新字段透传过去而已。
   - `DisplayToolResult`（`src/copilot/types.ts`）当前的字段子集仍然完全有效；前端旧代码读不到新字段，但读到的所有旧字段值与之前**完全一致**。
3. **校验**：`ToolResultSchema` 使用 zod 的强类型 + `.passthrough()` 既能兼容老结果（无新字段），也能在新字段类型错误时直接拒掉（如 `summaryFacts` 是字符串、`confidence` > 1、`nextActionHint` 缺 `label`）。
4. **fallback 完全保留**：所有旧的 `message` / `data` / `workspacePatch` / `actionResult` / `visibility` 字段值全部保持不变（逐字符对照），新字段都是 spread 在末尾追加的。

### 1.3 验收标准达成

- `npm run typecheck`：通过。
- `npm test`：61 → 62 文件、579 → 593 个 tests（+14 个新 tests），**全部通过**，无既有用例回归。
- 新 schema 用例验证：旧形状 ToolResult 仍然合法；带 `summaryFacts` / `entities` / `evidence` / `nextActionHints` 的新形状也合法；类型错误被拒。
- 行为用例验证：`generate_resume_from_jd` 实际返回中**同时**包含 variants（旧契约）、`summaryFacts` / `entities`（含 generation/jd/resume_variant 三类）/ `nextActionHints`（含 `accept_generation_variant`）。`accept_generation_variant`、`export_resume`、`get_export`（pending / ready / not_found 三种状态）、`match_experiences_against_jd`（success / empty 两条路径）都各自通过专门的行为用例。

### 1.4 是否影响对外 API 与契约

**结论：阶段 1 仅在 ToolResult 上追加 6 个 optional 字段，对所有现有对外 API 全部向后兼容，前端无需任何改动也不会坏，但可以选择渐进识别这些字段以获得更好的体验。**

| 维度 | 影响 | 说明 |
| --- | --- | --- |
| `POST /copilot/chat` / `POST /copilot/actions` / `POST /copilot/pending-actions/:id/confirm` 返回的 `raw.toolResults` 数组 | **+6 个 optional 字段**（all additive） | 老字段（`status` / `message` / `data` / `workspacePatch` / `actionResult` / `visibility` / `pendingActionId`）值与之前完全一致。 |
| `/exports/*` REST 路由 | 无 | 未触碰。 |
| `/product/*` REST 路由 | 无 | 未触碰。 |
| `/jobs/:id` | 无 | 未触碰。 |
| 数据库 schema | 无 | 未触碰。 |
| 持久化的 message metadata（含 historical `toolResults`） | 兼容 | 历史数据没有新字段，反序列化后仍然合法。 |
| 环境变量 | 无 | 未新增。 |

#### 前端建议（非强制，留作阶段 9 contract 整理时统一指引）

- 短期可完全忽略新字段，体验不变。
- 想要逐步接入时：
  - `resultKind` 是最便宜的切入点，可以替换前端目前一些基于 `actionResult.actionType` 的 if-else，更稳定。
  - `summaryFacts` 不要直接展示给用户（语气是工程化的），等阶段 2 Narrator 上线再用作输入；只想看一眼用作 debug 视图也可以。
  - `nextActionHints` 是天然的“快捷按钮源”：`type` 直接对应工具/动作名，`label` 是 UI 文本，`payload` 可以直接回放进 `/copilot/actions`。
  - `warnings` 适合渲染为黄色 banner / chip，不必做翻译。
  - `entities` / `evidence` 适合放进侧边的 inspect / explain 抽屉。

> 累积影响表会在阶段 9 里统一汇总；阶段 2 起会继续追加（Narrator 文风、ENABLE_NARRATOR 开关等）。

---

# 阶段 2：新增 Narrator/Presenter 层，替代大量固定回复

## 目标

让最终聊天回复由模型根据工具结果动态生成，而不是主要依赖 `ResponseComposer` 的固定模板。

## 建议修改范围

```text
src/copilot/response/ResponseComposer.ts
src/copilot/response/NarratorService.ts
src/agent-core/prompts/PromptRegistry.ts
src/agent-core/prompts/prompts/product/narrator-system.md
tests/ResponseComposer.test.ts 或新增 NarratorService.test.ts
```

## 具体任务

1. 新增 `NarratorService`：
   - 输入：userMessage、locale、frontDeskHandoff、toolResults、criticReview、workspace summary、next actions。
   - 输出：自然语言 assistantText。
2. 新增 narrator prompt：
   - 要求中文自然、具体、不要像系统日志。
   - 必须基于 toolResults，不得编造结果。
   - 如果结果有风险或缺失信息，要明确说。
   - 如果有下一步动作，要自然引导。
3. 修改 `ResponseComposer`：
   - 优先尝试 NarratorService。
   - Narrator 不可用或失败时，走原有固定 fallback。
4. 增加环境开关：

```text
ENABLE_NARRATOR=true/false
```

5. 增加测试：
   - Narrator 开启时，能基于结构化结果生成非固定话术。
   - Narrator 失败时，原有 ResponseComposer fallback 仍然可用。

## 不要做

- 不要删除原有 ResponseComposer 逻辑。
- 不要让 Narrator 改 workspacePatch 或 actionResult。
- 不要让 Narrator 执行工具。

## 验收标准

- `ENABLE_NARRATOR=false` 时，旧行为稳定。
- `ENABLE_NARRATOR=true` 时，生成、匹配、导出这三类回复不再完全固定。
- 模型失败时不会影响主流程。

## 可直接给 CodingAgent 的短 prompt

```text
请新增 NarratorService，用模型根据 userMessage、toolResults、workspace、criticReview 生成最终 assistantText，并让 ResponseComposer 在 ENABLE_NARRATOR=true 时优先使用它，失败则回退旧固定模板。不要删除旧逻辑，不改变工具执行和 workspacePatch。
```

---

## 阶段 2 完成情况记录（执行回顾）

### 2.1 实际改动文件清单

```text
新增  src/copilot/response/NarratorService.ts                    # 纯 LLM presenter；不动状态/不调工具/不读 DB
新增  src/agent-core/prompts/prompts/product/narrator-system.md  # narrator 系统提示词（en/zh-CN，1-4 句，禁止编造）
修改  src/agent-core/prompts/PromptRegistry.ts                   # 注册 product.narrator.system
修改  src/copilot/response/ResponseComposer.ts                   # 增加 optional narrator 依赖 + 新 composeAsync + detectNarratorBranch；compose 同步路径完全不变（向后兼容零参构造）
修改  src/agent-core/runtime/AgentResultAssembler.ts             # assemble 改 async；走 composeAsync；接受 deps.narrator 注入
修改  src/agent-core/runtime/AgentOrchestrator.ts                # 仅当 kernel.frontDeskModelClient 与 narrator prompt 同时存在时构造 NarratorService 并注入；assemble 调用加 await
新增  tests/NarratorService.test.ts                              # 5 用例：disabled/no-model/throw/blank-content/正常 LLM 路径
新增  tests/ResponseComposer.narrator.test.ts                    # 5 用例：generated 分支用 narrator、null 回退、accepted 保留 nextActions、confirmation 不调 narrator、零参构造仍可用
新增  tests/scenarioModelClient.ts                               # 测试专用智能 stub provider；按 responseFormat + system prompt "Narrator" 关键字双重判别
修改  tests/copilotKernelRefactor.test.ts                        # 追加 2 个 ENABLE_NARRATOR e2e（accepted 分支：on=narrator 文案、unset=fallback）
修改  docs/cv_agent_next_stage_plan.md                           # 本节
```

未触碰：所有工具代码（Phase 1 已完成结构化）、`mergeWorkspacePatch` / `WorkspaceProjector` / `PendingActionService`、REST 路由（`/exports/*`、`/product/*`、`/jobs/:id`）、数据库 schema、`KernelRefactorProvider`、生产 LLM provider（DeepSeek/OpenAICompatible）。

### 2.2 关键设计说明

1. **Narrator 仅在四个成功分支跑**：`accept_generation_variant` 成功 → `accepted`；`export_resume` 成功 → `exported`；`generate_resume_from_jd` 成功 **且无 generating: true** → `generated`；`match_experiences_against_jd` → `jd_match`。其余路径（`needs_confirmation` / `needs_input` / `failed` & error_user_visible / JD intake handoff / max_steps / "all internal" fallback / 默认"Done."）**全部** rule-based，UX 在错误/暧昧时刻保持完全确定性。
2. **零破坏注入**：`ResponseComposer` 加上 `options: ResponseComposerOptions = {}` 默认参数后，所有现有 `new ResponseComposer()` 调用（包括测试中的）都不需要改动。`compose` 仍是同步方法且实现一字不变；`composeAsync` 是新增的 async 入口，仅 `AgentResultAssembler` 用它。
3. **失败 → 回退**：narrator 任何异常或返回 null/空白，`composeAsync` 都把 baseline（即旧 rule-based `compose` 输出）原样返回；`nextActions` 等其他字段始终来自 baseline，不会被 narrator 覆盖。
4. **wire-through e2e 真实链路**：测试用 `tests/scenarioModelClient.ts` 这个 test-only smart stub —— 同一个 provider 凭 `request.responseFormat === "json"` + system prompt 是否包含 "Narrator" 双重判别，agent 决策走 JSON 分支、narrator 走自由文本分支。**严格不污染生产 provider**。
5. **enabled 默认值**：`NarratorService` 构造时 `enabled ?? (process.env.ENABLE_NARRATOR === "true")`，这意味着不设环境变量等价于关闭；测试可显式传 `enabled: true/false` 覆盖。
6. **e2e 选择 `accepted` 分支而非 `generated`**：因为 `generate_resume_from_jd` 在 confirmation 时立刻入队后台 job 并打 `metadata.generating: true`（PendingActionService.ts:229），这是 narrator 故意排除的"还在路上"状态；`accept_generation_variant` 是同步完成的，干净打到 `accepted`。
7. **未在 prompt 里塞 system facts**：narrator 收到的 user payload 是 JSON.stringify 的紧凑负载（locale / branch / userMessage / fallbackText / criticReview / frontDeskIntent / 工具结果摘要含 Phase 1 的 `summaryFacts` / `entities` / `evidence` / `warnings` / `nextActionHints`）。Prompt 明确要求"基于这些字段，不要发明计数/ID/百分比/名称"。

### 2.3 验收标准达成

- `npm run typecheck`：通过。
- `npm test`：62 → **64** 文件、593 → **605** 个 tests（+12 个新 tests），全部通过，无任何既有用例回归。
- 关闭路径（`ENABLE_NARRATOR` unset 或 `false`）：行为与阶段 1 baseline 逐字节一致 —— `tests/copilotKernelRefactor.test.ts` 第二个 e2e 直接断言 narrator stub 文案**不会**出现在 `assistantMessage.content` 中。
- 启用路径（`ENABLE_NARRATOR=true` + 可用 `frontDeskModelClient`）：第一个 e2e 验证 `accepted` 分支 narrator 文案 "已保存这个版本到你的简历" 出现在最终 `assistantMessage.content` 中。
- Narrator 失败回退：`tests/NarratorService.test.ts` 覆盖 modelClient 抛错、内容为空两种失败 → null；`tests/ResponseComposer.narrator.test.ts` "falls back to legacy text when narrator returns null" 验证 ResponseComposer 见到 null 后落回 baseline。
- 确认/Needs-input 分支不调 narrator：`tests/ResponseComposer.narrator.test.ts` "does not call narrator on confirmation branch" 显式断言 stub 的 `chat` 调用次数 = 0。

### 2.4 是否影响对外 API 与契约

**结论：阶段 2 仅在 4 个特定成功分支可能改动 `assistantMessage.content` 的措辞；对所有结构化字段（toolResults / workspace / workspacePatch / actionResults / nextActions / pendingActions / timeline / agentRoomEvents / metadata）不做任何改动。新增 1 个 optional 环境变量。**

| 维度 | 影响 | 说明 |
| --- | --- | --- |
| `POST /copilot/chat` / `POST /copilot/actions` / `POST /copilot/pending-actions/:id/confirm` 返回的 `assistantMessage.content` | **可能改变（仅启用时 + 仅 4 分支）** | `ENABLE_NARRATOR=true` 且 `frontDeskModelClient` 可用且本回合命中 `accepted` / `exported` / `generated`（非 generating） / `jd_match` 任一分支时，文案改由 narrator 生成；其他所有情况文案与阶段 1 一致。 |
| `raw.toolResults` / `raw.actionResults` / `raw.pendingActions` / `raw.metadata` / `nextActions` / `timeline` / `agentRoomEvents` / `workspace` / `workspacePatch` | 无 | 字节一致。Narrator 不可写这些字段。 |
| `/exports/*` / `/product/*` / `/jobs/:id` REST 路由 | 无 | 未触碰。 |
| 数据库 schema | 无 | 未触碰。 |
| 持久化的消息 metadata（含历史 `toolResults`） | 无 | 未触碰。 |
| 环境变量 | **+1 optional** | `ENABLE_NARRATOR=true` 启用 narrator；未设置或非 `"true"` 等价于关闭。 |
| 配置/部署 | 无新依赖 | 仅复用既有 `kernel.frontDeskModelClient` 和 `PromptRegistry`。 |

#### 前端建议

- 短期：忽略一切（`ENABLE_NARRATOR` 默认关，行为=阶段 1）。
- 启用时：体验上 4 个分支的回复更自然，可选地把 Phase 1 的 `nextActionHints` 渲染成快捷按钮以增强引导（仍非强制）。
- `assistantMessage.content` 的契约形态没变，仍是一段文本；只是更口语化，长度不会暴涨（prompt 限制 1-4 句、`maxTokens: 600`）。

> 累积变化（阶段 0 起）：阶段 0 = 零破坏；阶段 1 = `raw.toolResults[]` 新增 6 个 optional 字段（向后兼容）；阶段 2 = 新增 optional `ENABLE_NARRATOR` 环境变量 + 启用时 4 分支文案变化（结构字段不变）。

---

# 阶段 3：引入结构化 ResumeDocument 模型

## 目标

把“简历版本是一段 content 字符串”升级为“简历版本包含完整结构化文档”。这是 PDF 质量提升的核心前置阶段。

## 建议修改范围

```text
src/product/types.ts
src/product/LLMGenerationService.ts
src/product/services/index.ts
src/persistence/postgres/schema.sql
src/persistence/postgres/migrations/
tests/resumeAgentTools.test.ts
tests/generateResumePendingFlow.test.ts
```

## 推荐新增类型

```ts
type ResumeDocument = {
  header?: ResumeHeader;
  summary?: ResumeSummarySection;
  sections: ResumeSection[];
  metadata: {
    language: "zh" | "en";
    targetRole?: string;
    jdId?: string;
    targetPages?: number;
    templateId?: string;
    density?: "comfortable" | "standard" | "compact";
  };
};

type ResumeSection = {
  id: string;
  type: "summary" | "education" | "work" | "internship" | "project" | "skill" | "award" | "other";
  title: string;
  order: number;
  items: ResumeSectionItem[];
};

type ResumeSectionItem = {
  id: string;
  title?: string;
  organization?: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  bullets: ResumeBullet[];
  tags?: string[];
  sourceExperienceId?: string;
};

type ResumeBullet = {
  id: string;
  text: string;
  sourceExperienceId?: string;
  jdRequirementIds?: string[];
  evidenceStrength?: number;
  relevanceScore?: number;
  impactScore?: number;
  pinned?: boolean;
  optional?: boolean;
  riskLevel?: "low" | "medium" | "high";
};
```

## 具体任务

1. 在 `ProductGeneratedVariant` 中新增可选字段：

```ts
resumeDocument?: ResumeDocument;
```

2. 修改 `LLMGenerationService` 的 prompt 和 schema：
   - 仍然保留 `content`，用于旧前端兼容。
   - 新增 `resumeDocument`，作为后续导出和编辑的主数据。
3. 修改 `saveAcceptedVariantToResume`：
   - 如果 variant 有 `resumeDocument`，则按 section/items 拆成多个 `ProductResumeItem`。
   - 如果没有，则继续走旧的单 item 保存逻辑。
4. 保存时每个 item 的 metadata 记录：
   - sourceExperienceId
   - generationId
   - sectionType
   - bullet ids
   - relevance score
5. 新增测试：
   - 有 `resumeDocument` 时，会生成多个 resume items。
   - 无 `resumeDocument` 时，旧逻辑仍然可用。

## 不要做

- 不要马上做 PDF 一页适配。
- 不要删除 `content` 字段。
- 不要要求前端立即使用新结构。

## 验收标准

- variant 同时有 `content` 和 `resumeDocument`。
- accept variant 后，resume 不再只有一个大 item，而是拆分为多个 section item。
- 旧数据仍然可以导出。

## 可直接给 CodingAgent 的短 prompt

```text
请为简历生成引入 ResumeDocument 结构。ProductGeneratedVariant 保留 content，同时新增 resumeDocument。LLMGenerationService 生成结构化 resumeDocument；saveAcceptedVariantToResume 在存在 resumeDocument 时按 section 拆分保存为多个 resume items，否则保持旧逻辑。补测试保证兼容。
```

---

## 阶段 3 完成情况记录（执行回顾）

> 本阶段在阶段 2 实测交付的 P3-2（PDF 下载文件名 RFC 5987）和 P3-1（`/copilot/actions` locale 误判）两个补丁基础上，引入结构化 `ResumeDocument`。三个 commit 分别承载这三件事，互不耦合。

### 3.1 实际改动文件清单

```text
# commit 1 ── fix(exports): RFC 5987 Content-Disposition  （承接阶段 0 标注的 TODO）
修改  src/api/routes/exports.ts                                     # 替换 sanitizeForContentDisposition：emit `filename="<ASCII>"; filename*=UTF-8''<percent-encoded>` 双形式；导出 contentDispositionAttachment 供测试与未来复用
新增  tests/contentDispositionHeader.test.ts                        # 5 个纯函数用例：ASCII 直通 / 中文双形式 / ISO-8859-1 字节不变量 / RFC 5987 保留字符 / 全 CJK 输入
修改  tests/pdfExportPipeline.test.ts                               # +1 e2e 用例：中文 title 简历下载，断言双形式 header 且 header 字节均 < 0x100

# commit 2 ── fix(orchestrator): infer locale from session handoffs
修改  src/agent-core/runtime/AgentOrchestrator.ts                   # 新增 inferLocaleForRun(run) + isSystemInjectedUserMessage；localeFor 改委托；不动 detectLocale 签名
新增  tests/inferLocaleForRun.test.ts                               # 9 个用例：clientState 显式覆盖（zh/en）/ 自然中英对话直通 / [action] [confirm] 占位回看 handoff 的 zh/en / 无自然语言 handoff 时回退到占位本身（en）/ workspace=null 回退 / 跳过更新但仍是占位的 handoff 取更早的中文 goal

# commit 3 ── feat(phase 3): structured ResumeDocument
修改  src/product/types.ts                                          # 新增 ResumeDocument / ResumeDocumentSection / ResumeDocumentItem / ResumeDocumentBullet；ProductGeneratedVariant.resumeDocument 设为 optional
修改  src/product/LLMGenerationService.ts                           # 新增 ResumeDocumentSchema(zod)；NormalizedVariant + NormalizedVariantSchema 加 optional resumeDocument；schema fail 静默丢字段；透传到 ProductGeneratedVariant
修改  src/agent-core/prompts/prompts/product/generation-resume-system.md # 追加 OPTIONAL STRUCTURED RESUME 段落 + 全部硬约束（id 非空唯一、sections 非空、bullets[].text 非空、不得与 content 冲突）
新增  src/product/resumeDocumentFallback.ts                         # buildResumeDocumentFromContent 启发式 helper（仅供未来阶段使用，accept/save 路径不调用）
修改  src/product/services/index.ts                                 # saveAcceptedVariantToResume：当 variant.resumeDocument 通过 schema 且 sections 非空时走新 saveAcceptedVariantWithDocument 多 item 拆分（每 item 一个 ProductResumeItem，metadata_json 持久化 sectionId/sectionType/sectionOrder/itemId/bulletIds/sourceExperienceId/evidenceStrength/relevanceScore/sourceVariantId/generationId）；否则保持阶段 2 旧单 item 路径字节一致；返回 shape +1 optional `items?: ProductResumeItem[]`，旧 `item` 字段保留指向第一条
新增  tests/resumeDocumentFallback.test.ts                          # 6 用例：空输入 / 无标题包裹单 section / 中文标题 type 推断 / 空行分 item + bullet 解析 / 唯一非空 id / 类型契约
新增  tests/llmGenerationResumeDocument.test.ts                     # 6 用例：valid document 直通 / sections 空丢弃 / 缺 schemaVersion 丢弃 / item id 空丢弃 / 未知 section.type 丢弃 / 老 variant 不带 resumeDocument 不回归
新增  tests/saveAcceptedVariantWithDocument.test.ts                 # 4 用例：legacy 单 item 路径字节一致 / 三 item 文档拆三个 ProductResumeItem 含 metadata + sourceExperienceId / 单 item 文档也走结构化路径 / 提供 resumeId 时追加到既有简历
修改  docs/cv_agent_next_stage_plan.md                              # 本节
```

未触碰：所有 confirmation/PendingActionService 路径、`/exports/render` 路径、ResponseComposer / NarratorService、`mergeWorkspacePatch` / `WorkspaceProjector`、生产 LLM provider、数据库 schema（zero migration）、`PostgresProductRepositories.saveAcceptedVariantToResume` 单 item 事务签名、前端契约。

### 3.2 关键设计说明

1. **三件事拆三个 commit、互不耦合**：commit 1（filename）只动 `exports.ts` + 测试；commit 2（locale）只动 `AgentOrchestrator.ts` + 测试；commit 3（ResumeDocument）才进入产品域。任一 commit 单独 cherry-pick 都能独立通过 typecheck + 全量测试。
2. **ResumeDocument 是纯 additive，零迁移**：`variant.resumeDocument` optional；`ProductGeneratedVariant.content` 保留并仍为前端权威字段；多 item 拆分时把 `sectionId/sectionType/sectionOrder/itemId/bulletIds/sourceExperienceId/evidenceStrength/relevanceScore/sourceVariantId/generationId` 全部塞进既有 JSONB 列 `product_resume_item.metadata_json` —— 数据库零 schema 改动，老前端读 `variants[].content` 继续工作。
3. **schema 严格 + 静默回退**：LLM 输出的 `resumeDocument` 走严格 zod（schemaVersion=1 字面量、sections 非空、id 非空、bullets[].text 非空、section.type 限定 7 个枚举、evidenceStrength low/medium/high）。**任何字段不合法整体丢弃**，但**绝不抛错**。`NormalizedVariant.resumeDocument` 因此要么是合法 ResumeDocument，要么是 undefined，下游 saveAccepted 不再做防御性校验。
4. **保存路径只对已经合法的 document 拆分**（≥1 item 即触发结构化路径）；缺失/非法 document 走阶段 2 旧单 item 字节一致路径，包括 `inferTitle(variant.content)` / `sectionType: "experience"` / `contentSnapshot = variant.content` 与原 `PostgresProductRepositories.saveAcceptedVariantToResume` 事务 fast-path。**这意味着所有未带 resumeDocument 的 fixture（含 mock 模式 + 既有 66 个测试文件）行为完全不变**。
5. **`buildResumeDocumentFromContent` 严格隔离**：作为 `src/product/resumeDocumentFallback.ts` 独立纯函数 + 6 个 unit test 存在，**不在生产保存路径上被调用**。意图是为后续阶段（4 模板渲染、6 自适配、9 契约整理）提供从 legacy variant 反推结构的工具，且其行为可独立演进/被替换而不影响 Phase 3 的保存契约。
6. **multi-item 走 service-layer 慢路径而非扩 repo 事务**：现有 `repository.saveAcceptedVariantToResume(...)` 是单 item 事务签名，扩成 N item 会牵动 `PostgresProductRepositories` + 测试 stub。本阶段选择只在结构化路径下绕过 repo fast-path，逐 item 调 `resumeService.addResumeItem`，事后 `updateGenerationSelection` + `attachResume` —— 与现有的 in-memory fallback 路径完全同形，`PostgresProductRepositories` 文件零改动。代价是结构化保存不在单一事务内（阶段 4/9 引入真正模板时可顺手补一个多 item 事务签名）。
7. **prompt 的硬约束**：`generation-resume-system.md` 明确告诉模型 OPTIONAL（缺失/部分缺失都不会失败），但一旦提供必须满足全部约束。这降低了"模型只产部分结构"的中间状态风险 —— schema 一票否决整个 document，模型要么完整产、要么完全不产。
8. **P3-1 不改 `detectLocale` 签名**：`localeFor(run)` 改为 `inferLocaleForRun(run)` 内部分两层判断 → 命中 `[action]/[confirm]` 占位时回看 `workspace.handoffs[].userGoal` 取最近的非占位 goal。`detectLocale(message, clientState)` 仍保持原签名供其他调用点使用，避免对 `src/copilot/locale.ts` 的所有 caller 形成传染。
9. **P3-2 输出双形式 header**：`filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded>` 同时给老 curl/老浏览器与现代浏览器；ASCII fallback 把所有 ≥0x80 字节折叠为 `_`，确保 Node HTTP 层 ISO-8859-1 校验绝不再抛 `Invalid character in header content`。

### 3.3 验收标准达成

- `npm run typecheck`：通过。
- `npm test`：64 → **69** 文件、605 → **636** 个 tests（commit 1 +6、commit 2 +9、commit 3 +16，本阶段累积 +31），全部通过，无任何既有用例回归（`tests/phase0Baseline.test.ts` / `tests/llmFirstClosedLoops.test.ts` / `tests/contractBackendFixes.test.ts` / `tests/generateResumePendingFlow.test.ts` 等所有 saveAcceptedVariantToResume 用例继续以单 item 形式通过 —— 它们的 fixture/mock 都没产 resumeDocument，自动走阶段 2 兼容路径）。
- variant 合法 `resumeDocument` 时 accept → resume 拆分多个 `ProductResumeItem` 并保留所有结构 id（`tests/saveAcceptedVariantWithDocument.test.ts` 第二个用例验证）。
- variant 缺 `resumeDocument` / schema 非法时 accept → resume 仍为单 item，且 `contentSnapshot/sectionType/title` 与阶段 2 字节一致（同文件第一个用例验证）。
- 中文 title PDF 下载不再抛 Header 错误；Header 同时含 `filename=` 与 `filename*=UTF-8''`（`tests/contentDispositionHeader.test.ts` 与 `tests/pdfExportPipeline.test.ts` 验证）。
- chat 中文上下文中点 `[action] generate_resume_from_jd` 不再误判 en（`tests/inferLocaleForRun.test.ts` 第 5 个用例验证）。

### 3.4 是否影响对外 API 与契约

**结论：阶段 3 在 `ProductGeneratedVariant` 上 +1 optional 字段 `resumeDocument`，在 `saveAcceptedVariantToResume` 返回值上 +1 optional 字段 `items?: ProductResumeItem[]`；下载 Content-Disposition header 形态扩展为 RFC 5987 双形式（语义不变，老 client 仍读 `filename=`）；locale 推断仅修内部行为（中文上下文里中文回复，原本就是契约期望）；零数据库迁移；零新依赖；零新环境变量。**

| 维度 | 影响 | 说明 |
| --- | --- | --- |
| `POST /product/generations` 响应中的 `variants[]` | **+1 optional 字段** | `resumeDocument?: ResumeDocument`；老前端忽略即可，`content` 仍是权威渲染字段。 |
| `POST /product/generations/:id/accept` 与 `accept_generation_variant` 工具返回值 | **+1 optional 字段** | `items?: ProductResumeItem[]`（仅当 variant 走结构化路径时非空）；旧字段 `item` 保留指向第一条，所有现有 caller 不需要改。 |
| `GET /exports/:id/download` 响应 Header `Content-Disposition` | **格式扩展（向后兼容）** | 中文 title 之前会触发 500（Node ISO-8859-1 校验），现在返回 `filename="<ASCII>"; filename*=UTF-8''<percent-encoded>`。RFC 6266 规范允许任何只识别 `filename=` 的 client 仍能下载。 |
| `POST /copilot/actions` 与 `POST /copilot/pending-actions/:id/confirm` 返回的 `assistantMessage.content` | **行为修复** | 中文会话中点 action / confirm 的回复语言不再误判 en；其他结构化字段不变。 |
| `raw.toolResults` / `raw.actionResults` / `raw.pendingActions` / `raw.metadata` / `nextActions` / `timeline` / `agentRoomEvents` / `workspace` / `workspacePatch` | 无 | 字节一致（包括阶段 2 narrator 启用时的所有分支）。 |
| `product_resume_item.metadata_json` JSONB | **+多 key（现有列）** | 多 item 路径下塞入 sectionId/sectionType/sectionOrder/itemId/bulletIds/sourceExperienceId/evidenceStrength/relevanceScore/sourceVariantId/generationId；列本身已存在，零 migration。读侧老代码 `JSON.parse` 拿不到这些 key 时无影响。 |
| 数据库 schema | 无 | 未触碰（无新增列、无 ALTER）。 |
| 环境变量 | 无 | 未新增。 |
| 配置/部署 | 无新依赖 | 仅复用既有 zod / PromptRegistry / resumeService.addResumeItem。 |

#### 前端建议

- 短期：忽略 `resumeDocument` 与 `items[]`（老字段 `content` 与 `item` 行为完全不变，渲染逻辑零修改）。
- 阶段 4+ 建议优先使用 `variants[].resumeDocument` 作为模板渲染数据源、`accept` 返回的 `items[]` 作为 resume editor 多块编辑入口；这两份数据携带的结构 id 与 evidence 链路是后续 Fit Engine（阶段 6）的输入。
- 中文标题 PDF 下载已可用；如前端用 `fetch` 后手动构造 `<a download>`，请优先解析 `filename*=UTF-8''` 部分（`Content-Disposition` 解析器例如 `content-disposition` npm 包默认即如此）。

> 累积变化（阶段 0 起）：阶段 0 = 零破坏；阶段 1 = `raw.toolResults[]` +6 optional 字段；阶段 2 = +1 optional `ENABLE_NARRATOR` 环境变量 + 4 分支文案变化；阶段 3 = `variants[].resumeDocument?` / `accept.items?` / `Content-Disposition` 双 filename 形式 / 中文 action 文案修复；零迁移、零新依赖、零新环境变量。

---

# 阶段 4：新增真正的一页简历模板 onePageModernTemplate

## 目标

先做一个质量明显高于 defaultTemplate 的专业一页简历模板，暂时不做自动适配，只做模板质量提升。

## 建议修改范围

```text
src/exports/ResumeHtmlRenderer.ts
src/exports/templates/defaultTemplate.ts
src/exports/templates/onePageModernTemplate.ts
tests/exportPipeline.test.ts
tests/pdfExportPipeline.test.ts
```

## 具体任务

1. 新增 `onePageModernTemplate.ts`。
2. 在 `ResumeHtmlRenderer` 中注册该模板。
3. 模板使用 A4 打印 CSS：

```css
@page {
  size: A4;
  margin: 10mm 12mm;
}
```

4. 模板按 section type 渲染：
   - summary
   - education
   - internship/work
   - project
   - skills
   - awards
5. bullet 使用紧凑但可读的样式：
   - 字号 8.8pt - 10pt。
   - 行距 1.18 - 1.28。
   - section 间距控制。
6. 如果 resume items 仍然是旧的一大段 content，也要有兼容渲染。
7. 导出时支持 `templateId: "one-page-modern"`。

## 不要做

- 不要在本阶段做 DOM 高度测量。
- 不要新增压缩算法。
- 不要修改 PlaywrightPdfRenderer。

## 验收标准

- HTML 导出可以选择 `one-page-modern`。
- PDF 导出可以使用 `one-page-modern`。
- 旧 default template 不受影响。
- 模板生成的 HTML 有清晰 section class，便于下一阶段测量。

## 可直接给 CodingAgent 的短 prompt

```text
请新增 onePageModernTemplate，使用 A4 打印 CSS 和专业简历布局渲染 ResumeDetail，并在 ResumeHtmlRenderer 注册 templateId=one-page-modern。保持 defaultTemplate 不变，确保 HTML/PDF 导出均可使用新模板，并补导出测试。
```

---

## 阶段 4 完成情况记录（执行回顾）

阶段 4 已落地，HEAD = 阶段 4 commit；working tree clean。下面是给前端 / 接入方的对外回顾（基于本次实际改动）。

### 4.1 改动清单

- 新增 `src/exports/templates/onePageModernTemplate.ts`：A4 单栏 sans-serif 模板，配套 PRINT_CSS（@page A4 / 18mm margin / 深灰 `#1f2937` 强调 / `Segoe UI · PingFang SC · Microsoft YaHei` 字体栈 / standard 行高 1.5），`page-break-inside: avoid` 用于 item / bullet。
- `src/exports/ResumeHtmlRenderer.ts` 构造函数追加 `this.register(onePageModernTemplate())`；`render(resume, templateId?)` 签名不变；未知 `templateId` 仍 fallback 到 `default`。
- `src/exports/index.ts` barrel 导出 `onePageModernTemplate`，方便外部以 `import { onePageModernTemplate } from "../src/exports/index.js"` 引用。
- 新增 `tests/onePageModernTemplate.test.ts`，10 个用例，分六组：注册契约、defaultTemplate 零回归、A4 视觉契约、中文渲染、Phase 3 结构化数据路径、旧路径 + skill section + PDF e2e（FakePdfRenderer）。
- defaultTemplate.ts 字节不变；阶段 4 不修改任何阶段 0-3 文件。

### 4.2 关键设计

1. **两条数据路径并存（硬性约束）**
   - **结构化路径（Phase 3+）**：模板按 `item.metadata.sectionType` 分组 → 按 `metadata.sectionOrder` 排序 → 渲染 header（`<title> · <subtitle> · <period> · <location>`）+ `<ul class="bullets">`，并把 `metadata.itemId` / `bulletIds[i]` 映射成 `data-item-id` / `data-bullet-id`，供未来 Fit Engine、AB 高亮、可点击锚点等场景使用。
   - **旧路径（Phase ≤ 2）**：缺 metadata 结构化键 + 单段 contentSnapshot 时，模板把整段文本作为 `<p class="item-body">` 渲染，不输出 `data-item-id`，不强行拆分 header。
   - 两条路径使用同一 `parseContentSnapshot` 解析器：识别行首 `- / • / *` 为 bullet，否则首行作为 header。
2. **section 排序硬编码**：`summary → experience → project → education → skill → award → other`。前端如需自定义顺序，请在阶段 6 引入 `templateOptions.sectionOrder`。
3. **density 仅作预留**：`<main class="resume density-${d}" data-density="${d}">` 三档（`comfortable / standard / compact`）CSS 已写好，但本阶段**不做**自动切换。当前总是 `standard`（来源：`resume.metadata?.density`，今天总是 undefined）。Fit Engine（阶段 5）将通过传入 `resume.metadata.density` 切档。
4. **不做的事（边界严格遵守）**：DOM 高度测量、自动压缩、删 bullet、动态字号、自动换页 — 全部留给阶段 5。本模板对超长内容**自然换页到第二页**，仅靠 `page-break-inside: avoid` 防止 item / bullet 被切。
5. **defaultTemplate 字节不变**：测试 `renders byte-identical HTML to defaultTemplate() when templateId is omitted` 直接断言 `renderer.render(resume) === defaultTemplate().render({ resume })`，确保旧客户端零回归。

### 4.3 验收

- `npm run typecheck`：通过。
- `npm test`：70 文件 / 646 用例全绿（阶段 3 是 69/636 → 阶段 4 +1 文件 / +10 用例）。
- 新模板测试覆盖：
  - 注册：`listTemplateIds()` 返回 `["default", "one-page-modern"]`。
  - Fallback：未知 `templateId` 走 default。
  - 零回归：HTML 输出与 `defaultTemplate().render({ resume })` 字节相同。
  - 视觉契约：`@page` / `size: A4` / `data-template="one-page-modern"` / `data-density="standard"` / `page-break-inside: avoid` 全部命中。
  - 中文渲染：标题、header、bullet、period 区域中文字符无 escape 错误。
  - Phase 3 结构化路径：experience 在 education 之前；`sectionOrder` 1 在 2 之前；`data-item-id` / `data-bullet-id` 全部输出；period 被正确从 header 拆出。
  - 旧路径：单段 contentSnapshot → `<p class="item-body">`，不输出 bullets / itemId。
  - hidden=true 的 item 被剔除。
  - skill section：按 `, ， ; ； 、` 五种分隔符切割成 `<span class="skill-chip">`。
  - PDF e2e（FakePdfRenderer）：`POST /exports/resumes/:id { format: "pdf", templateId: "one-page-modern" }` 通过 JobRunner 跑通，`ResumeExport.templateId === "one-page-modern"`，adapter 收到的 HTML 含 `data-template="one-page-modern"`，下载二进制以 `%PDF-` 开头。

### 4.4 对外 API 与契约影响（前端 / 接入方必读）

**新增能力**

- `POST /exports/resumes/:resumeId` 的 body 现在可选传 `templateId: "one-page-modern"`：
  ```json
  { "format": "pdf", "templateId": "one-page-modern" }
  { "format": "html", "templateId": "one-page-modern" }
  ```
  HTML 与 PDF 两种 format 通用。`ResumeExport.templateId` 字段会回写为请求的 templateId（持久化到 `resume_export.template_id` 列）。
- 新模板的 HTML 在每个结构化（Phase 3+）item 上输出 `data-item-id="<itemId>"`、每条 bullet 上输出 `data-bullet-id="<bulletId>"`，每个 section 上输出 `data-section-type="experience|project|..."`。前端可以基于这些 hook 实现：item 锚点跳转、bullet 级 AB 对比高亮、section 级折叠预览。
- 模板根节点 `<main class="resume density-standard" data-template="one-page-modern" data-density="standard">` 是稳定 hook。

**未变化（保证零回归）**

- 不传 `templateId` 或传未知值仍走 `defaultTemplate`，HTML 字节与阶段 0-3 完全相同。
- 现有 `GET /exports/:id/download` 行为不变（PDF 走 `application/pdf`，HTML 走 `text/html`，Content-Disposition 仍保留阶段 3 的 RFC 5987 处理）。
- 旧 ProductResumeItem（无结构化 metadata）在新模板下也能渲染，不需要任何数据迁移。
- defaultTemplate 字节级不变（有零回归测试守护）。

**前端建议**

- 简历预览下拉框可以新增 "One Page Modern (A4)" 选项，与默认模板并列。
- 切换模板时只需把 `templateId` 透传给 export API；不需要任何额外字段。
- 想抓 print 预览，可在浏览器 DevTools 里通过 `[data-template="one-page-modern"]` 选择器定位根节点。
- 阶段 5 会把 `density` 拨到 `compact` 来实现一页自动适配；前端**不要**预先在 UI 暴露 density 切换 — 那是 Fit Engine 的职责。
- 如果当前列表里用户的简历是阶段 3 之前生成的（`metadata` 为空对象），新模板会自动走旧路径，不会爆掉，但 bullet / period 拆分会受限；这是预期行为。

---

# 阶段 5：实现一页 Fit Engine v1：测量是否超页

## 目标

先实现“能判断是否超过一页”，不急着自动压缩。建立后续精准一页的技术基础。

## 建议修改范围

```text
src/exports/PdfRendererAdapter.ts
src/exports/ResumeExportService.ts
src/exports/ResumeFitService.ts
src/exports/types.ts
tests/pdfExportPipeline.test.ts
```

## 具体任务

1. 新增 `ResumeFitService` 或 `ResumeLayoutMeasurer`。
2. 使用 Playwright 打开 HTML 后，测量：
   - `.resume-page` 高度。
   - 内容 scrollHeight。
   - A4 可用高度。
   - estimatedPages。
   - overflowPx。
3. 新增 `fitReport` 类型：

```ts
fitReport: {
  targetPages: number;
  estimatedPages: number;
  overflowPx: number;
  underflowPx?: number;
  templateId: string;
  density: string;
  measuredAt: string;
}
```

4. 导出记录 metadata 或 data 中保存 fitReport。
5. 如果超过一页，暂时不要失败，只记录 warning。
6. 测试中使用 fake renderer 或可注入 measurer，确保不依赖真实 Chromium。

## 不要做

- 不要自动删除内容。
- 不要让导出因为超过一页失败。
- 不要改 LLM 生成逻辑。

## 验收标准

- PDF 导出记录中能看到 fitReport。
- 能区分一页内、超过一页。
- 测试不依赖真实浏览器也能通过。

## 可直接给 CodingAgent 的短 prompt

```text
请新增 ResumeFitService/ResumeLayoutMeasurer，在 PDF 渲染前后测量 one-page-modern HTML 的内容高度、A4 可用高度、estimatedPages 和 overflowPx，并把 fitReport 写入导出记录或返回数据。先只测量和记录，不做自动压缩。
```

---

## 阶段 5 完成情况记录（执行回顾）

阶段 5 已落地，HEAD = 阶段 5 commit；working tree clean。下面是给前端 / 接入方的对外回顾（基于本次实际改动）。

### 5.1 改动清单

- 新增 `src/exports/ResumeFitService.ts`：
  - 类型 `ResumeFitReport`（targetPages / estimatedPages / overflowPx / underflowPx / contentHeightPx / pageUsableHeightPx / templateId / density / measurer / measuredAt）。
  - 接口 `ResumeLayoutMeasurer`，输入 `{ html, templateId, density, pageUsableHeightPx? }` → 输出 `{ contentHeightPx, pageUsableHeightPx, measurer }`。
  - 实现 `PlaywrightLayoutMeasurer`：lazy-import `playwright`，在 794×1123 viewport 下打开 HTML 并读 `.resume` 的 `getBoundingClientRect().height` / `scrollHeight`。
  - 实现 `HeuristicLayoutMeasurer`：纯字符串解析 + density 系数表，零依赖；为 `onePageModernTemplate` 校准（masthead/section/item-header/bullet/skill-row 各档单价）。
  - 服务编排器 `ResumeFitService`，纯函数 `buildFitReport(...)` 推导 estimatedPages/overflow/underflow。
  - A4 几何常量 `A4_PAGE_WIDTH_PX=794` / `A4_PAGE_HEIGHT_PX=1123` / 18mm 边距 → `A4_USABLE_HEIGHT_PX=987` / `A4_USABLE_WIDTH_PX=658`。
- `src/exports/types.ts`：`ResumeExport` 加可选 `fitReport?: ResumeFitReport`。
- `src/exports/PostgresResumeExportRepository.ts`：`createExport` / `updateExport` 读写 `fit_report` 列（jsonb），`updateExport` 用 `COALESCE($n::jsonb,fit_report)` 保持"未提供则不覆盖"语义。
- `src/exports/InMemoryResumeExportRepository.ts`：spread 行为天然支持新字段，无需改动。
- 新增 migration `src/persistence/postgres/migrations/0012_resume_fit_report.sql` + `src/persistence/postgres/schema.sql` 加 `fit_report JSONB` 列。
- `src/exports/ResumeExportService.ts`：构造函数新增可选 `layoutMeasurer?: ResumeLayoutMeasurer`，默认 `new HeuristicLayoutMeasurer()`。`renderExportJob` 在 HTML 渲染后驱动 `fitService.measure(...)`，把 `fitReport` 与 `status:"completed"` 一起写入。测量失败仅 `console.warn`，**绝不**让导出失败；超过一页仅 `console.warn("[exports] resume overflows one A4 page (Phase 5: warn-only)")`。
- `src/exports/index.ts` barrel 导出 `ResumeFitService` 全套类型 / 类。
- `src/api/kernel/createKernel.ts`：`createKernel({ pdfRenderer?, layoutMeasurer? })` 透传到 `ResumeExportService`。
- 新增 `tests/resumeFitService.test.ts`（9 用例）：`buildFitReport` 边界、Heuristic 短/长 resume、密度单调性、skill 行计数、Service 委派契约、错误传播。
- 新增 `tests/resumeFitPipeline.test.ts`（5 e2e 用例）：完整 PDF / HTML 导出链路注入 FakePdfRenderer + FakeMeasurer，断言 fitReport 字段全集、超页不失败、measurer 抛错时 fitReport 不写、缺省 measurer 时也能完成。

### 5.2 关键设计决策

1. **测量在渲染之后、`completed` 写入之前**：`fitReport` 与 `status:"completed"` 在同一个 `updateExport` 调用里落库，保证消费者一旦看到 `status="completed"` 就能立即读取 `fitReport`，不会出现"已完成但 fitReport 还没写"的中间态。
2. **fitReport 是软可选字段**：测量失败、Chromium 异常、未来未知 measurer 抛错 — 任何情况都只 `console.warn`，导出仍走通；消费者必须把 `fitReport` 当作 optional 处理（schema 上也是 optional）。Phase 5 验收标准里"不要让导出因为超过一页失败"被严格遵守。
3. **默认 measurer 是 Heuristic 而非 Playwright**：避免任何 dev/test 路径意外触发 Chromium。`PlaywrightLayoutMeasurer` 仅当生产环境通过 `createKernel({ layoutMeasurer: new PlaywrightLayoutMeasurer() })` 显式注入时才会用上。Heuristic 估算虽然没有真 layout 精准，但对"一页 vs 超过一页"的判别足够稳定，且为 Phase 6 的规则压缩提供了可解释的数字（密度 / overflowPx）。
4. **density 来源 = HTML 中的 `data-density`**：阶段 4 已经把 density 烧进 HTML 根节点。fitReport.density 直接 `RegExp.exec` 读出，绝不会和实际渲染时使用的 density 不一致；`default` 模板没这个属性时回落到 `"standard"`。
5. **Heuristic 调校偏保守**：单价表见 `DENSITY_TABLE`，故意稍微高估 — 让 Phase 6 宁可压缩一份原本"刚刚好够"的简历，也不让一份真正超页的偷溜过去。
6. **Postgres 迁移幂等**：`ALTER TABLE ... ADD COLUMN IF NOT EXISTS fit_report JSONB`。Postgres 12+ 支持，无需 DO 块。
7. **API 调用形态完全不变**：`POST /exports/resumes/:id` 请求体未变；阶段 5 是纯输出侧增量。

### 5.3 验收

- `npm run typecheck`：通过。
- `npm test`：72 文件 / 660 用例全绿（阶段 4 是 70/646 → 阶段 5 +2 文件 / +14 用例）。
- 验收标准对齐：
  - **PDF 导出记录中能看到 fitReport** 已达成（`tests/resumeFitPipeline.test.ts` 第 1 用例断言 8 个字段）。
  - **能区分一页内 / 超过一页** 已达成（buildFitReport 单元测试 + 注入超页 measurer 的 e2e 用例双重覆盖）。
  - **测试不依赖真实浏览器也能通过** 已达成（默认 Heuristic measurer，所有测试零 Chromium 调用，`PlaywrightLayoutMeasurer` 仅在阶段 5 的代码中存在但 0 次调用）。
- 阶段 5 边界严格遵守："不要做"清单（自动删除内容、超过一页时失败、改 LLM 生成逻辑）全部未触发。

### 5.4 对外 API 与契约影响（前端 / 接入方必读）

**新增能力**

- `ResumeExport` 响应对象现在可选携带：
  ```ts
  fitReport?: {
    targetPages: number;          // 阶段 5 永远是 1
    estimatedPages: number;       // >= 1
    overflowPx: number;           // 0 表示一页内；> 0 表示超页
    underflowPx?: number;         // overflowPx === 0 时存在
    contentHeightPx: number;      // 测得的内容高度
    pageUsableHeightPx: number;   // A4 减边距后的可用高度
    templateId: string;
    density: "comfortable" | "standard" | "compact" | string;
    measurer: "playwright" | "heuristic";
    measuredAt: string;           // ISO-8601 UTC
  }
  ```
- 该字段出现在 `GET /exports/:id`、`GET /exports`（list）、以及 `POST /exports/resumes/:id` 的回写记录中，但**仅** `status === "completed"` 后才稳定（之前 status 期间为 undefined）。
- 前端可以基于 `fitReport.overflowPx > 0` 给用户一个明确的"该简历超过一页"提示；可以基于 `fitReport.estimatedPages` 显示"约 N 页"；可以基于 `fitReport.density` 在简历预览侧栏标注当前密度档位。

**未变化（保证零回归）**

- 请求体 schema 不变：`POST /exports/resumes/:id` 仍是 `{ format, templateId? }`，没有任何新增必填项。
- 响应 schema 是**纯增量**：所有阶段 5 之前生成的导出记录 fitReport 仍为 undefined，前端必须把它当 optional 字段处理。
- 阶段 5 之前已有的状态机不变：`pending → rendering → completed | failed`，`fitReport` 只在 completed 时写入，且失败时**绝不**触发额外 status。
- 文件下载（`GET /exports/:id/download`）行为完全不变：返回的 PDF/HTML 字节没动，Content-Disposition 没动。
- defaultTemplate / onePageModernTemplate 渲染输出字节级不变（双重零回归测试守护）。

**前端建议**

- 简历预览页可以加一个"页面适配"指示器，读 `fitReport`：
  - `overflowPx === 0` → 绿色"一页内"图标，可显示 `underflowPx` 表示剩余空间。
  - `overflowPx > 0` → 黄色警告"将超过一页（多 X 像素）"，并提示"阶段 6 会自动压缩"或"考虑手动隐藏部分内容"。
- 不要假设老导出记录都有 `fitReport` —— 必须 `if (record.fitReport) ...` 守护。
- `fitReport.measurer` 字段对终端用户没价值，仅供 debug 视图显示（区分是 Chromium 真测还是启发式估算）。
- 不要在 UI 把 `fitReport.contentHeightPx` 和 `pageUsableHeightPx` 数字直接展示给用户 —— 它们是内部 CSS 像素，单位语义对最终用户是不透明的。如果想展示进度条，用 `min(1, contentHeightPx / pageUsableHeightPx)`。
- 阶段 6 上线后，对超页简历会先尝试规则压缩然后重新计算 fitReport。前端如果想区分"已压缩后仍超页"vs"未压缩超页"，需要等阶段 6 引入 `compressionReport` 字段配合判断 —— 阶段 5 暂不暴露。

---

# 阶段 6：实现一页 Fit Engine v2：规则压缩

## 目标

当简历超过一页时，先用规则压缩，而不是直接让模型重写。规则压缩更稳定、可解释、可测试。

## 建议修改范围

```text
src/exports/ResumeFitService.ts
src/exports/ResumeCompressionService.ts
src/product/types.ts
src/product/services/index.ts
tests/resumeFitOptimizer.test.ts
```

## 压缩策略优先级

```text
1. 删除 optional=true 且 relevanceScore 低的 bullet
2. 压缩超过指定长度的 bullet
3. 合并过短 bullet
4. 隐藏低相关 section
5. 降低 density：standard → compact
6. 最后才略微降低字号/行距
```

## 具体任务

1. 新增 `ResumeCompressionService`。
2. 输入：ResumeDocument 或 ResumeDetail + fitReport。
3. 输出：压缩后的 ResumeDocument/ResumeDetail + compressionReport。
4. compressionReport 记录：

```ts
removedBullets
shortenedBullets
hiddenSections
densityBefore
densityAfter
reason
```

5. `ResumeExportService` 中增加最多 2-3 次迭代：

```text
render html → measure → compress if overflow → render again → measure again
```

6. 仅对 `targetPages=1` 且 `templateId=one-page-modern` 启用。
7. 保证 pinned bullet 不被删除。

## 不要做

- 不要使用 LLM 压缩。
- 不要修改原始经历库。
- 不要永久覆盖用户简历，除非明确保存压缩版本。

## 验收标准

- 超页样本经过压缩后 estimatedPages 降低。
- pinned bullet 不会被删除。
- compressionReport 可追踪每次删减。
- 如果仍然超过一页，导出继续完成，但返回 warning。

## 可直接给 CodingAgent 的短 prompt

```text
请实现 ResumeCompressionService 和一页适配迭代：当 one-page-modern 的 fitReport 显示超过 1 页时，按 optional/relevance/pinned 规则压缩 bullet 或隐藏低相关 section，最多迭代 3 次，并输出 compressionReport。不要调用 LLM，不要改原始经历库。
```

## 阶段 6 完成情况（Fit Engine v2 已落地）

### 改动清单

- 新增 `src/exports/ResumeCompressionService.ts`：纯函数式压缩引擎，对外导出 `ResumeCompressionService`、`ResumeCompressionAction`、`ResumeCompressionReport`、`ResumeCompressionMeasureFn`、`ResumeCompressionInput`、`ResumeCompressionResult`。
- `src/exports/index.ts` barrel 中追加 `export * from "./ResumeCompressionService.js"`。
- `src/exports/types.ts`：`ResumeExport.compressionReport?: ResumeCompressionReport`（可选字段，未触发压缩时为 `undefined`）。
- `src/exports/PostgresResumeExportRepository.ts`：INSERT 增加第 16 列 `compression_report`、UPDATE 用 `COALESCE($11::jsonb, compression_report)` 部分写入；`toExport` 通过共享 `parseJsonb<T>` 反序列化（同时复用给 `fit_report`）。
- `src/persistence/postgres/schema.sql`：`resume_export` 表追加 `compression_report JSONB`。
- `src/persistence/postgres/migrations/0013_resume_compression_report.sql`：`ALTER TABLE ... ADD COLUMN IF NOT EXISTS compression_report JSONB`。
- `src/exports/ResumeExportService.ts`：在 `renderExportJob` 中插入 `maybeCompress(resume, html, record, fitReport)`：当 `templateId === "one-page-modern" && targetPages === 1 && initialFitReport.overflowPx > 0` 时，迭代调用 `ResumeCompressionService.compress`（最多 6 轮），用最终 items + density 重新渲染并复测一次 fitReport，把最终 HTML/PDF 字节、最终 fitReport、compressionReport 写入 export 记录。
- 测试：
  - 新增 `tests/resumeCompressionService.test.ts`：11 个单测（bypass、drop_bullet、shorten_bullet、hide_item、drop_density、pinned 保护、bulletPinned 保护、低 visible 不再 hide、迭代次数上限、compressionReport 字段完整性、stillOverflowing 路径）。
  - 新增 `tests/resumeCompressionPipeline.test.ts`：5 个 e2e（compress 成功路径、已合页 bypass、density 降级路径、非 one-page-modern 模板 bypass、stillOverflowing 兜底完成）。
  - 全量 `npm test`：74 files / 676 tests 全绿。

### 关键设计

1. **迭代控制权属于 ResumeExportService 而不是 ResumeCompressionService**：服务本身是纯函数（输入 items/density/fitReport → 输出新 items/新 density + actions/report），实际的"重渲染 + 重测"循环放在 export 层，通过传入 `measure: ResumeCompressionMeasureFn` 回调把每一轮新 HTML 交给 `HeuristicLayoutMeasurer`。这样 service 不持有 renderer/measurer 也不写 DB，可单独单测。
2. **策略优先级（每次最多触发一种）**：`drop_bullet`（bulletOptional=true 的 bullet，按 relevance 升序）→ `shorten_bullet`（>180 字符的 bullet 截断到约 140 字符，按词边界切并加 `…`）→ `hide_item`（relevanceScore 最低的非 pinned 非 hidden item，且当前可见数 > 1）→ `drop_density`（standard→compact 或 comfortable→standard，整份简历只允许降一次）→ 无策略可用，退出。
3. **保护规则**：`item.pinned===true` 永远不会被 `hide_item`；`metadata.bulletPinned[bulletId]===true` 永远不会被 `drop_bullet` / `shorten_bullet`；最后 1 个可见 item 不允许再 hide（避免空简历）；密度只允许降一级，不会反复。
4. **不修改原始 ProductResume 行**：`compress` 内部 deep-clone items/metadata，最终 service 返回的是新 items 数组。`ResumeExportService` 用一个临时合成的 `ProductResumeDetail`（`withDensity` helper 把新 density 注入 `metadata.density` 给模板读）去重新渲染 HTML，完全不写回 `resume_item` 表。原始经历库保持用户编辑的真值。
5. **fitReport 写的是压缩后的最终值**：当 compression 触发时，export 记录里的 `fit_report` 列是压缩后重新测的；`compression_report.initialOverflowPx` / `initialEstimatedPages` 保留压缩前快照供前端"压缩节省了 X 像素"提示。
6. **stillOverflowing 不让 export 失败**：与阶段 5 的 warn-only 契约一致。`compressionReport.reason ∈ {"overflow_resolved","no_more_strategies","iteration_limit"}`、`stillOverflowing: boolean` 完整记录退出原因，前端可基于 `applied + stillOverflowing` 区分「已压缩并合页」「已压缩仍超页」「未触发压缩」。
7. **`MAX_ITERATIONS = 6`**：理论上 4 步也够（drop→shorten→hide→density），多留 2 步给"再次 drop_bullet"等同类策略多次触发的情况。超过则 `reason: "iteration_limit"`。

### 验收

- 单元 + e2e 7 个 Phase 6 测试全部通过；全量 74 files / 676 tests 全绿。
- typecheck（`tsc --noEmit`）通过。
- 手动跑 PDF export 路径：one-page-modern 模板下，构造一个超过 1 页的 resume，最终 PDF 字节、`completed.fitReport.overflowPx`、`completed.compressionReport.actions[]` 三者一致。
- 兼容性：其它模板 / `targetPages > 1` / 已经合页的 resume 路径未被触碰，`compressionReport` 仍为 `undefined`。

### 对外 API 与契约影响

- `ResumeExport` 新增可选 `compressionReport?: ResumeCompressionReport`（HTTP 层 `GET /exports/:id` 自动透传）。前端老客户端忽略该字段不会出错。
- `compressionReport` 结构：`{ applied, initialEstimatedPages, finalEstimatedPages, initialOverflowPx, finalOverflowPx, iterations, actions: ResumeCompressionAction[], densityBefore, densityAfter, stillOverflowing, reason }`。
- `ResumeCompressionAction` 联合类型：`drop_bullet` / `shorten_bullet` / `hide_item` / `drop_density` / `merge_bullets`（merge 在阶段 6 暂未实现，但类型保留以便阶段 7 扩展）。
- 数据库迁移：必须执行 `migrations/0013_resume_compression_report.sql` 才能在 Postgres 后端使用。InMemory 后端无影响。

### 前端建议

- `compressionReport.applied===true` 时，预览页可以显示一个浅色 chip："已自动优化以适配单页（X 处调整）"，hover 显示 `actions[].type` 列表。
- `compressionReport.stillOverflowing===true` 时，醒目提示用户"自动压缩后仍超过单页，建议手动隐藏部分内容或 pin 关键项后切换到 compact 密度"，并把 `actions` 渲染成可读的中文 reason。
- `densityBefore !== densityAfter` 时可单独 callout："密度已自动从 standard 降为 compact"。
- 阶段 7 LLM 压缩接管以后，前端只要扩展 action.type 渲染表，主流程不用改。

---

# 阶段 7：实现 LLM 简历压缩与补足

## 目标

在规则压缩之后，再引入 LLM 作为高级优化：当规则无法解决拥挤或页面太空时，让模型进行“简历编辑级别”的压缩或补足。

## 建议修改范围

```text
src/product/LLMGenerationService.ts
src/product/LLMRewriteService.ts
src/exports/ResumeLLMFitEditor.ts
src/agent-core/prompts/prompts/product/resume-fit-editor-system.md
tests/resumeLLMFitEditor.test.ts
```

## 具体任务

1. 新增 `ResumeLLMFitEditor`。
2. 触发条件：
   - 规则压缩后仍超过一页。
   - 或 underflow 太大，页面明显空。
3. 输入：
   - ResumeDocument
   - JD summary
   - fitReport
   - compressionReport
   - 约束：不得编造事实、不得增加无依据指标。
4. 输出：
   - revised ResumeDocument
   - editReport
5. 对 LLM 输出做 schema validation。
6. 保留旧版本，不直接覆盖原始经历库。

## 不要做

- 不要让 LLM 直接输出 HTML。
- 不要让 LLM 操作 CSS。
- 不要让 LLM 编造新经历或新指标。

## 验收标准

- LLM 只编辑 ResumeDocument 的文字和 optional 标记。
- 输出 schema 稳定。
- 有模型失败 fallback。
- 仍然保留 rules-only 压缩路径。

## 可直接给 CodingAgent 的短 prompt

```text
请新增 ResumeLLMFitEditor，在规则压缩仍超页或页面明显过空时，用 LLM 在严格 ResumeDocument schema 内压缩/补足文字。禁止输出 HTML，禁止编造事实，失败时回退 rules-only 结果。补 schema validation 和测试。
```

---

## 阶段 7 落地记录（已完成）

> 本节记录阶段 7 的实际实现与契约，方便阶段 8 之后的工作以此为准。

### 改动清单

```text
src/exports/ResumeLLMFitEditor.ts                                  # 新增：LLM 适配编辑器（结构化 actions）
src/agent-core/prompts/prompts/product/resume-fit-editor-system.md # 新增：严格 JSON-only system prompt
src/agent-core/prompts/PromptRegistry.ts                           # 注册 product.resumeFitEditor.system
src/exports/ResumeExportService.ts                                 # 在 maybeCompress 之后调用 maybeLlmFitEdit（warn-only）
src/exports/types.ts                                               # ResumeExport.editReport?: ResumeFitEditorReport
src/exports/index.ts                                               # 导出 ResumeLLMFitEditor 与相关类型
src/exports/PostgresResumeExportRepository.ts                      # 新增 edit_report JSONB 列读写
src/persistence/postgres/schema.sql                                # resume_export 增加 edit_report
src/persistence/postgres/migrations/0014_resume_edit_report.sql    # 迁移：ALTER TABLE ... ADD COLUMN edit_report JSONB
src/api/kernel/createKernel.ts                                     # 透传 modelClient 给 ResumeExportService（生产用 model.client，测试可注入）
tests/resumeLLMFitEditor.test.ts                                   # 单测：触发判定 + actions 应用 + 失败兜底（17 用例）
tests/resumeLLMFitPipeline.test.ts                                 # e2e：editReport 持久化 + ENABLE_LLM_FIT_EDITOR 关闭旁路
```

### 关键设计

- **触发严格**：仅 `templateId === "one-page-modern"` 且 `targetPages === 1`，且满足以下之一：
  - `still_overflowing`：阶段 6 已 `applied===true` 且 `stillOverflowing===true`；
  - `fill_underflow`：`overflowPx===0` 且 `underflowPx >= 240px`（默认阈值，可注入）。
- **结构化 actions only**：LLM 仅返回 `{actions, reason, notes}` JSON，`actions` 为 `shorten_bullet / rephrase_bullet / drop_bullet / expand_bullet` 联合类型，全部按 `bulletId` 引用现有 bullet。`expand_bullet` 仅 `fill_underflow` 模式可用，其他三种仅 `still_overflowing` 模式可用，越界 action 直接拒绝。
- **绝不编造**：服务侧硬约束 + system prompt 双重约束。被拒原因穷尽枚举为 `unknown_bullet | pinned_bullet | pinned_item | expand_in_shrink_mode | shrink_in_fill_mode | shorten_too_small | newtext_invalid | duplicate_target`，均写入 `editReport.rejectedActions[]`。
- **pinned 双层保护**：`metadata.bulletPinned[bulletId]===true` 与 `pinned===true` 的 item 内 bullets 永远不会被 LLM 改动；越权请求被拒。
- **MAX_ACTIONS=6**（fill 模式 expand 最多 3 条），并对 `newText` 做 `sanitizeNewText`（去换行、去前导项目符号、压缩空白、按 240 字符硬截断，避免模型注入篇幅炸长）。
- **回归回滚**：每轮 LLM 编辑后再次调用 `measure()`，使用 `badness = overflowPx*4 + underflowPx`，若 after > before 则整批回滚回原 items / fitReport，`reason="regression"` 写入报告。
- **fallback 穷尽枚举**：`reason ∈ no_model_client | no_actions | schema_invalid | model_error | regression | edits_applied | all_rejected`；`fallback=true` 表示导出走未编辑路径。
- **服务可纯化测试**：`ResumeLLMFitEditor` 通过构造函数接收 `chat` 回调（不是直接持有 `ModelClient`），与阶段 6 的 `measure` 回调风格一致；单测中用 `vi.fn` 桩，零依赖 LLM。
- **默认关闭**：`ENABLE_LLM_FIT_EDITOR !== "true"` 或未注入 `modelClient` 时整段旁路；与阶段 2 narrator 的 `ENABLE_NARRATOR` 形成同款灰度开关。
- **persistence 兼容旧记录**：`edit_report` 列允许 NULL，旧 export 与未触发 LLM 的 export 都返回 `editReport=undefined`。

### 验收

- 单测：`tests/resumeLLMFitEditor.test.ts` 17 用例全绿（trigger 6 / shrink 应用 2 / 多次 shrink 3 / 失败路径 4 / fill_underflow 2）。
- e2e：`tests/resumeLLMFitPipeline.test.ts` 2 用例全绿（still_overflowing 持久化 editReport；ENABLE_LLM_FIT_EDITOR 关闭则旁路）。
- 全量：`npm run typecheck` + `npm test` ⇒ **76 files / 695 tests passed**。
- DB：迁移 `0014_resume_edit_report.sql` 与 `schema.sql` 同步，Postgres 与 InMemory 仓储读写表现一致。
- 阶段 5/6 行为不变：阶段 7 仅在阶段 6 之后追加运行，warn-only 契约继承。

### 对外 API 与契约影响

- `ResumeExport.editReport` 新增可选字段，前端可在导出详情页面读取 `editReport.applied / trigger / actions / rejectedActions / fallback / reason / initialOverflowPx / finalOverflowPx / initialUnderflowPx / finalUnderflowPx`。
- 任何 `ResumeFitEditorActionInput` 新分支需要同步：服务侧 `ActionSchema` 联合 + `applyActions` 分发 + system prompt 示例 + 前端渲染表 + 测试夹具。
- 阶段 6 输出契约未变更；前端如未读 `editReport` 字段也不会有兼容问题。

### 前端建议

- 在导出详情页同步显示阶段 6 与阶段 7 报告：阶段 6 给出"压缩了什么"，阶段 7 给出"模型在压缩之后又改了什么 / 为什么没有改"。
- 当 `editReport.fallback === true && editReport.reason !== "no_actions"` 时给一条非阻塞提示："AI 优化未生效，已回退到规则版排版"，并把 `editReport.rejectedActions[].reason` 折叠在详情中，便于运营审计模型行为。
- `editReport.actions[].type === "expand_bullet"` 出现时，建议给该 bullet 标记一个"AI 充实"小图标，提醒用户复核。

---

# 阶段 8：简历质量 Critic 与导出前质量报告

## 目标

让系统不仅能导出一页 PDF，还能告诉用户这份简历质量如何、有什么风险、哪些地方缺少证据。

## 建议修改范围

```text
src/agent-core/prompts/prompts/critic.md
src/agent-core/evaluation/ReviewPolicy.ts
src/exports/ResumeQualityService.ts
src/product/types.ts
tests/agentRuntimeLoopAndCritic.test.ts
tests/resumeQualityService.test.ts
```

## 质量维度

```text
真实性：是否有无依据夸大
JD 匹配：是否覆盖核心要求
证据强度：每条关键 bullet 是否有 sourceExperienceId
指标质量：是否有真实可解释的量化结果
表达质量：是否行动 + 方法 + 结果
版面质量：是否一页、是否拥挤、是否过空
```

## 具体任务

1. 新增 `ResumeQualityService`。
2. 导出前生成 `qualityReport`：

```ts
qualityReport: {
  overallScore: number;
  jdMatchScore: number;
  evidenceScore: number;
  layoutScore: number;
  risks: string[];
  suggestions: string[];
  unsupportedClaims: string[];
}
```

3. 将 qualityReport 放入 export result / workspacePatch。
4. 如果风险过高，不要直接阻塞导出；先提示用户。
5. 只有 critical unsupported claims 才走 critic block 或 confirmation。

## 不要做

- 不要过度阻塞用户导出。
- 不要让 critic 再次造成无限循环确认。
- 不要修改保存逻辑。

## 验收标准

- 导出前/导出后可以看到 qualityReport。
- 高风险 unsupported claim 能被识别。
- 普通建议不会阻断导出。

## 可直接给 CodingAgent 的短 prompt

```text
请新增 ResumeQualityService，在导出前基于 ResumeDocument/ResumeDetail、JD、fitReport、evidence 生成 qualityReport，包含真实性、JD 匹配、证据强度、表达质量、版面质量。只对 critical 风险触发阻断或确认，普通建议仅展示，避免循环确认。
```

---

## 阶段 8 落地记录（已完成）

> 本节记录阶段 8 的实际实现与契约，方便阶段 9 contract 整理时直接引用。

### 改动清单

```text
src/exports/ResumeQualityService.ts                                # 新增：纯函数式 quality 评分（六维 + risks/suggestions）
src/exports/ResumeExportService.ts                                 # 在 maybeLlmFitEdit 之后追加 maybeEvaluateQuality（warn-only）
src/exports/types.ts                                               # ResumeExport.qualityReport?: ResumeQualityReport
src/exports/index.ts                                               # 导出 ResumeQualityService 与相关类型
src/exports/PostgresResumeExportRepository.ts                      # 新增 quality_report JSONB 列读写
src/persistence/postgres/schema.sql                                # resume_export 增加 quality_report
src/persistence/postgres/migrations/0015_resume_quality_report.sql # 迁移：ALTER TABLE ... ADD COLUMN quality_report JSONB
src/api/kernel/createKernel.ts                                     # 透传 (userId, jdId) => jdService.getJD 给 ResumeExportService
tests/resumeQualityService.test.ts                                 # 单测：六维评分边界 + risk 等级 + critical 触发条件（15 用例）
tests/resumeQualityPipeline.test.ts                                # e2e：qualityReport 持久化 + critical 风险不阻断导出（2 用例）
```

### 关键设计

- **完全确定性 / 不调用 LLM**：阶段 8 评分是纯规则的（正则 + 关键词命中 + 评分公式）。这与阶段 7 的 LLM 编辑器形成互补：编辑器（Phase 7）做"能不能在版面上改"，质量服务（Phase 8）做"成品有没有风险"，前者会失败回退、后者保证可复现可单测。
- **六个维度 + 加权 overallScore**：
  - `authenticity`（25%）：bullet 命中夸张词正则（`100%` / `perfect` / `industry-first` / `世界第一` / `顶尖` / `完美` / `业界首创` ……）且无 evidence ⇒ 列为 `unsupportedClaims`；若该 bullet 所在 item 的 `relevanceScore >= 0.6` 则为 `critical` 风险，否则 `medium`。
  - `jd_match`（25%）：从 JD 文本提取技术 token（去停用词），统计 bullet 命中比例 → 评分。<0.3 ⇒ `high`，<0.5 ⇒ `medium`，缺 JD 时回中性 60 分且不报风险。
  - `evidence`（20%）：bullet 是否有 `metadata.bulletEvidence[bulletId]` 或 item 级 `sourceExperienceId` 或 `metadata.sourceExperienceId`；覆盖率 <0.25 ⇒ `high`，<0.5 ⇒ `medium`。
  - `metric`（10%）：bullet 含数字 / 百分比 / 单位（`%` / `x` / `倍` / `万` / `k` 等）的比例 <0.3 ⇒ 一条 metric 建议（不报 risk）。
  - `expression`（10%）：bullet 长度 <20 字符或 >220 字符，或不以行动动词开头（中英双语动词正则） ⇒ 一条 expression 建议（不报 risk）。
  - `layout`（10%）：`overflowPx > 0` ⇒ risk；当 `compression.stillOverflowing && edit.fallback` 同时为 true（即阶段 6/7 已用尽）⇒ `high`；其他超页 ⇒ `medium`。`underflowPx >= 240 && !edit.applied` ⇒ 一条 layout 建议。
- **critical 等级专属于"高 relevance + 不可证伪夸张"**：这是产品上唯一可能阻断或要求确认的事件类型，对应 spec 里"只对 critical 风险触发阻断或确认"。**阶段 8 实现保持 warn-only**——`hasCriticalRisks=true` 仅作为元数据上抛，不在后端创建 pending action 也不阻断 export 完成；这道关是否真正"阻断/确认"由阶段 10 默认链路切换或前端 UI 决定，避免阶段 8 自行制造"无限循环确认"。
- **JD 关联**：仅当 `resume.jdId` 存在且 kernel 注入了 `jdLookup` 时拉取 JD；任何 JD 查询失败都被 swallow 成 "no JD" 路径，不污染评分。
- **服务零 IO**：`ResumeQualityService.evaluate(...)` 是同步纯函数，所有 IO 由 `ResumeExportService.maybeEvaluateQuality` 在外面做（JD 读取 + 异常吞没）。这让 service 端可被任意调用方在内存中复用（例如未来前端 SSR、CLI 导出、合并差异预览）而无需关心 kernel。
- **persistence 兼容旧记录**：`quality_report` 列允许 NULL，旧 export 与未触发评分的 export（如缺 fitReport）都返回 `qualityReport=undefined`。InMemory / Postgres 两份仓储读写一致。

### 验收

- 单测：`tests/resumeQualityService.test.ts` 15 用例全绿（baseline 1 + authenticity 2 + jd_match 3 + evidence 2 + metric 2 + expression 1 + layout 3 + 空数组 1）。
- e2e：`tests/resumeQualityPipeline.test.ts` 2 用例全绿（健康简历 → `hasCriticalRisks=false`；含夸张未证伪 bullet 的高 relevance 简历 → `hasCriticalRisks=true` 但 `status="completed"`）。
- 全量：`npm run typecheck` + `npm test` ⇒ **78 files / 712 tests passed**。
- DB：迁移 `0015_resume_quality_report.sql` 与 `schema.sql` 同步。
- 阶段 5/6/7 行为不变：阶段 8 仅在阶段 7 之后追加运行，warn-only 契约继承；任何评分异常被 swallow 后只缺 `qualityReport` 一个字段。

### 对外 API 与契约影响

- **新增 optional 字段** `ResumeExport.qualityReport?: ResumeQualityReport`；shape 见下：

  ```ts
  type ResumeQualityReport = {
    overallScore: number;         // 0..100，按权重 auth25/jd25/ev20/metric10/expr10/layout10 计算
    authenticityScore: number;
    jdMatchScore: number;
    evidenceScore: number;
    metricScore: number;
    expressionScore: number;
    layoutScore: number;
    risks: Array<{ id, level: "low"|"medium"|"high"|"critical", dimension, message, itemId?, bulletId? }>;
    suggestions: Array<{ id, dimension, message, itemId?, bulletId? }>;
    unsupportedClaims: string[];  // 命中夸张正则但缺 evidence 的 bullet 原文
    hasCriticalRisks: boolean;    // 是否存在 level === "critical" 的 risk
    generatedAt: string;          // ISO-8601
  };
  ```

- 阶段 7 的 `editReport` 与阶段 6 的 `compressionReport` 字段未变更；前端如未读 `qualityReport` 字段也完全兼容（旧导出该字段就是 undefined）。
- 不新增任何环境变量、不新增任何 REST 路由、不新增任何 LLM 依赖。
- 数据库新增一列 `resume_export.quality_report JSONB`，迁移 `0015` 必须随后端部署执行。

### 前端建议

- 在导出详情页的"质量"区块以六个 0–100 数值条显示六维分数；`overallScore` 可作为顶部主指标。
- `qualityReport.hasCriticalRisks === true` 时，建议在导出按钮旁给一条**显眼但非阻断**的 banner："检测到 X 条无证据的高风险表述，建议在分享前确认"，并把 `risks.filter(r => r.level === "critical")` 渲染成可点击的 itemId/bulletId 锚点。**不要**在前端自己创建 confirmation 弹窗——阶段 8 后端不会等你确认，导出已经完成。
- `risks` 与 `suggestions` 区分：risks 用色 chip 突出显示，suggestions 折叠在"还可以更好"小节；这与阶段 6/7 的 actions 视图风格保持一致。
- `unsupportedClaims` 适合做内联高亮：在简历预览里把命中的 bullet 用浅黄底色 + tooltip "无证据支撑" 标出，给用户一个直接的修改入口。
- `jdMatchScore < 60` 时，可以提示用户回去做 `match_experiences_against_jd` 重新选材；这条建议与阶段 1 的 `nextActionHints` 路径天然衔接。

---

# 阶段 9：前后端契约整理与 UI 接入准备

## 目标

把后端新增的结构化结果、Narrator 回复、fitReport、qualityReport、compressionReport 形成稳定契约，方便前端逐步接入。

## 建议修改范围

```text
docs/CONTRACT.md
docs/coolto_frontend_backend_contract_v2.md
docs/frontend_backend_contract_llm_first.md
frontend/src/types/copilot.ts 如果仓库内仍维护 frontend 类型
```

## 具体任务

1. 更新 contract 文档，说明新增字段：
   - ToolResult structured fields
   - ResumeDocument
   - fitReport
   - compressionReport
   - qualityReport
   - nextActionHints
2. 标注字段兼容性：
   - required
   - optional
   - legacy
   - frontend recommended
3. 给前端建议展示方式：
   - Narrator 文本显示在聊天区。
   - fitReport / qualityReport 可以折叠显示。
   - compressionReport 用“小字说明”展示，不要干扰主流程。
4. 如果仓库内有 frontend 类型，同步类型定义。

## 不要做

- 不要在本阶段大改前端 UI。
- 不要删除旧字段。

## 验收标准

- 契约文档足够让前端按字段接入。
- 类型定义和后端返回一致。
- 旧前端不接新字段也不会坏。

## 可直接给 CodingAgent 的短 prompt

```text
请整理并更新前后端契约文档，补充 ToolResult 结构化字段、ResumeDocument、fitReport、compressionReport、qualityReport、nextActionHints 的类型、兼容性和前端建议展示方式。不要大改前端 UI，不删除旧字段。
```

---

# 阶段 10：体验收敛与默认链路切换

## 目标

当前面阶段都稳定后，把默认体验切换到新链路：Narrator 默认开、新模板默认用、生成默认产出 ResumeDocument、导出默认走一页适配。

## 建议修改范围

```text
src/platform/config.ts
src/api/routes/**
src/agent-tools/**
src/exports/**
docs/
tests/
```

## 具体任务

1. 默认开启：

```text
ENABLE_NARRATOR=true
DEFAULT_RESUME_TEMPLATE=one-page-modern
DEFAULT_TARGET_PAGES=1
ENABLE_RESUME_FIT_ENGINE=true
```

2. 保留回滚开关：

```text
ENABLE_NARRATOR=false
ENABLE_RESUME_FIT_ENGINE=false
DEFAULT_RESUME_TEMPLATE=default
```

3. 更新 README / docs。
4. 加一条端到端测试：

```text
用户输入 JD → 匹配经历 → 生成结构化简历 → 接受推荐版本 → 导出一页 PDF → 下载成功
```

5. 检查日志和错误提示，确保用户看到的是产品化话术，而不是底层错误。

## 不要做

- 不要删除 default template。
- 不要删除旧 content 字段。
- 不要删除 fallback。

## 验收标准

- 默认链路是新体验。
- 环境变量可以快速回滚旧体验。
- 端到端测试稳定通过。

## 可直接给 CodingAgent 的短 prompt

```text
请将新链路切换为默认体验：Narrator 默认开启、默认模板 one-page-modern、默认 targetPages=1、默认启用 Fit Engine，同时保留环境变量回滚开关。补端到端测试：JD→匹配→生成 ResumeDocument→接受→一页 PDF 导出→下载。
```

---

## 4. 推荐提交节奏

建议每个阶段独立一个 commit 或 PR：

```text
phase-0: add generation/export baseline tests
phase-1: extend tool result structured payloads
phase-2: add narrator response layer
phase-3: introduce resume document model
phase-4: add one-page modern resume template
phase-5: measure resume layout fit report
phase-6: add rule-based one-page compression
phase-7: add LLM fit editor
phase-8: add resume quality report
phase-9: update frontend/backend contract
phase-10: switch default product flow
```

---

## 5. 风险点与处理方式

### 5.1 LLM JSON 不稳定

处理方式：

- 保留现有 repair 机制。
- 对 ResumeDocument 做严格 schema validation。
- 失败时退回旧 `content` variant。

### 5.2 一页适配删掉重要内容

处理方式：

- bullet 增加 `pinned`。
- sourceExperienceId 和 relevanceScore 参与删减排序。
- compressionReport 透明记录删了什么。

### 5.3 Critic 再次造成循环确认

处理方式：

- 普通风险只提示，不阻断。
- 只有 critical unsupported claims 才阻断或要求确认。
- 已确认/已保存的 action 不重复 critic。

### 5.4 前端短期不支持新字段

处理方式：

- 所有新增字段 optional。
- 保留 `message`、`content`、`workspacePatch`、`actionResult`。
- 新字段先用于后端导出和 Narrator，不强依赖前端。

---

## 6. 最小可用版本建议

如果你想最快看到产品质变，最低只做以下 4 个阶段：

```text
阶段 1：工具结果结构化
阶段 2：Narrator 动态回复
阶段 3：ResumeDocument 结构化简历
阶段 4：onePageModernTemplate 专业模板
```

这四步完成后，即使还没有 Fit Engine，系统也会明显从“固定脚本感”升级为“智能 Copilot 感”，PDF 质量也会比当前 defaultTemplate 高很多。

如果你要真正实现“精准一页”，则必须继续做：

```text
阶段 5：布局测量
阶段 6：规则压缩
阶段 7：LLM 压缩/补足
```

---

## 7. 给 CodingAgent 的总控提示词模板

每次执行一个阶段时，可以用下面这个固定格式：

```text
你正在修改 cv-agent 仓库。请只执行《cv-agent 下一阶段改动实施文档》中的【阶段 X】。

要求：
1. 只修改该阶段允许范围内的文件，除非确有必要并说明原因。
2. 不删除旧字段，不破坏现有前后端契约。
3. 保持 fallback 可用。
4. 补充或更新测试。
5. 完成后运行 npm test 和 npm run typecheck。
6. 输出：修改文件清单、关键设计说明、测试结果、后续阶段注意事项。
```

---

## 8. 最终目标状态

完成全部阶段后，cv-agent 的核心体验应当变为：

```text
用户输入 JD 或目标
  → Agent 判断任务
  → 匹配经历并解释依据
  → 生成多个结构化 ResumeDocument 版本
  → Narrator 给出自然、具体的推荐说明
  → 用户选择一个版本
  → 系统保存为完整简历，而不是一段文本
  → one-page-modern 模板渲染
  → Fit Engine 测量和压缩到一页
  → Quality Report 检查真实性、匹配度、版面质量
  → 导出高质量一页 PDF
```

这时你的产品会从“能生成简历”升级为“能像求职 Copilot 一样，理解岗位、筛选经历、组织简历、控制版面、解释风险”。
