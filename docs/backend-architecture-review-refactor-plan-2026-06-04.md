# 后端架构审查与重构规划文档

审查日期：2026-06-04  
审查范围：`E:\vsProjects\cv-agent`  
前端对照范围：`E:\vsProjects\cv_agent_frontend`  
验证命令：`npm run typecheck`，结果通过  
说明：本次审查只分析和建档，不修改业务代码。

## 第一部分：总体评价

当前后端已经具备若干有价值的架构基础，包括 Fastify API 层、Kernel 组装层、Product Service/Repository、ToolDefinition/ToolRegistry/ToolExecutor、ModelClient/Provider 以及 Agent PromptRegistry。  
但核心业务编排仍高度集中在 `src/agent-core/runtime/AgentOrchestrator.ts::AgentOrchestrator`，该文件约 2860 行，同时承担会话、计划、工具、确认、工作区补丁、前端 block 映射和历史兼容职责，已成为后续维护和扩展的主要瓶颈。  
高内聚低耦合程度属于“局部较好、核心链路不足”：工具框架和 repository 抽象较清晰，但 agent、prompt、workflow、pending action、product block、resume generation 等边界仍相互交织。  
可扩展性属于“具备雏形但尚未插件化”：Provider 接口存在，但 Provider 工厂硬编码在 Kernel；Prompt 抽象只覆盖 agent markdown prompt，产品 LLM 服务和工具内仍有大量内联 prompt；Workflow 抽象基本缺失。  
当前最主要技术债务集中在状态管理、LLM 输出治理、重复解析/重复 prompt、前后端契约漂移、数据库一致性和持久化边界。  
当前最主要运行风险是 Pending Action 仅内存持久化、确认流程缺少原子状态迁移、Copilot 会话锁未实际使用、候选经历接受缺少事务和状态保护。  
如果继续在现有结构上叠加多 Provider、多 Agent、任务队列、计费权限和更多经历类型，维护成本会快速上升，并且状态类缺陷会更难定位。  
建议后续采用分阶段策略，先修 P0 状态一致性和幂等性，再逐步抽出 Workflow、Prompt、Schema、Provider Factory 和 Unit of Work。

## 第二部分：核心问题清单

| 问题编号 | 问题位置 | 问题类型 | 严重程度 | 问题描述 | 影响范围 | 根因分析 | 修复建议 | 预计收益 |
|---|---|---|---|---|---|---|---|---|
| B-01 | `src/agent-core/runtime/AgentOrchestrator.ts::AgentOrchestrator` | 内聚问题 / 耦合问题 | 高 | 文件约 2860 行，同时处理 chat/action、plan 执行、pending action、workspace patch、product block、确认文案、历史兼容逻辑。 | Copilot 全链路、经历、简历、JD、确认、前端工作区。 | 缺少 Workflow、Presenter、ActionMapper、ConfirmationCoordinator 分层，功能持续追加到一个运行时类。 | 拆分为 `AgentRuntime`、`WorkflowRunner`、`PendingActionCoordinator`、`WorkspaceProjector`、`ProductBlockPresenter`、`ExplicitActionMapper`。 | 降低修改半径，减少引入回归，便于新增多 Agent/多 workflow。 |
| B-02 | `src/agent-core/runtime/AgentOrchestrator.ts::executeToolOrCreatePendingAction` | 状态风险 / 耦合问题 | 高 | 工具执行、确认创建、scope guard、重复 pending 检测、prepare 预执行和前端 preview 构造混在一个函数。 | 所有写工具、用户确认、卡片生成。 | 确认流程没有独立状态机，prepare/confirm 协议靠工具 id 特判。 | 建立 `PendingActionWorkflow`，把 prepare result、confirm payload、preview、dedupe key 变成显式接口。 | 降低重复确认、重复生成、preview 与执行不一致风险。 |
| B-03 | `src/agent-core/confirmation/PendingActionService.ts::PendingActionService`；`src/api/kernel/createKernel.ts::createKernel` | 状态风险 / 数据一致性风险 | 高 | Postgres 模式下仍使用默认 `InMemoryPendingActionRepository`，Pending Action API 重启即丢失。 | 用户确认、异步生成、后台任务恢复。 | Kernel 没有注入持久化 pending repository，数据库没有 pending action 表。 | 新增 `pending_action` 表、Postgres repository、状态索引和过期索引；Kernel 按数据库模式注入。 | 支持重启恢复，避免 UI 显示 pending 但服务端找不到。 |
| B-04 | `src/agent-core/confirmation/PendingActionService.ts::confirm`；`src/api/routes/pendingActions.ts` | 并发风险 / 幂等性问题 | 高 | `pending -> confirmed -> executed` 不是原子 compare-and-set；确认接口未使用 idempotency wrapper。并发确认可能重复执行写工具。 | 保存经历、保存 JD、生成简历、修改经历。 | Repository 只提供普通 update，没有状态条件更新；路由只依赖 pendingActionId。 | 增加 `confirmOnce(id, expectedStatus)`，数据库层 `UPDATE ... WHERE status='pending' RETURNING *`；确认路由接入 idempotency。 | 防止重复入库、重复任务、状态覆盖。 |
| B-05 | `src/platform/PostgresPlatformServices.ts::PostgresSessionLockService`；`src/api/routes/copilot.ts` | 状态风险 / 并发风险 | 高 | 会话锁服务已实现，但 Copilot chat/actions 路由未调用。现有 `docs/CONTRACT.md` 声称会获取 session lock，与实际代码不一致。 | Copilot 消息、turn、workspace、pending action。 | 锁能力停留在平台服务，未纳入 API middleware 或 orchestrator 调用链。 | 在 `/copilot/chat`、`/copilot/actions`、pending confirm/cancel 引入 user/session 维度锁。 | 避免同一会话并发请求交错写 workspace 和消息。 |
| B-06 | `src/product/services/index.ts::ImportService.acceptCandidate` | 数据一致性风险 / 重复写入 | 高 | 接受 candidate 时不校验 candidate 是否仍为 `pending`，创建 experience 与更新 candidate 状态不在同一事务。 | 用户导入经历、候选入库。 | 缺少 candidate 状态机和 Unit of Work。 | 增加 `acceptCandidateOnce(candidateId)`，在事务内校验 pending、创建 experience/revision、更新 accepted。 | 防止重复点击或重试造成重复经历。 |
| B-07 | `src/product/services/index.ts::GenerationProductService.saveAcceptedVariantToResume` | 数据一致性风险 | 高 | 创建 resume、添加 resume item、更新 generation selection 分多步执行，代码内已有 TODO 要迁移到 unit-of-work。 | 简历生成结果保存、resume item 列表。 | Service 编排跨多个 repository，但 repository 未提供组合事务。 | 新增 `ProductUnitOfWork`，封装 save accepted variant 全流程。 | 避免部分成功导致 generation 与 resume 状态不一致。 |
| B-08 | `src/agent-tools/experience/saveExperienceFromText.tool.ts::saveExperience` | 重复写入 / 状态风险 | 中 | 只按最近 20 条 active experience 做 title/content 前缀去重，非原子且没有数据库唯一约束。 | Copilot 保存经历。 | 业务幂等 key 未沉淀到数据模型，去重逻辑在工具内局部实现。 | 为保存经历生成 canonical hash，建立应用层 dedupe key 和可选唯一索引；工具复用统一去重服务。 | 降低重复卡片、重复入库和并发保存风险。 |
| B-09 | `src/agent-tools/resume/index.ts::prepare_revise_resume_item`；`src/agent-tools/resume/index.ts::revise_resume_item` | LLM 风险 / 重复调用 | 高 | prepare 阶段生成 rewrite preview，confirm 阶段如果没有 `rewrittenText` 会再次调用 LLM，可能导致用户确认的文本和最终写入文本不一致。 | 简历条目改写、用户确认体验。 | prepare 结果没有统一写入 pending action args；confirm 工具仍承担生成职责。 | 将 rewrite 结果固化到 pending action input，confirm 仅执行写入；缺失 rewrittenText 时拒绝执行并要求重新 prepare。 | 避免重复调用模型和 preview/apply 不一致。 |
| B-10 | `src/agent-tools/experience/prepareUpdateExperience.tool.ts`；`src/agent-tools/experience/updateExperience.tool.ts` | 状态风险 / 类型问题 | 中 | update preview 和实际 update payload 边界不清；`updateExperience` 返回 `usedModel: true`，即使内容来自调用方而非当前模型调用。 | 经历编辑、改写确认。 | prepare/update 没有显式 contract，metadata 混合了预览来源和执行结果。 | 定义 `PreparedRevision` schema，confirm action 必须携带 prepared revision id 或 frozen content。 | 提升审计性，避免错误展示“已使用模型”。 |
| B-11 | `src/api/routes/product.ts::readCategory` | 前后端契约不一致 / 类型问题 | 中 | 后端产品类型和前端类型均包含 `internship`，但 REST route 白名单遗漏 `internship`。 | 经历创建、编辑、导入候选。 | 枚举分散在 route helper、后端 type、前端 type 多处维护。 | 将 category 枚举集中到共享 schema，route 从 schema 派生校验。 | 消除合法类别被接口拒绝的问题。 |
| B-12 | `src/api/routes/product.ts::extractVariantsFromOutputSnapshot`；`src/api/routes/product.ts::findVariantsRecursive` | Schema 问题 / LLM 风险 | 中 | 生成结果读取需要递归查找 variants，说明历史和当前输出结构不稳定。 | 简历生成详情、前端展示。 | generation output 没有稳定 DTO 版本，route 层承担兼容解析。 | 给 generation result 增加 `schemaVersion` 和标准 DTO，兼容解析迁入 migration/adapter。 | 简化 route，减少前端拿到不稳定结构。 |
| B-13 | `src/product/LLMExperienceExtractor.ts::parseJsonResponse`；`src/product/LLMGenerationService.ts::parseJson`；`src/product/LLMRewriteService.ts::parseJson`；`src/agent-core/validation/parseAgentJson.ts` | 重复代码 / LLM 风险 | 中 | JSON 解析逻辑多套实现，宽松程度和 fallback 行为不一致。 | 经历识别、简历生成、改写、agent plan。 | LLM JSON 输出治理没有公共基础设施。 | 建立 `src/infrastructure/llm/JsonOutputParser.ts`，统一 fenced JSON、balanced JSON、repair、schema validation 和错误类型。 | 统一错误处理，减少字段缺失和解析差异导致的线上问题。 |
| B-14 | `src/agent-core/prompts/PromptRegistry.ts`；`src/product/LLMExperienceExtractor.ts`；`src/product/LLMGenerationService.ts`；`src/product/LLMRewriteService.ts`；`src/agent-tools/resume/index.ts` | 重复 Prompt / 可扩展性问题 | 中 | Agent prompt 已 markdown 化，但产品 LLM 服务和工具内仍有大量内联 prompt 与 repair prompt。 | LLM 调优、A/B、Provider 适配。 | Prompt 抽象只覆盖 agent 层，产品策略没有 PromptRegistry。 | 扩展 PromptRegistry 到 product/workflow，prompt 带版本、owner、schema、适用 provider。 | 降低 prompt 重复，便于评估和回滚。 |
| B-15 | `src/api/kernel/createKernel.ts::createModelClient`；`src/api/kernel/createKernel.ts::createKernel`；`src/auth/AuthService.ts::resolveUserModelConfig` | 可扩展性问题 | 中 | Provider 接口存在，但选择逻辑硬编码在 Kernel；用户 API Key 配置已存在但未接入实际 ModelClient 创建。 | 多 Provider、多用户模型配置、计费。 | 缺少 `ModelClientFactory` 和 request/user scoped provider resolution。 | 新增 Provider Registry 和 ModelClientFactory，按 user/session/workflow 解析 provider 与 key。 | 新增 Claude、本地模型、硅基流动时不改核心 Kernel。 |
| B-16 | `src/config/env.ts`；`src/api/kernel/createKernel.ts::createModelClient` | 配置漂移 | 中 | `env.ts` 仍保留 `mock/openrouter` 等旧 provider 字段，与 Kernel 当前支持的 `openai/compatible/deepseek` 不一致。 | 部署配置、文档、排障。 | 配置入口分裂，新旧 provider 迁移未清理。 | 合并配置源，删除或迁移旧字段，启动时打印脱敏后的 provider 配置摘要。 | 减少部署误配和排障成本。 |
| B-17 | `src/persistence/postgres/PostgresDatabase.ts::runMigrations`；`src/persistence/postgres/schema.sql`；`src/persistence/postgres/migrations/*` | 数据库架构问题 | 中 | 启动时每次执行 base schema 和全部 migration，未见 migration history 表；schema 中存在旧表族和新 product 表族并存。 | 数据库升级、生产变更。 | 早期 schema 初始化与迁移系统叠加，缺少版本化迁移边界。 | 引入 `schema_migrations`，将 base schema 冻结为初始 migration，整理 legacy 表归属。 | 提升数据库演进可控性。 |
| B-18 | `src/persistence/postgres/migrations/0004_product_asset_loop.sql`；`src/product/repositories/PostgresProductRepositories.ts` | 数据一致性风险 | 中 | product 表缺少关键业务约束，例如 category/status CHECK、候选接受唯一性、resume item/generation 关系约束。 | 经历库、导入候选、简历生成。 | 依赖应用层随机 id 和状态更新，数据库只承担存储。 | 增加低风险 CHECK、唯一索引和必要 FK；对历史数据先做审计脚本。 | 防止脏数据进入核心表。 |
| B-19 | `src/agent-tools/experience/matchExperiencesAgainstJD.tool.ts::enrichWithContent` | 性能问题 | 中 | 对每条 experience 单独加载 revisions，存在 N+1 查询。 | JD 匹配、经历库较大时响应时间。 | Repository 缺少批量 revision 查询接口。 | 新增 `listCurrentRevisionsByExperienceIds(ids)`，工具批量加载。 | 降低数据库往返和 LLM 前处理耗时。 |
| B-20 | `src/agent-core/validation/ToolInputSchemas.ts`；`src/agent-core/tools/Tool.ts::ToolDefinition` | 类型问题 / Schema 问题 | 中 | 多个 schema 使用 `.passthrough()`、`z.unknown()` 和泛型 record，ToolResult 的 actionResult/workspacePatch 缺少细粒度类型。 | 工具调用、前端 block、状态同步。 | 为了快速兼容多工具，schema 没有按工具输出细分。 | 建立工具输入/输出 schema registry，按 toolId 推导 typed result。 | 减少运行时字段缺失和前后端契约漂移。 |
| B-21 | `src/api/routes/product.ts::registerProductRoutes` | 内聚问题 | 中 | 路由文件约 439 行，包含业务 DTO 组装、variant 兼容递归解析、enum 校验和多类资源路由。 | Product API 维护。 | Controller/DTO mapper 未拆分，route 层逐渐承载业务兼容逻辑。 | 拆成 import/resume/generation/experience route 或 controller，并迁出 DTO adapter。 | 让 API 层只负责协议和鉴权，减少业务散落。 |
| B-22 | `src/agent-tools/resume/index.ts` | 内聚问题 / 重复 Prompt | 中 | 一个文件定义多项 resume 工具、schema、prompt、fallback 和执行逻辑，约 472 行。 | 简历生成、改写、导出入口。 | 工具按领域聚合过粗，没有一工具一文件或子目录策略。 | 按 `generateResumeFromJD.tool.ts`、`prepareReviseResumeItem.tool.ts`、`reviseResumeItem.tool.ts` 拆分。 | 便于单测和独立演进 resume 策略。 |
| B-23 | `src/agent-core/runtime/AgentOrchestrator.ts::legacyGuardToolIds`；`src/agent-core/runtime/AgentOrchestrator.ts::legacyAffectedResourcesFor` | 冗余代码 / 历史兼容 | 低 | Runtime 内保留 legacy guard fallback，和当前 canonical guard 工具存在职责重叠。 | Tool guard、确认 scope。 | 旧工具框架迁移后兼容代码未下线。 | 增加调用监控，确认无调用后删除或迁入 compatibility adapter。 | 降低 runtime 噪音和误判。 |
| B-24 | 本地文件 `.env.example` | 安全风险 | 高 | 本地 `.env.example` 中出现疑似真实 `DEEPSEEK_API_KEY`。该文件当前未被 git 跟踪，但存在泄露风险。 | API Key、模型账单、供应商账号。 | 示例环境文件没有使用占位符，且本地工作区保留明文 key。 | 立即轮换/吊销该 key，示例文件只保留 placeholder；确认 `.gitignore` 明确忽略 `.env`，允许受控跟踪安全的 `.env.example`。 | 避免密钥泄露和供应商费用风险。 |

### 前后端契约不一致清单

| 契约点 | 后端位置 | 前端位置 | 问题 | 判断 | 建议 |
|---|---|---|---|---|---|
| `ProductExperienceCategory` | `src/product/types.ts`；`src/api/routes/product.ts::readCategory` | `src/types/product.ts` | 类型包含 `internship`，但 route 校验遗漏。 | 后端 route 问题 | 用共享 schema 派生 route 校验。 |
| `workspacePatch.activePanel` | `src/agent-tools/experience/matchExperiencesAgainstJD.tool.ts` | `src/types/copilot.ts` | 后端返回 `jd_matching`，前端 union 未包含。 | 可能是前端问题，也可能是后端未集中枚举 | 统一 `ActivePanel` 合约，决定保留还是映射为现有 panel。 |
| `ExperienceMatchResult.evidenceFromExperience` | `src/agent-tools/experience/matchExperiencesAgainstJD.tool.ts` | `src/types/product.ts` | 后端返回 string，前端类型为 `string[]`。 | 前后端契约漂移 | 统一为数组或新增 adapter 兼容历史 string。 |
| 导出 `docx` | `src/exports/types.ts`；`src/agent-core/validation/ToolInputSchemas.ts`；`src/exports/ResumeExportService.ts` | `src/types/export.ts` | 类型和 DB 支持 docx，但工具 schema 与 service 当前拒绝 docx。 | 后端能力未完成 | 明确 docx 是未开放能力，或补齐实现和工具 schema。 |

## 第三部分：风险评估报告

| 风险名称 | 风险等级 | 触发条件 | 影响范围 | 当前防护措施 | 缺失措施 | 修复优先级 | 推荐解决方案 |
|---|---|---|---|---|---|---|---|
| Pending Action 重启丢失 | 高 | API 重启、容器迁移、worker 独立进程 | 用户无法继续确认，UI 状态与服务端状态断裂 | 内存 repository 可过期 | 持久化表、恢复策略、状态索引 | P0 | 新增 PostgresPendingActionRepository 和 `pending_action` 表。 |
| 并发确认重复执行 | 高 | 用户双击确认、网络重试、客户端并发 POST | 重复入库、重复生成任务、重复扣费 | 已执行状态下有部分 lastResult 返回 | 原子 pending->confirmed、确认接口 idempotency | P0 | DB 条件更新加 idempotency key，confirm 全链路串行化。 |
| Copilot 会话并发写冲突 | 高 | 同一 session 同时发送 chat/actions/confirm | message、turn、workspace patch 覆盖或乱序 | PostgresSessionLockService 已实现 | 路由未调用锁 | P0 | 在 Copilot mutation routes 使用 session lock。 |
| 导入候选重复接受 | 高 | 接受按钮重复点击、请求超时重试、无 idempotency key | 重复 product_experience 与 revision | 路由有 idempotency wrapper | candidate 状态条件更新、事务 | P0 | `acceptCandidateOnce` 事务化，非 pending 直接返回既有结果或 409。 |
| LLM 输出为空被误判 | 中 | Provider 报错、JSON 解析失败、schema 不匹配 | 导入任务失败原因不清，用户无法排障 | Extractor catch 后返回空数组 | 结构化错误类型、可观测日志、repair 失败原因 | P1 | 区分 provider error、parse error、schema error、empty extraction。 |
| Rewrite preview 与最终写入不一致 | 高 | prepare 生成 preview 后，confirm 阶段再次调用模型 | 用户确认内容不是最终保存内容 | 部分工具可携带 rewrittenText | 强制 frozen output、pending payload 校验 | P0 | prepare 写入 pending args，confirm 只落库。 |
| Prompt Injection | 中高 | 用户经历/JD 中包含指令注入内容 | 模型越权生成 tool plan、错误保存或泄露上下文 | Tool scope guard、schema 校验、fenced user content | 注入检测、system/developer 层隔离策略、输出审计 | P1 | 增加 prompt injection classifier/rule、tool allowlist、敏感字段脱敏。 |
| JSON 解析和 fallback 不一致 | 中 | 模型返回 markdown、半截 JSON、字段缺失 | 不同链路行为不同，线上难复现 | 多处本地 parser 和 repair prompt | 统一 parser、统一错误码、统一 schema version | P1 | 建立 LLM structured output 基础设施。 |
| 保存生成变体部分成功 | 高 | 创建 resume item 后更新 generation 失败 | resume 与 generation selection 不一致 | 代码 TODO 标记 | Unit of Work、事务、补偿逻辑 | P0 | 把 save accepted variant 放入事务。 |
| 后台任务和 Pending Action 状态脱节 | 高 | `generate_resume_from_jd` confirm 后入队，worker 失败或进程重启 | pending action 可能停留 confirmed/generating | Job 有持久化，worker 可更新 job | pending action 持久化、job/pending 关联状态机 | P0 | pending action 记录 `jobId`，worker 统一更新 executed/failed。 |
| API Key 明文泄露 | 高 | 本地 `.env.example` 被复制、截图、误提交 | 供应商账号和费用风险 | 文件当前未被 git 跟踪 | key rotation、placeholder 示例、secret scanning | P0 | 立即吊销/轮换疑似 key，启用 pre-commit secret scan。 |
| Product schema 契约漂移 | 中 | 前后端分别维护枚举/DTO | UI 类型正确但接口拒绝，或 UI 解析失败 | 部分 TS 类型存在 | 共享 contract、contract test | P1 | 建立 `src/contracts` 并生成前端类型。 |
| DB 迁移不可追踪 | 中 | 多环境启动、历史 migration 调整 | schema 不一致，升级不可预期 | SQL 多为 idempotent | migration history、checksum、rollback 计划 | P1 | 引入 migration table 和版本检查。 |
| Rate limit 默认关闭 | 中 | 公开环境配置遗漏 | 模型调用被刷、成本上升 | `applyRateLimit` 已实现 | 生产强制开启、按用户模型额度限制 | P1 | production 下未开启 rate limit 直接启动失败或强告警。 |

## 第四部分：重复与冗余分析

### 重复代码

| 类别 | 位置 | 是否建议删除/合并 | 推荐合并方案 |
|---|---|---|---|
| LLM JSON 解析 | `LLMExperienceExtractor.parseJsonResponse`、`LLMGenerationService.parseJson`、`LLMRewriteService.parseJson`、`parseAgentJson` | 建议合并 | 新建 `src/infrastructure/llm/JsonOutputParser.ts`，按 strict/repair/lenient 模式配置。 |
| Product route DTO/enum helper | `src/api/routes/product.ts` | 建议拆分 | 将 category/status/variant adapter 迁入 `src/contracts/product` 和 `src/modules/product/presenters`。 |
| 经验保存去重 | `AgentOrchestrator.executeToolOrCreatePendingAction`、`saveExperienceFromText.tool.ts::saveExperience`、`ImportService.acceptCandidate` | 建议合并 | 建立 `ExperienceDedupService`，提供 hash、相似度、DB 约束配合。 |
| 工具 preview 构造 | `AgentOrchestrator.previewFor`、各 tool output metadata、product block builder | 建议合并 | 由工具声明 preview schema，Presenter 统一渲染。 |
| 错误字符串 | `LLM_PROVIDER_NOT_CONFIGURED`、`LLM_GENERATION_FAILED` 等分散在 product service/tool | 建议合并 | 迁入 `ErrorCode`，统一 `ApiError`/`AgentError`。 |

### 重复 Prompt

| Prompt 类型 | 位置 | 问题 | 推荐方案 |
|---|---|---|---|
| 经历抽取 | `src/product/LLMExperienceExtractor.ts`、`src/agent-tools/experience/prepareSaveExperienceFromText.tool.ts` 间接复用 extractor | product prompt 内联，不能版本化 | 迁入 `src/prompts/product/experience-extraction/*.md`。 |
| 简历生成 | `src/product/LLMGenerationService.ts` | 生成和 repair prompt 内联 | prompt 带 schema version 和 provider hints。 |
| 改写/风险检测 | `src/product/LLMRewriteService.ts`、`src/agent-tools/resume/index.ts` | resume item rewrite fallback prompt 与 service prompt 重复 | 统一 `RewriteStrategy` 和 prompt registry。 |
| JD 匹配 | `src/agent-tools/experience/matchExperiencesAgainstJD.tool.ts` | 大型 prompt 和 LLM 输出解析都在 tool 内 | 拆成 `JDMatchService` + prompt + schema。 |

### 重复 Schema

| Schema | 位置 | 问题 | 推荐方案 |
|---|---|---|---|
| Experience category | `src/product/types.ts`、`src/api/routes/product.ts::readCategory`、前端 `src/types/product.ts` | `internship` 漏校验 | 共享 Zod schema 生成 TS 类型。 |
| Export format | `src/exports/types.ts`、`ToolInputSchemas.ts`、`ResumeExportService.ts`、DB CHECK、前端 `src/types/export.ts` | docx 支持状态不一致 | 定义 capability matrix，未实现格式在 API 明确返回 `NOT_IMPLEMENTED`。 |
| Tool result | `ToolInputSchemas.ts::ToolResultSchema`、各 tool metadata | 过于宽松，前端 block 靠运行时字段 | 按 toolId 定义 output schema。 |
| Generation result | `LLMGenerationService`、`product.ts::extractVariantsFromOutputSnapshot` | route 递归寻找 variants | 增加 `schemaVersion` 和 migration adapter。 |

### 重复状态处理逻辑

| 状态 | 位置 | 问题 | 推荐方案 |
|---|---|---|---|
| Pending Action | `PendingAction.ts`、`PendingActionService.ts`、`pendingActions.ts`、前端 pending action state | 状态迁移不集中，confirmed/generating/executed 映射不稳定 | 引入状态机：pending、confirmed、running、executed、failed、cancelled、expired。 |
| Import Job/Candidate | `ImportService`、product routes、DB | accept 缺少状态条件 | candidate 状态机迁入 repository 原子操作。 |
| Background Job | `PostgresPlatformServices`、`JobRunner`、`PendingActionService` | job 与 pending action 没有统一生命周期 | pending action 持有 jobId，worker 写回 action 状态。 |
| Export status | export service、DB、前端 | docx 与 worker 类型支持不完整 | 用统一 export workflow 状态。 |

### 重复业务流程

| 流程 | 位置 | 问题 | 推荐合并方案 |
|---|---|---|---|
| 用户导入经历 | `ImportService.createCandidatesFromText` 与 Copilot `prepare_save_experience_from_text`/`save_experience_from_text` | REST 导入和 Copilot 保存走两套入库路径 | 统一为 `ExperienceImportWorkflow`，REST 和 Copilot 只是入口不同。 |
| 简历生成 | `GenerationProductService.generateResumeFromJD` 与 Copilot pending `generate_resume_from_jd` | REST 同步生成，Copilot 确认后异步 job | 统一为 `ResumeGenerationWorkflow`，支持 sync/async policy。 |
| 改写确认 | `prepare_revise_resume_item` 与 `revise_resume_item` | prepare/confirm 均可能调用 LLM | 固化 prepared output，confirm 只写入。 |

### 已废弃但仍保留的代码

| 位置 | 状态 | 建议 |
|---|---|---|
| `AgentOrchestrator.legacyGuardToolIds`、`legacyAffectedResourcesFor` | 旧工具框架兼容逻辑 | 统计调用，确认无流量后删除或迁入 compatibility adapter。 |
| `schema.sql` 中旧表族 `experiences`、`evidences`、`generated_artifacts`、`generation_sessions` | 可能是旧版本或平台通用表 | 标注 owner，确认无引用后制定迁移/归档计划。 |
| `agent_runs` 与 migration 中 `agent_run` | 命名相近且职责可能重叠 | 统一 observability schema，保留一个 canonical 表。 |
| `src/config/env.ts` 旧 provider 配置 | 与 Kernel 实际 provider 选择漂移 | 合并到统一 config。 |

## 第五部分：重构规划

### 第一阶段：低风险修复

目标是不改变业务行为、不破坏接口兼容性、快速降低线上风险。

| 修改内容 | 涉及文件 | 风险等级 | 预计工时 | 预期收益 |
|---|---|---|---|---|
| 轮换并移除本地疑似真实 API Key，示例文件改 placeholder | `.env.example`、`.gitignore` | 低 | 0.5 天 | 消除密钥泄露风险。 |
| 为 pending confirm 接口增加 idempotency 和基础并发保护 | `src/api/routes/pendingActions.ts`、`PendingActionService.ts` | 中 | 1 天 | 减少重复确认。 |
| 启用 Copilot session lock | `src/api/routes/copilot.ts`、`PostgresSessionLockService` | 中 | 1 天 | 避免会话并发写冲突。 |
| `acceptCandidate` 增加状态检查和重复接受保护 | `src/product/services/index.ts::ImportService`、repository | 中 | 1 天 | 防止重复导入经历。 |
| 修复 category `internship` 契约漂移 | `src/api/routes/product.ts`、前端类型对照 | 低 | 0.5 天 | 避免合法类别被拒绝。 |
| 明确 docx 导出能力状态 | `ToolInputSchemas.ts`、`ResumeExportService.ts`、前端 export 类型 | 低 | 0.5 天 | 消除 API 能力误解。 |
| 抽出共享 JSON parser，不改变调用行为 | `LLM*Service.ts`、`parseAgentJson.ts` | 中 | 1.5 天 | 统一 LLM 解析错误和日志。 |
| 增加关键 LLM/状态错误日志字段 | `LLMExperienceExtractor.ts`、`LLMGenerationService.ts`、`PendingActionService.ts` | 低 | 1 天 | 提高线上可定位性。 |

### 第二阶段：架构整理

目标是提升可维护性、可扩展性并降低耦合。

| 方向 | 建议设计 | 涉及位置 | 说明 |
|---|---|---|---|
| Service 抽象 | 建立 `ExperienceImportService`、`ResumeGenerationService`、`RevisionService`、`JDMatchService` | `src/product/services/index.ts`、`src/agent-tools/*` | 让 REST 和 Copilot 共用业务服务。 |
| Provider 抽象 | 建立 `ModelClientFactory` 和 `ProviderRegistry` | `src/api/kernel/createKernel.ts`、`src/providers/*`、`src/auth/AuthService.ts` | 支持 user scoped provider/key。 |
| Schema 抽象 | 建立 `src/contracts` 或 `src/schemas`，集中 Zod schema | `ToolInputSchemas.ts`、product types、前端类型 | 从 schema 生成 API/tool/frontend 类型。 |
| Prompt 抽象 | 扩展 PromptRegistry 到 product prompts | `LLMExperienceExtractor.ts`、`LLMGenerationService.ts`、`LLMRewriteService.ts` | prompt 带版本、owner、schema 和测试样例。 |
| Workflow 抽象 | 建立 `ExperienceImportWorkflow`、`ResumeRewriteWorkflow`、`ResumeGenerationWorkflow`、`PendingActionWorkflow` | `AgentOrchestrator.ts`、`PendingActionService.ts` | 明确 prepare、preview、confirm、execute、project 的边界。 |
| 状态管理统一 | 建立状态机和 transition repository | Pending Action、Import Candidate、Background Job | 所有状态变更通过 transition API。 |
| Presenter 抽象 | 建立 `ProductBlockPresenter`、`WorkspaceProjector` | `AgentOrchestrator.buildProductBlocks`、`previewFor` | 工具结果与前端 block 解耦。 |

### 第三阶段：架构增强

目标是支持多 Agent、多 LLM Provider、更多经历类型、异步任务、监控追踪、用户系统与权限系统。

推荐架构方案：

1. 引入 Workflow Graph：每个核心流程定义为可观测节点，例如 extract、risk_check、suggest、preview、confirm、persist、project。
2. 引入 Tool/Agent 插件注册机制：工具声明 input/output schema、mutability、confirmation policy、dedupe key、owner agent。
3. 引入多 Provider 策略：通过 ProviderRegistry 支持 OpenAI、DeepSeek、Claude、硅基流动、本地模型，并允许按用户、任务、成本和能力选择。
4. 引入结构化输出能力矩阵：优先使用 provider 原生 JSON schema/function calling，无法支持时退化为 prompt + parser + repair。
5. 引入异步任务队列：将 long_generation、document parse、export、batch match 迁入统一 queue，job 与 pending action 关联。
6. 引入 Observability：记录 requestId、sessionId、turnId、toolCallId、provider、model、latency、token usage、parse error、state transition。
7. 引入权限和计费：按 user/project/session 控制模型调用、导出、批量处理和存储配额。
8. 引入领域扩展点：经历类型用 schema registry 和 strategy 支持工作、实习、教育、项目、竞赛、科研等，不再写死在 extractor union 内。

## 第六部分：修复路线图

### P0（必须立即修复）

| 项目 | 为什么必须修 | 不修后果 | 推荐顺序 |
|---|---|---|---|
| 轮换疑似泄露 API Key | 已在本地示例文件发现明文 key | key 被误传、滥用、产生费用 | 1 |
| Pending Action 持久化与原子确认 | 当前确认状态是核心业务入口 | 重启丢确认、重复确认、重复写入 | 2 |
| Copilot session lock 接入 | 锁已实现但未使用 | 并发请求导致 workspace/message 状态覆盖 | 3 |
| Import candidate 接受事务化 | 直接影响经历库数据质量 | 重复经历、候选状态与经历不一致 | 4 |
| Rewrite prepare/confirm 固化输出 | 用户确认内容可能不是最终内容 | 信任问题和履历内容错误 | 5 |
| save accepted variant Unit of Work | 简历生成保存会跨多表写入 | generation/resume item 部分成功 | 6 |

### P1（近期修复）

| 项目 | 为什么值得修 | 修复收益 |
|---|---|---|
| 统一前后端 contract | 当前已有 category、activePanel、docx、evidence 类型漂移 | 降低 UI/API 集成 bug。 |
| 抽出 LLM JSON parser 和错误码 | 多套 parser 行为不一致 | LLM 问题可观测、可 fallback。 |
| ProviderFactory 接入用户配置 | AuthService 已有用户模型配置但未用于调用 | 支持多 Provider 和用户自有 key。 |
| Product route/controller 拆分 | route 层承担业务兼容逻辑 | API 更稳定，测试更聚焦。 |
| PromptRegistry 覆盖 product prompt | prompt 内联难维护 | 支持版本化、A/B、回滚。 |
| DB migration tracking | 生产 schema 演进不可追踪 | 升级更可靠。 |

### P2（长期优化）

| 项目 | 为什么可以延后 | 后续演进方向 |
|---|---|---|
| 多 Agent Workflow Engine | 需要先稳定状态机和 schema | 引入 workflow graph、agent handoff、tool policy。 |
| 插件化工具/Provider | 当前业务规模仍可先 registry 化 | 逐步演进到 plugin manifest。 |
| 全量 legacy 表清理 | 需确认历史数据和线上引用 | 先标注 owner，再迁移归档。 |
| 计费和权限系统 | 依赖用户模型调用链落地 | 按 workflow/provider/token usage 计费。 |
| 深度 observability 平台 | 需要先统一 request/job/action id | 接入 OpenTelemetry 或结构化日志管道。 |

## 第七部分：建议目录结构

建议采用渐进迁移，不做一次性大搬家。目标结构如下：

```text
src/
├── modules/
│   ├── experience/
│   ├── resume/
│   ├── jd/
│   ├── import/
│   └── export/
├── workflows/
│   ├── experience-import/
│   ├── resume-generation/
│   ├── resume-rewrite/
│   └── pending-action/
├── agents/
├── agent-tools/
├── providers/
├── prompts/
├── schemas/
├── contracts/
├── repositories/
├── services/
├── controllers/
├── routes/
├── middleware/
├── infrastructure/
│   ├── db/
│   ├── queue/
│   ├── logging/
│   ├── llm/
│   └── config/
├── types/
└── utils/
```

目录职责说明：

| 目录 | 职责 |
|---|---|
| `modules/` | 按业务领域组织聚合根、领域服务、DTO mapper，例如 experience/resume/jd。 |
| `workflows/` | 跨模块业务编排，定义状态机、步骤、补偿和可观测事件。 |
| `agents/` | Agent 定义、角色、策略、handoff，不直接写数据库。 |
| `agent-tools/` | ToolDefinition 实现，保持薄层，调用 workflow/service。 |
| `providers/` | LLM provider adapter，封装不同厂商协议差异。 |
| `prompts/` | prompt 文件、版本、repair prompt、评测样例。 |
| `schemas/` | Zod schema 和结构化输出 schema。 |
| `contracts/` | 前后端共享 DTO、枚举、API/tool result contract。 |
| `repositories/` | 数据访问接口和实现，不承载业务流程。 |
| `services/` | 单领域应用服务，不跨多个状态机做复杂编排。 |
| `controllers/` | HTTP controller，做输入解析、调用 service/workflow、输出 DTO。 |
| `routes/` | Fastify route 注册，只负责协议绑定。 |
| `middleware/` | 鉴权、幂等、session lock、rate limit、request context。 |
| `infrastructure/` | DB、队列、日志、配置、LLM JSON parser、外部系统。 |
| `types/` | 后端内部通用类型。 |
| `utils/` | 纯函数工具，不能依赖业务服务。 |

## 第八部分：后续推进建议

### 当前最值得优先解决的问题

1. Pending Action 持久化、原子确认、job 关联和 session lock。
2. Import candidate 接受事务化和经历去重。
3. Rewrite prepare/confirm 输出固化。
4. 前后端 contract 集中化，先覆盖 category、activePanel、export format、match result。
5. LLM JSON parser、错误码和日志统一。

### 第一批建议修改的文件

| 文件 | 建议动作 |
|---|---|
| `src/agent-core/confirmation/PendingAction.ts` | 明确状态机和 transition 类型。 |
| `src/agent-core/confirmation/PendingActionService.ts` | 接入 repository 原子状态迁移。 |
| `src/agent-core/confirmation/InMemoryPendingActionRepository.ts` | 补齐与 Postgres repo 一致的条件更新接口，用于测试。 |
| `src/api/kernel/createKernel.ts` | 注入 PostgresPendingActionRepository 和 ModelClientFactory。 |
| `src/api/routes/pendingActions.ts` | 增加 idempotency 和 session lock。 |
| `src/api/routes/copilot.ts` | mutation route 接入 session lock。 |
| `src/product/services/index.ts` | `acceptCandidate`、`saveAcceptedVariantToResume` 事务化。 |
| `src/product/repositories/PostgresProductRepositories.ts` | 增加 Unit of Work 和条件更新方法。 |
| `src/api/routes/product.ts` | 修复 category/docx/DTO contract 漂移。 |
| 前端 `src/types/copilot.ts`、`src/types/product.ts`、`src/types/export.ts` | 与后端 contract 对齐。 |

### 第二批建议修改的文件

| 文件 | 建议动作 |
|---|---|
| `src/agent-core/runtime/AgentOrchestrator.ts` | 逐步抽出 ActionMapper、PendingActionCoordinator、WorkspaceProjector、ProductBlockPresenter。 |
| `src/product/LLMExperienceExtractor.ts` | 抽 prompt、parser、schema，补 internship/科研/竞赛扩展点。 |
| `src/product/LLMGenerationService.ts` | 固定 generation result schemaVersion。 |
| `src/product/LLMRewriteService.ts` | 移除危险 repair fallback，统一 rewrite strategy。 |
| `src/agent-tools/resume/index.ts` | 按工具拆文件，prepare/confirm 固化 payload。 |
| `src/agent-tools/experience/matchExperiencesAgainstJD.tool.ts` | 抽 JDMatchService，批量加载 revisions。 |
| `src/agent-core/validation/ToolInputSchemas.ts` | 按 toolId 拆输入/输出 schema。 |
| `src/agent-core/prompts/PromptRegistry.ts` | 扩展 product prompt registry。 |
| `src/persistence/postgres/PostgresDatabase.ts` | 引入 migration history。 |

### 暂时不要动的模块

| 模块 | 原因 |
|---|---|
| `src/auth/*` | 当前生产安全约束相对清晰，先不要在状态机修复前重构认证。 |
| `src/providers/*` 具体 provider 实现 | 先抽 factory/registry，再改实现，避免同时影响模型调用稳定性。 |
| 旧 DB 表删除 | 需要先确认线上数据和历史引用，不能直接清理。 |
| Export worker 细节 | 除 docx contract 外，等任务队列统一后再系统性重构。 |

### 重构收益最高

1. Pending Action 状态机持久化：直接降低重复写入和状态丢失风险。
2. Workflow 抽象：直接降低 `AgentOrchestrator` 修改半径。
3. Contract/Schema 集中化：直接降低前后端不一致。
4. LLM JSON/Prompt 统一：直接降低模型输出不稳定带来的排障成本。

### 重构风险最高

1. 直接大拆 `AgentOrchestrator`：影响所有 Copilot 流程，必须以测试和小步迁移保障。
2. DB schema 清理：可能影响历史数据，必须先审计引用和数据量。
3. 改变 Pending Action 状态语义：前端 UI 依赖状态，需要兼容 adapter。
4. Provider 调用链改造：可能影响模型可用性和用户 key 权限，需灰度。

### 推荐实施顺序

1. 建 contract test 和状态机测试，先锁住现有行为。
2. 修 P0：key、pending action、session lock、candidate accept、rewrite confirm、variant save。
3. 集中 schema 和 enum，修复已知前后端契约漂移。
4. 抽 LLM JSON parser 和 prompt registry，不改变 prompt 内容。
5. 从 `AgentOrchestrator` 中先抽纯 presenter/action mapper，再抽 pending action workflow。
6. 最后整理 ProviderFactory、DB migration system 和多 Agent workflow。

## 附录：当前核心链路梳理

### 用户导入经历：REST 路径

```text
POST /product/imports/text
  -> src/api/routes/product.ts
  -> ImportService.createTextImportJob
  -> ImportService.createCandidatesFromText
  -> LLMExperienceExtractor.extractCandidates
  -> product_import_candidate(status=pending)
  -> POST /product/import-candidates/:id/accept
  -> ImportService.acceptCandidate
  -> ExperienceService.createExperience
  -> ProductExperienceRepository.createExperienceWithRevision
  -> candidate(status=accepted)
```

当前问题：candidate accept 缺少 pending 状态条件和事务；LLM extractor 失败时容易退化为 empty candidates；REST 导入和 Copilot 保存经历路径重复。

### 用户导入经历：Copilot 路径

```text
/copilot/chat 或 /copilot/actions
  -> AgentOrchestrator.handleChatInternal / handleExplicitAction
  -> plan includes prepare_save_experience_from_text
  -> prepareSaveExperienceFromText.tool.ts
  -> LLMExperienceExtractor.extractCandidates
  -> executeToolOrCreatePendingAction creates pending save_experience_from_text
  -> POST /copilot/pending-actions/:id/confirm
  -> PendingActionService.confirm
  -> saveExperienceFromText.tool.ts
  -> ProductExperienceRepository.createExperienceWithRevision
  -> workspacePatch/product block
```

当前问题：Pending Action 内存持久化；confirm 非原子；保存工具有局部去重但没有数据库幂等；Orchestrator 同时负责 prepare、preview、pending、workspace 映射。

### 简历生成链路

```text
Copilot action generate_resume_from_jd
  -> AgentOrchestrator creates pending action
  -> PendingActionService.confirm
  -> special-case enqueue BackgroundJob(type=long_generation)
  -> JobRunner
  -> GenerationProductService.generateResumeFromJD
  -> LLMGenerationService.generateResumeFromJD
  -> ProductGenerationRepository.createGeneration
  -> worker marks pending action executed
```

当前问题：pending action 与 job 关联不持久，worker 或 API 重启会造成状态断裂；REST direct generation 与 Copilot async generation 是两套入口策略；generation output schema 不稳定，route 需要递归查找 variants。

### Pending Action 状态迁移

当前实现：

```text
pending
  -> confirmed
  -> executed / failed

generate_resume_from_jd:
pending
  -> confirmed
  -> background job running
  -> worker markExecuted / markFailed
```

建议目标：

```text
pending
  -> confirmed
  -> running
  -> executed
  -> failed

pending
  -> cancelled

pending
  -> expired
```

每次迁移必须由 repository 条件更新保护，并记录 `requestId/sessionId/actionId/jobId/toolId/dedupeKey`。

## 第九部分：修复进度追踪

本章节用于记录每轮渐进式修复状态。原始问题清单保持不删除、不覆盖；已修复、部分修复和未修复状态在这里持续追踪。

### 9.1 本轮已完成修复

上一轮已完成以下止血式修复：

| 问题编号 | 当前状态 | 已完成内容 | 实际涉及文件 |
|---|---|---|---|
| B-24 | 已修复 | 本地 `.env.example` 中疑似真实 DeepSeek key 已替换为 placeholder；`.gitignore` 已显式忽略 `.env.local`、`.env.*.local`。 | `.gitignore`、`.env.example` |
| B-04 | 已修复 | Pending Action confirm 已增加 repository 条件状态迁移保护，重复确认不会重复执行工具。 | `src/agent-core/confirmation/*`、`tests/pendingActionRepository.test.ts` |
| B-05 | 已修复 | Copilot `chat/actions/confirm/cancel` mutation 已按 `userId + sessionId` 接入 session lock。 | `src/api/sessionLock.ts`、`src/api/routes/copilot.ts`、`src/api/routes/pendingActions.ts` |
| B-06 | 已修复 | Import candidate 只有 `pending` 才能 accept；Postgres 路径使用事务写入 experience、revision 和 candidate status。 | `src/product/services/index.ts`、`src/product/repositories/*`、`src/api/routes/product.ts`、`tests/productImportIdempotency.test.ts` |
| B-07 | 已修复 | save accepted variant 在 Postgres 路径使用事务创建/更新 resume、resume item、generation。 | `src/product/services/index.ts`、`src/product/repositories/*` |
| B-09 | 已修复 | resume item rewrite confirm 不再二次调用 LLM；缺少固化 `rewrittenText` 时要求重新 preview。 | `src/agent-core/runtime/AgentOrchestrator.ts`、`src/agent-tools/resume/index.ts` |
| B-11 | 已修复 | `internship` route 校验已修复。 | `src/api/routes/product.ts` |
| Contract 漂移 | 已修复 | `activePanel: jd_matching`、`evidenceFromExperience: string[]`、docx 未实现状态已对齐。 | 后端 `src/agent-tools/experience/matchExperiencesAgainstJD.tool.ts`；前端 `src/types/copilot.ts`、`src/types/export.ts`、`src/features/copilot/copilotActionResponseAnalyzer.ts` |
| B-03 | 已修复 | Pending Action 已补齐 Postgres 持久化：新增 `pending_action` migration、`PostgresPendingActionRepository`、Kernel Postgres 模式注入；confirm/cancel/markExecuted/markFailed/expire 均复用 repository 条件状态迁移。 | `src/persistence/postgres/migrations/0010_pending_action.sql`、`src/agent-core/confirmation/PostgresPendingActionRepository.ts`、`src/agent-core/confirmation/PendingActionService.ts`、`src/api/kernel/createKernel.ts`、`src/index.ts`、`tests/PostgresPendingActionRepository.test.ts`、`tests/PostgresSchema.test.ts` |
| B-13 | 已修复 | 新增统一 LLM JSON parser；product 侧经历识别、简历生成、改写的重复 JSON 解析已迁入公共 parser；agent 专用 `parseAgentJson` 已通过 wrapper 复用公共 parser，并继续抛 `AgentError("INVALID_AGENT_OUTPUT")`。 | `src/infrastructure/llm/JsonOutputParser.ts`、`src/product/LLMExperienceExtractor.ts`、`src/product/LLMGenerationService.ts`、`src/product/LLMRewriteService.ts`、`src/agent-core/validation/parseAgentJson.ts`、`tests/JsonOutputParser.test.ts`、`tests/parseAgentJson.test.ts` |

上一轮后端实际修改文件：

```text
.gitignore
.env.example
src/agent-core/confirmation/*
src/api/sessionLock.ts
src/api/routes/copilot.ts
src/api/routes/pendingActions.ts
src/product/services/index.ts
src/product/repositories/*
src/api/routes/product.ts
src/agent-core/runtime/AgentOrchestrator.ts
src/agent-tools/resume/index.ts
src/agent-tools/experience/matchExperiencesAgainstJD.tool.ts
tests/pendingActionRepository.test.ts
tests/productImportIdempotency.test.ts
```

上一轮前端实际修改文件：

```text
src/types/copilot.ts
src/types/export.ts
src/features/copilot/copilotActionResponseAnalyzer.ts
```

### 9.2 部分完成但仍需继续修复

| 问题编号 | 当前状态 | 已完成 | 未完成 | 下一步 |
|---|---|---|---|---|
| 暂无 | - | B-03 已在本轮补齐 Postgres 持久化代码路径。 | 尚未在真实 Postgres 服务上跑集成测试；当前通过 fake `PostgresQueryable` contract test 和 schema migration 静态测试覆盖。 | 后续如 CI 提供 Postgres，可补一条真实数据库 repository integration test。 |
| B-14 | 部分修复 | `PromptRegistry` 已支持 7 个 product prompt key；`LLMExperienceExtractor` system/repair、`LLMRewriteService` 3 个 system prompt、`LLMGenerationService` system/repair 已全部迁入 prompt markdown 文件并通过 registry 读取。 | `src/agent-tools/resume/index.ts`、`matchExperiencesAgainstJD.tool.ts` 等 agent-tools 仍有内联 prompt。 | 下一轮继续 B-14 工具层 prompt，或优先拆分 resume tools（B-22）后逐个迁移。 |
| B-22 | 已修复 | `src/agent-tools/resume/index.ts` 已从 505 行缩至 22 行薄入口；6 个 tool 各居独立文件；共享 helper/prompt 已抽到独立文件。 | 无。 | — |

### 9.3 本轮未处理问题

以下问题上一轮仍未处理，继续按原路线图推进：

| 问题编号 | 当前状态 | 说明 |
|---|---|---|
| B-01 | 未修复 | 未大拆 `AgentOrchestrator`，符合低风险修复原则。 |
| B-02 | 未修复 | Pending Action Workflow 尚未独立抽象。 |
| B-15 | 未修复 | ProviderFactory / ProviderRegistry 尚未接入用户模型配置。 |
| B-17 | 未修复 | DB migration tracking 尚未完成。 |
| B-21 | 未修复 | Product route/controller 尚未拆分。 |
| B-22 | 已修复 | `resume/index.ts` 已拆分。 |
| 其他 P1/P2 | 未修复 | 继续按第五、六、八部分路线图推进。 |

### 9.4 已执行测试记录

上一轮测试结果：

后端：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | 通过，40 files / 353 tests |
| `npm run lint --if-present` | 通过；项目无实际 lint 脚本 |

前端：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run lint:types` | 通过 |

本轮 B-03 修复测试结果：

后端：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | 通过，41 files / 355 tests |

补充测试覆盖：

| 测试文件 | 覆盖内容 |
|---|---|
| `tests/PostgresPendingActionRepository.test.ts` | Postgres repository contract：create/get/list/update、条件状态迁移、重复 confirm 不二次迁移、result 持久化。 |
| `tests/PostgresSchema.test.ts` | `0010_pending_action.sql` migration 存在性、表、状态 CHECK、JSON 字段和索引。 |

### 9.5 下一轮推荐修复顺序

1. B-14 收尾：将 `src/agent-tools/resume/prompts.ts` 迁入 PromptRegistry（B-22 已完成前置拆分，prompt 现已集中在独立文件）。
2. B-15：ProviderFactory 接入用户模型配置。
3. B-21：Product route/controller 小步拆分。
4. B-17：DB migration tracking。
5. B-13：统一剩余 JSON 解析器（`LLMExperienceExtractor`、`LLMRewriteService` 中的 `parseJson` 迁入 `JsonOutputParser`）。
6. B-01 / B-02：从 `AgentOrchestrator` 中先抽 Presenter、ActionMapper、PendingActionCoordinator，不直接大拆 runtime。

### 9.6 本轮计划：B-13 统一 LLM JSON parser

本轮目标：统一 LLM JSON 解析逻辑的第一步，先抽公共 parser，并替换最明显、行为最容易保持一致的重复调用点。

本轮范围：

| 范围项 | 说明 |
|---|---|
| 只抽公共 parser | 新增统一 JSON 提取与解析能力，避免继续复制 `fenced block`、首尾 `{}`/`[]` 截取和 `JSON.parse` 逻辑。 |
| 不改 prompt 内容 | 所有 system/user/repair prompt 文案保持不变。 |
| 不改 LLM 输出 schema | 不调整业务 schema、Zod schema 或模型输出字段。 |
| 不改业务 fallback 语义 | 原来失败后返回空数组、retry、repair 或 throw 的位置继续保留原语义。 |
| 不引入新 Provider | 不处理 ProviderFactory、ProviderRegistry 或用户模型配置。 |
| 不修改 AgentOrchestrator 主流程 | 本轮不拆 runtime，不改 plan/workflow/pending action 流程。 |
| 不改数据库和前端 | 本轮不新增 migration，不修改前端契约。 |

重点涉及位置：

```text
src/product/LLMExperienceExtractor.ts
src/product/LLMGenerationService.ts
src/product/LLMRewriteService.ts
src/agent-core/validation/parseAgentJson.ts
```

本轮成功标准：

| 标准 | 目标 |
|---|---|
| 新增统一 parser | 新增 `JsonOutputParser`，支持 object、array、value、fenced JSON、普通 fenced block、前后带解释文字的 JSON 提取。 |
| 替换调用点 | 至少替换 2 到 3 个最明显重复 parser 调用点。 |
| 保持行为兼容 | 不改变 API response、prompt 文案、LLM 参数、业务输出结构和 fallback 语义。 |
| 测试覆盖 | 新增 parser 单元测试，并确保既有测试继续通过。 |

本轮执行结果：

| 项目 | 结果 |
|---|---|
| B-13 状态 | 已修复（第一阶段）。公共 parser 已落地，product 侧主要重复解析点已统一；agent-core 专用 parser 因错误类型和 runtime fallback 语义更敏感，本轮不强行替换。 |
| 新增 parser | `src/infrastructure/llm/JsonOutputParser.ts`，支持 raw object、raw array、json fenced block、plain fenced block、解释性文本中的 object/array 提取、expected object/array 校验、zod schema 校验、结构化错误码和 preview 截断。 |
| 已替换调用点 | `src/product/LLMExperienceExtractor.ts::parseJsonResponse`；`src/product/LLMGenerationService.ts::parseJson` 的候选提取；`src/product/LLMRewriteService.ts::parseJson`。 |
| 未替换调用点 | `src/agent-core/validation/parseAgentJson.ts` 暂保留：它当前抛 `AgentError("INVALID_AGENT_OUTPUT")`，直接替换可能影响 agent fallback 和 plan validation 观测口径。下一步可在保留 `AgentError` wrapper 的前提下复用公共 parser。 |
| 行为兼容性 | 未修改 prompt、LLM 参数、业务 Zod schema、API response envelope、数据库结构或前端字段；product 侧解析失败仍按原位置返回 `{}`、触发 repair、返回 null 或抛原有 `LLMGenerationError`。 |
| 测试结果 | `npm run typecheck` 通过；`npm test` 通过，42 files / 369 tests；`npm run lint --if-present` 通过，项目无实际 lint 脚本输出。 |

### 9.7 本轮计划：B-13 收尾与 B-14 PromptRegistry 第一阶段

本轮目标分为两部分：B-13 收尾让 agent JSON parser 复用公共 parser，但保持 agent 层错误语义不变；B-14 第一阶段只迁移 product prompt 的管理方式，不修改 prompt 内容、模型调用参数或业务逻辑。

本轮范围：

| 范围项 | 说明 |
|---|---|
| B-13 收尾 | `src/agent-core/validation/parseAgentJson.ts` 通过 wrapper 方式复用 `JsonOutputParser`，继续抛 `AgentError("INVALID_AGENT_OUTPUT")`。 |
| B-14 第一阶段 | 统计 product 侧内联 prompt，选择 1 到 2 个低风险 prompt 迁入 prompt 文件，并通过现有 `PromptRegistry` 或轻量扩展读取。 |
| 不改业务语义 | 不改 AgentOrchestrator、agent plan schema、agent prompt、product 输出 schema、API response、数据库 schema 或前端契约。 |
| 不改模型行为 | 不改 LLM prompt 文案本身，不改 prompt 变量替换方式，不改 temperature、maxTokens、responseFormat 等调用参数。 |
| 测试优先 | 补充 `parseAgentJson` wrapper 测试和 product prompt registry 最小测试，避免大 snapshot。 |

本轮初步判断：

| 模块 | 当前情况 | 本轮处理策略 |
|---|---|---|
| `src/agent-core/validation/parseAgentJson.ts` | 仍有本地 fenced JSON 提取和 `JSON.parse`。 | 改为调用公共 parser，并将所有 parser 错误包回原有 `AgentError("INVALID_AGENT_OUTPUT")`。 |
| `src/agent-core/prompts/PromptRegistry.ts` | 当前只支持 agent prompt key 与 `prompts/*.md`。 | 轻量扩展支持 product prompt key，继续使用现有 prompt 根目录，不新建割裂的 registry。 |
| `src/product/LLMExperienceExtractor.ts` | system prompt 和 repair prompt 独立、变量少、输出 schema 稳定。 | 优先迁移 `SYSTEM_PROMPT` 与 `REPAIR_PROMPT` 到 product prompt markdown 文件。 |
| `src/product/LLMGenerationService.ts` | prompt 较长且与 generation repair、normalization 强相关。 | 本轮暂不迁移，后续 B-14 第二阶段处理。 |
| `src/product/LLMRewriteService.ts` | 有 3 个 rewrite/check system prompt。 | 本轮暂不迁移，后续可按 rewrite/check 分批处理。 |
| `src/agent-tools/resume/index.ts` | 工具内仍有内联 rewrite prompt。 | 本轮暂不迁移，避免同时触碰工具确认流程。 |

成功标准：

| 标准 | 目标 |
|---|---|
| B-13 对外行为不变 | 合法 JSON 与 fenced JSON 仍正常解析；非法 JSON、无 JSON 仍抛 `AgentError("INVALID_AGENT_OUTPUT")`，错误 code 不变。 |
| Product prompt 文件化 | 至少 1 个 product prompt 从内联字符串迁移到 prompt 文件，prompt 内容逐字保持一致。 |
| PromptRegistry 覆盖 product | 能通过明确 key 读取新增 product prompt；读取不存在 key 时有明确错误。 |
| 测试通过 | `npm run typecheck`、`npm test`、`npm run lint --if-present` 通过或说明原因。 |

本轮执行结果：

| 项目 | 结果 |
|---|---|
| B-13 状态 | 已修复。`parseAgentJson.ts` 已复用 `JsonOutputParser`，函数签名和调用方 import 不变；非法 JSON、无 JSON 仍统一包回 `AgentError("INVALID_AGENT_OUTPUT")`，不暴露基础设施层 parser error。 |
| B-14 状态 | 部分修复。已完成 PromptRegistry 覆盖 product prompt 的第一阶段，不标记为完全修复。 |
| 新增 prompt 文件 | `src/agent-core/prompts/prompts/product/experience-extraction-system.md`；`src/agent-core/prompts/prompts/product/experience-extraction-repair.md`。 |
| 修改的 service | `src/product/LLMExperienceExtractor.ts`：移除经历抽取 system/repair 内联 prompt，改为通过 `PromptRegistry` 读取；`buildUserPrompt` 与变量替换方式保持不变。 |
| PromptRegistry 变化 | `src/agent-core/prompts/PromptRegistry.ts` 新增 product prompt key：`product.experienceExtraction.system`、`product.experienceExtraction.repair`；未注册 key 会抛出明确错误 `Prompt not registered: ...`。 |
| 未迁移 prompt | `src/product/LLMGenerationService.ts` 的 generation / repair prompt；`src/product/LLMRewriteService.ts` 的 experience rewrite、resume item rewrite、claim check prompt；`src/agent-tools/resume/index.ts` 的工具内 rewrite prompt。 |
| 未迁移原因 | 这些 prompt 与生成策略、rewrite fallback 或工具确认流程更贴近，本轮为降低风险只迁移独立性最高的经历抽取 prompt。 |
| 行为兼容性 | 未修改 prompt 文案、LLM 参数、API response、数据库 schema、前端契约、AgentOrchestrator、product LLM 输出 schema 或解析失败 fallback。product prompt 文件读取时仅去掉文件末尾单个换行，以保持与原 `join("\n")` 常量一致。 |
| 测试结果 | `npm run typecheck` 通过；`npm test` 通过，44 files / 376 tests；`npm run lint --if-present` 通过，项目无实际 lint 脚本输出。 |
| 下一轮建议 | 继续 B-14，优先迁移 `LLMRewriteService` 中相对独立的 rewrite / claim check system prompt；再迁移 `LLMGenerationService` 的 generation prompt；最后处理 `src/agent-tools/resume/index.ts` 中与确认流程更耦合的 prompt。 |

### 9.8 本轮计划：B-14 PromptRegistry 第二阶段

本轮目标：

* 继续推进 B-14；
* 将 `LLMRewriteService` 中的内联 prompt 迁移到 prompt 文件；
* 通过 PromptRegistry 读取；
* 不修改 prompt 文案；
* 不修改 LLM 参数；
* 不修改业务输出 schema；
* 不修改 API response；
* 不修改数据库；
* 不修改前端；
* 不修改 AgentOrchestrator。

本轮范围：

优先检查并迁移：

* `src/product/LLMRewriteService.ts`

暂时不要迁移：

* `src/product/LLMGenerationService.ts`
* `src/agent-tools/resume/index.ts`

原因：

* `LLMGenerationService` 的 prompt 通常更长，变量更多，输出 schema 更复杂，适合下一轮单独迁移；
* `src/agent-tools/resume/index.ts` 和工具调用、确认流程、fallback 逻辑耦合更深，不适合本轮顺手迁移。

成功标准：

* `LLMRewriteService` 中主要内联 prompt 已迁移到 prompt 文件；
* PromptRegistry 可以读取新增 product rewrite prompt；
* prompt 内容尽量逐字一致；
* service 构造出的最终 prompt 与迁移前保持一致或仅存在尾部换行差异；
* 原有测试通过；
* 新增或更新最小测试；
* 文档记录 B-14 当前状态。

注意：先只写本轮计划，不要直接把 B-14 标成已修复。代码完成并测试通过后再回写结果。

本轮执行结果：

| 项目 | 结果 |
|---|---|
| B-14 状态 | 部分修复。已迁移 `LLMRewriteService` 中 3 个 system prompt，不标记为完全修复。 |
| 新增 prompt 文件 | `src/agent-core/prompts/prompts/product/rewrite-experience-system.md`；`src/agent-core/prompts/prompts/product/rewrite-resume-item-system.md`；`src/agent-core/prompts/prompts/product/rewrite-claim-check-system.md`。 |
| 修改的 service | `src/product/LLMRewriteService.ts`：3 个内联 system prompt 常量（`EXPERIENCE_REWRITE_SYSTEM`、`RESUME_ITEM_REWRITE_SYSTEM`、`CLAIM_CHECK_SYSTEM`）替换为 PromptRegistry 读取；user prompt 模板和 repair 逻辑保持不变。 |
| PromptRegistry 变化 | `src/agent-core/prompts/PromptRegistry.ts` 新增 product prompt key：`product.rewrite.experienceSystem`、`product.rewrite.resumeItemSystem`、`product.rewrite.claimCheckSystem`。 |
| 本轮迁移的 prompt | 1) 经历改写 system prompt；2) 简历条目改写 system prompt；3) claim check / 风险检测 system prompt。 |
| 本轮未迁移的 prompt | `rewriteExperience` / `rewriteResumeItem` / `checkClaims` 的 user prompt 模板（变量拼接复杂，保留在 service 中）；`repairRewrite` 的 repair 对话模板（依赖传入的 system prompt 和 error issues，保留在 service 中）。 |
| 未迁移原因 | user prompt 模板包含大量变量拼接（experienceContext、sourceText、instruction、experiences 列表等），强行模板化会引入不必要的模板引擎依赖，且 prompt 主体已迁移，变量部分更适合保留在代码中。repair prompt 是内联对话构造（assistant role + user role），不是独立 prompt 文件。 |
| 是否修改 prompt 内容 | 否。3 个 system prompt 从 `.join("\n")` 数组原样写入 markdown 文件，只去除文件末尾换行符以保持与原常量一致。 |
| 是否修改 LLM 参数 | 否。temperature、maxTokens、responseFormat 均未修改。 |
| 是否修改业务输出 schema | 否。RewritePreviewSchema、ClaimCheckResultSchema 未修改。 |
| 是否修改 API response | 否。 |
| 是否修改数据库 | 否。 |
| 是否修改前端契约 | 否。 |
| 是否修改 AgentOrchestrator | 否。 |
| 是否改变 JSON parser | 否。 |
| 是否改变 rewrite fallback | 否。repairRewrite 和 fallback 返回逻辑完全保留。 |
| 是否改变 product LLM 输出 schema | 否。 |
| 测试结果 | `npm run typecheck` 通过；`npm test` 通过，44 files / 380 tests；新增 4 个 test case 覆盖 rewrite prompt registry 读取和 LLMRewriteService 集成。 |
| 下一轮建议 | 继续 B-14：迁移 `LLMGenerationService` 的 generation / repair prompt。该 service prompt 更长、变量更多、输出 schema 更复杂，适合下一轮单独迁移。之后再处理 `src/agent-tools/resume/index.ts` 中与确认流程更耦合的 prompt。 |

### 9.9 本轮计划：B-14 PromptRegistry 第三阶段

本轮目标：

* 继续推进 B-14；
* 将 `LLMGenerationService` 中的内联 prompt 迁移到 prompt 文件；
* 通过 PromptRegistry 读取；
* 不修改 prompt 文案；
* 不修改 LLM 参数；
* 不修改业务输出 schema；
* 不修改 variants 结构；
* 不修改 repair 行为；
* 不修改 API response；
* 不修改数据库；
* 不修改前端；
* 不修改 AgentOrchestrator。

本轮范围：

优先检查并迁移：

* `src/product/LLMGenerationService.ts`

暂时不要迁移：

* `src/agent-tools/resume/index.ts`
* 其他工具层 prompt
* 其他和 pending action / confirm 流程耦合较深的 prompt

原因：

* `src/agent-tools/resume/index.ts` 与工具调用、确认流程、fallback、pending action preview 耦合更深，不适合本轮顺手迁移；
* 本轮只收敛 product service 层 prompt，不扩大修改范围。

成功标准：

* `LLMGenerationService` 中主要内联 prompt 已迁移到 prompt 文件；
* PromptRegistry 可以读取新增 product generation prompt；
* prompt 内容尽量逐字一致；
* service 构造出的最终 prompt 与迁移前保持一致或仅存在尾部换行差异；
* 原有测试通过；
* 新增或更新最小测试；
* 文档记录 B-14 当前状态。

注意：先只写本轮计划，不要直接把 B-14 标成已修复。代码完成并测试通过后再回写结果。

### 9.10 本轮结果：B-14 PromptRegistry 第三阶段

本轮实际迁移内容：

* `LLMGenerationService` 中 2 个内联 prompt 已迁移到 prompt markdown 文件并通过 PromptRegistry 读取：
  * `SYSTEM_PROMPT` → `src/agent-core/prompts/prompts/product/generation-resume-system.md`
  * `REPAIR_PROMPT` → `src/agent-core/prompts/prompts/product/generation-resume-repair.md`

修改的文件：

* `src/agent-core/prompts/PromptRegistry.ts`：新增 2 个 product prompt key（`product.generation.resumeSystem`、`product.generation.resumeRepair`）。
* `src/product/LLMGenerationService.ts`：移除内联 prompt 数组拼接，改为 `new PromptRegistry()` 调用 `.get()` 读取，并新增 `import { PromptRegistry } from "../agent-core/prompts/PromptRegistry.js"`。
* `tests/ProductPromptRegistry.test.ts`：新增 4 个 test case，覆盖 generation prompt registry 读取、错误 key、LLMGenerationService 集成、repair 模板变量。

新增文件：

* `src/agent-core/prompts/prompts/product/generation-resume-system.md`
* `src/agent-core/prompts/prompts/product/generation-resume-repair.md`

B-14 当前状态：

| 问题编号 | 状态 | 已完成 | 未完成 | 备注 |
|---|---|---|---|---|
| B-14 | 部分修复 | `LLMExperienceExtractor` system/repair prompt、`LLMRewriteService` 3 个 system prompt、`LLMGenerationService` system/repair prompt 已全部迁移到 prompt 文件并通过 PromptRegistry 读取。 | `src/agent-tools/resume/index.ts` 中与工具确认流程耦合较深的 resume 工具 prompt 仍未迁移。其他 agent-tools（如 `matchExperiencesAgainstJD.tool.ts`）的内联 prompt 也未迁移。 | product service 层 prompt 已全部收敛到 PromptRegistry，工具层 prompt 留待后续轮次。 |

未迁移的 prompt：

* `src/agent-tools/resume/index.ts`：包含 generate resume from JD、revise resume item、prepare revise resume item 等工具的内联 prompt 和 fallback prompt。这些 prompt 与工具确认流程、pending action 状态机、前端 preview 构造耦合更深，不适合本轮顺手迁移。
* `src/agent-tools/experience/matchExperiencesAgainstJD.tool.ts`：JD 匹配 prompt 和输出解析内联在工具内。
* 其他 agent-tools 中的内联 prompt。

本轮行为兼容性说明：

| 检查项 | 结果 |
|---|---|
| 是否修改 prompt 内容 | 否。prompt markdown 文件内容与原 `.join("\n")` 拼接结果逐字一致。PromptRegistry 对 product prompt 执行 `trimOneFinalNewline`，保证最终传入 LLM 的 content 与迁移前一致。 |
| 是否修改 LLM 参数 | 否。temperature（initial 0.4 / repair 0.3）、maxTokens（8192）、responseFormat（"json"）均保持不变。 |
| 是否修改 API response | 否。 |
| 是否修改数据库 | 否。 |
| 是否修改前端契约 | 否。 |
| 是否修改 AgentOrchestrator | 否。 |
| 是否改变 JSON parser | 否。`parseJson()` 函数（使用 `JsonOutputParser.extractJsonCandidates`）未修改。 |
| 是否改变 generation repair | 否。repair 触发条件、repair prompt 中的 `{{errors}}` 替换、repair 调用参数均保持不变。 |
| 是否改变 variants 结构 | 否。normalization、zod schema、`generateVariants` 返回的 `ProductGeneratedVariant[]` 均未修改。 |
| 是否改变 product LLM 输出 schema | 否。 |
| 是否改变 `buildUserPrompt` | 否。user prompt 变量拼接逻辑完全保留在 service 中，未迁移到文件。 |

测试结果：

* `npm run typecheck`：通过。
* `npm test`：全部 44 files / 384 tests 通过（较上轮 380 tests 新增 4 个 test case）。
* 新增测试覆盖：
  * `product.generation.resumeSystem` prompt 可正常读取，包含关键片段。
  * `product.generation.resumeRepair` prompt 可正常读取，包含 `{{errors}}` 占位符且替换后行为正确。
  * 未注册的 generation key 抛出明确错误。
  * `LLMGenerationService` 通过 registry 构造 system prompt，实际 chat 请求中的 system message 与 registry 读取值完全一致。

下一轮建议：

1. 继续 B-14：迁移 `src/agent-tools/resume/index.ts` 中与工具确认流程耦合较深的 prompt。建议先拆分 `src/agent-tools/resume/index.ts`（B-22），再逐个迁 prompt 到文件。
2. B-15：ProviderFactory 接入用户模型配置。
3. B-21：Product route/controller 小步拆分。
4. B-13：统一 JSON 解析器（`LLMExperienceExtractor`、`LLMRewriteService` 中的 `parseJson` 可迁入 `JsonOutputParser`）。

### 9.11 本轮计划：B-22 拆分 resume tools

本轮目标：

* 拆分 `src/agent-tools/resume/index.ts`；
* 将多个 resume tool 按文件拆开；
* 保持 tool id、schema、export、注册方式、执行逻辑完全兼容；
* 不修改 prompt 内容；
* 不迁移 prompt 到 PromptRegistry；
* 不修改 LLM 参数；
* 不修改 API response；
* 不修改数据库；
* 不修改前端；
* 不修改 AgentOrchestrator；
* 不改变 Pending Action 行为；
* 不改变 prepare/confirm 固化输出逻辑。

本轮范围：

优先处理：

* `src/agent-tools/resume/index.ts`

允许新增：

* `src/agent-tools/resume/generateResumeFromJD.tool.ts`
* `src/agent-tools/resume/acceptGenerationVariant.tool.ts`
* `src/agent-tools/resume/prepareReviseResumeItem.tool.ts`
* `src/agent-tools/resume/reviseResumeItem.tool.ts`
* `src/agent-tools/resume/listResumes.tool.ts`
* `src/agent-tools/resume/getResume.tool.ts`
* `src/agent-tools/resume/helpers.ts`
* `src/agent-tools/resume/prompts.ts`

暂时不要处理：

* `src/agent-tools/experience/matchExperiencesAgainstJD.tool.ts`
* `src/product/LLMGenerationService.ts`
* `src/product/LLMRewriteService.ts`
* `src/agent-core/runtime/AgentOrchestrator.ts`
* ProviderFactory
* DB migration tracking
* Product route/controller 拆分

成功标准：

* `resume/index.ts` 变成薄入口文件，只负责 re-export 和 assemble resume tools；
* 每个 resume tool 的主体逻辑移动到独立文件；
* 共享 helper/prompt 抽到独立文件；
* 现有 tool id 不变；
* 现有导出不变（`createResumeAgentTools`、`toWorkspaceVariant`）；
* 现有测试通过；
* 文档记录 B-22 当前状态。

注意：先只写本轮计划，不要直接把 B-22 标成已修复。代码完成并测试通过后再回写结果。

### 9.12 本轮结果：B-22 拆分 resume tools

拆分前 `src/agent-tools/resume/index.ts`（505 行）包含：

* 6 个 tool 定义：`list_resumes`、`get_resume`、`generate_resume_from_jd`、`accept_generation_variant`、`prepare_revise_resume_item`、`revise_resume_item`；
* 共享 helper：`buildVariantActions`（private）、`toWorkspaceVariant`（exported）；
* 内联 system prompt 常量（`prepare_revise_resume_item` fallback 路径）。

拆分后文件结构：

```text
src/agent-tools/resume/
├── index.ts                           (22 行，薄入口)
├── helpers.ts                         (91 行，buildVariantActions + toWorkspaceVariant)
├── prompts.ts                         (5 行，PREPARE_REVISE_RESUME_ITEM_SYSTEM_PROMPT)
├── listResumes.tool.ts                (18 行)
├── getResume.tool.ts                  (18 行)
├── generateResumeFromJD.tool.ts       (58 行)
├── acceptGenerationVariant.tool.ts    (56 行)
├── prepareReviseResumeItem.tool.ts    (126 行)
└── reviseResumeItem.tool.ts           (115 行)
```

各文件职责：

| 文件 | 职责 |
|---|---|
| `index.ts` | 只负责 import 各 tool factory、re-export `toWorkspaceVariant`、导出 `createResumeAgentTools()` 组装数组。 |
| `helpers.ts` | `buildVariantActions`（private）、`toWorkspaceVariant`（exported）。 |
| `prompts.ts` | `PREPARE_REVISE_RESUME_ITEM_SYSTEM_PROMPT` 常量，内容与原内联字符串完全一致。 |
| `listResumes.tool.ts` | `list_resumes` tool factory。 |
| `getResume.tool.ts` | `get_resume` tool factory。 |
| `generateResumeFromJD.tool.ts` | `generate_resume_from_jd` tool factory。 |
| `acceptGenerationVariant.tool.ts` | `accept_generation_variant` tool factory。 |
| `prepareReviseResumeItem.tool.ts` | `prepare_revise_resume_item` tool factory，包含 LLM rewrite service 调用和 direct model client fallback。 |
| `reviseResumeItem.tool.ts` | `revise_resume_item` tool factory，包含 frozen rewrittenText 校验和 LLM fallback（已固化输出逻辑不变）。 |

B-22 当前状态：

| 问题编号 | 状态 | 说明 |
|---|---|---|
| B-22 | 已修复 | `src/agent-tools/resume/index.ts` 已从 505 行缩至 22 行的薄入口文件；6 个 tool 各居独立文件；共享 helper 和 prompt 已抽到独立文件。外部 import 路径不变（`createResumeAgentTools` 和 `toWorkspaceVariant` 仍从 `index.ts` 导出）。 |

B-14 当前状态：不变（仍为部分修复）。本轮为后续 B-14 工具层 prompt 迁移（将 `prompts.ts` 迁入 PromptRegistry）完成了前置拆分。

本轮行为兼容性说明：

| 检查项 | 结果 |
|---|---|
| 是否修改 prompt 内容 | 否。`prompts.ts` 中的常量与原内联 `.join("\n")` 结果逐字一致。 |
| 是否修改 LLM 参数 | 否。temperature（0.3）、maxTokens（800）均不变。 |
| 是否修改 API response | 否。 |
| 是否修改数据库 | 否。 |
| 是否修改前端契约 | 否。 |
| 是否修改 AgentOrchestrator | 否。 |
| 是否改变 Pending Action 行为 | 否。 |
| 是否改变 prepare/confirm 行为 | 否。`prepare_revise_resume_item` 的 LLM rewrite service → direct model client fallback 链完全保留；`revise_resume_item` 的 frozen rewrittenText 优先、缺失时拒绝执行逻辑完全保留。 |
| 是否改变 tool id | 否。6 个 tool 的 `name` 字段均不变。 |
| 是否改变 input/output schema | 否。所有 tool 仍使用相同的 `ToolInputSchemas`。 |
| 是否改变 workspacePatch/actionResult/metadata | 否。所有返回结构逐字段保留。 |

测试结果：

* `npm run typecheck`：通过。
* `npm test`：全部 44 files / 384 tests 通过。
* 已有 `tests/resumeAgentTools.test.ts`（3 tests）全部通过，确认 tool 注册、执行、schema 均兼容。

下一轮建议：

1. B-14 收尾：将 `src/agent-tools/resume/prompts.ts` 迁入 PromptRegistry（现在 prompt 已集中在独立文件中，迁移风险很低）。
2. B-15：ProviderFactory 接入用户模型配置。
3. B-21：Product route/controller 小步拆分。
4. B-17：DB migration tracking。
5. B-01/B-02：从 AgentOrchestrator 中先抽 Presenter / ActionMapper / PendingActionCoordinator。
