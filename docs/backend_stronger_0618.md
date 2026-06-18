你正在 cv-agent 后端 combine 分支上优化多 Agent 系统的泛化能力。

后端仓库：
https://github.com/JsChen766/cv-agent

本地路径：
E:\vsProjects\cv-agent

## 核心判断

当前系统十阶段主链路已经可用：JD 分析、经历匹配、简历生成、接受版本、一页 PDF 导出、质量报告、LLM Critic、RAG、自我进化等都已跑通。

但现在的问题不是“再加一个任务层”，而是：当前多 Agent 系统过于流程驱动，很多能力像是被固定路由和固定工具链写死了，导致泛化能力不足。

例如用户输入：

“根据我的经历帮我写一条自我介绍”

这不是 JD 匹配，也不是完整简历生成。它应该是：

“Agent 读取经历库 / 简历 / JD / RAG evidence / PreferenceBank，然后基于真实经历生成一段求职相关文字。”

但当前系统容易误进入 JD 分析或 JD 匹配，这说明现有 FrontDesk 路由和 Specialist 工具选择过于窄。

## 这次不要做什么

不要新增一个更上层的 Task Layer / Task Router / Task Orchestrator。

原因：

1. 现有 Orchestrator 已经负责 Agent 运行。
2. FrontDesk 已经负责语义接待。
3. Specialist 已经负责工具调用。
4. 再加一层 Task Layer 会让系统变厚、耦合变高、维护变难。
5. 一个好的多 Agent 系统应该更像“能力开放 + 工具策略 + 上下文 grounding”，而不是不断叠流程层。

本次目标不是叠层，而是让现有架构变得更优雅、更高内聚低耦合、更可扩展。

## 接口兼容性硬约束

本次泛化能力增强必须优先通过 Agent 内部能力优化完成，不要轻易改变后端对外接口。

要求：

1. 不要修改现有 REST API 的路径、HTTP 方法、必填参数、请求体主结构和返回体主结构。

   * `/copilot/chat`
   * `/copilot/actions`
   * `/copilot/pending-actions`
   * `/product/*`
   * `/exports/*`
   * `/jobs/*`
     等现有接口必须保持兼容。

2. 不要把新的泛化能力做成一组新的外部 CRUD 接口。

   * 不要新增类似 `/career-writing/*`、`/copywriting/*`、`/self-intro/*` 这种面向前端的新业务路由，除非经过明确审批。
   * 本次优先通过现有 `/copilot/chat` 和 `/copilot/actions` 流程承载，让 Agent 内部完成路由、工具选择和回答生成。

3. 请求参数尽量不变。

   * 用户仍然只需要通过原有 chat message / clientState / activeAssetContext / workspace 上下文表达需求。
   * 不要求前端为了“写自我介绍”额外传一套新参数。
   * 如果确实需要新增字段，只能作为 optional additive 字段并及时记录在该文档中，不得影响旧请求。

4. 返回结构必须保持向后兼容。

   * 现有 `assistantMessage`、`workspacePatch`、`toolResults`、`actionResults`、`pendingActions`、`agentRoomEvents`、`displaySnapshot` 等字段不能删除、重命名或改变语义。
   * 新能力产生的新信息只能通过 optional additive 字段、ToolResult structured fields、SpecialInfo、ProductBlock、AgentRoomEvent 等现有扩展点承载。
   * 前端不读取新增字段时，旧体验仍然必须可用。

5. 泛化能力应优先是 Agent 内部能力扩展。

   * 优化 FrontDesk 的语义 goal 识别。
   * 扩展 Specialist 的 read-only 工具选择能力。
   * 新增或复用一个高内聚的 asset-grounded text generation tool。
   * 接入 RAG / PreferenceBank / userAssetContext。
   * 通过现有 Copilot response contract 返回结果。

6. 允许新增内部 tool、内部 prompt、内部 type、内部 ToolResult resultKind、内部 SpecialInfo kind。
   但这些新增项必须是 additive 的，并且不能要求前端立即同步才能保证主流程可用。

7. 不要为了泛化能力改变现有固定链路接口。

   * JD 分析、JD 匹配、简历生成、accept variant、export resume、quality report、critic review 的原有请求和返回都必须保持兼容。
   * 新的 asset-grounded writing 能力不能影响这些已有链路的参数、确认策略、pendingAction 行为和 SpecialInfo 展示。

8. 如果某个改动需要改变外部接口，必须先停止实现并在报告中说明：

   * 为什么现有接口无法承载；
   * 需要变更哪个接口；
   * 是否有 additive 兼容替代方案；
   * 对前端的影响；
   * 是否需要单独阶段处理。

一句话：本次目标是“释放 Agent 内部能力”，不是“重做 API”。前端仍然通过现有聊天接口表达自然语言需求，后端通过内部路由、工具选择、RAG grounding 和 ToolResult/SpecialInfo 扩展来完成泛化任务。


## 目标架构方向

请把系统从：

固定流程驱动：

User message
→ FrontDesk 归类到固定链路
→ Specialist 执行固定工具链
→ 返回固定 SpecialInfo

优化为：

能力驱动：

User message
→ FrontDesk 识别语义 goal / constraints / asset references
→ Specialist 根据 goal + context + allowed tools 自主选择工具
→ read-only grounding tools 提供经历 / RAG / 偏好上下文
→ generation tool 生成资产 grounded 的结果
→ 通过现有 ToolResult / SpecialInfo / AgentRoomEvent 展示

核心原则：

1. 不新增上层任务编排层。
2. 不破坏现有十阶段主链路。
3. 不破坏现有 SpecialInfo / ProductBlock / workspacePatch 契约。
4. 不让所有任务都进入 JD 匹配。
5. 不把资产驱动写作降级成普通 general.chat。
6. 不让 Narrator 承担事实生成。
7. 释放 read-only 工具和资产上下文能力。
8. save / accept / export / delete 等写操作继续强约束。
9. 所有输出必须基于真实经历、RAG evidence 或明确用户输入。
10. 不得编造经历、公司、项目、指标、职位、结果。

## 必须先阅读真实代码和文档

修改前必须读取真实文件，不允许猜测契约：

* src/agent-core/runtime/AgentOrchestrator.ts
* src/agent-core/agents/BaseAgent.ts
* src/agent-core/agents/FrontDeskAgent.ts
* src/agent-core/agents/ArchitectAgent.ts
* src/agent-core/agents/ExperienceReceiverAgent.ts
* src/agent-core/agents/StrategistAgent.ts
* src/agent-core/prompts/prompts/frontdesk.md
* src/agent-core/prompts/prompts/architect.md
* src/agent-core/prompts/prompts/experience-receiver.md
* src/agent-core/prompts/PromptRegistry.ts
* src/agent-core/validation/AgentOutputSchemas.ts
* src/agent-core/runtime/ContextAssemblyPipeline.ts
* src/agent-core/capabilities/*
* src/agent-core/domain/AgentDomainModule.ts
* src/agent-tools/index.ts
* src/agent-tools/experience/*
* src/agent-tools/resume/*
* src/agent-tools/evidence/*
* src/rag/evidence/*
* src/rag/guideline/*
* src/self-evolution/preference/*
* src/product/services/index.ts
* src/copilot/types.ts
* docs/CONTRACT.md
* docs/copilot-action-contract.md
* docs/cv_agent_next_stage_plan.md

## 第一阶段：架构审查，不要直接改代码

请先输出一份简短架构审查，回答：

1. 当前系统是否已经具备“模型根据上下文和工具列表选择工具”的基础？
2. 为什么实际表现仍然像固定工作流？
3. 是 FrontDesk prompt 太强约束，还是 Specialist allowedTools 太窄，还是 ContextAssembly 没有为泛化任务提供足够 grounding？
4. 当前 general.chat 为什么不适合承担“根据经历写自我介绍”？
5. 当前 Evidence RAG / Guideline RAG / PreferenceBank 哪些可以复用？
6. 最小优雅方案是什么？
7. 是否真的需要新增 Agent？如果不需要，如何复用现有 Agent？
8. 是否真的需要新增 SpecialInfo kind？如果不需要，如何先通过现有结构兼容？
9. 如何避免影响 JD 分析、JD 匹配、简历生成、导出等现有链路？
10. 分阶段实施计划是什么？

审查完成后再实施。

---

## 第一阶段：架构审查输出（Phase 0 报告）

> 仅基于 combine 分支当前真实代码与文档，未改动任何源文件。引用以 `path:line` 标注。

### 1. 是否已具备"模型按上下文+工具列表选择工具"的基础？

**部分具备，但在"资产驱动写作"这条路径上是缺位的。**

底层基础设施齐备：

- `BaseAgent` 走标准 LLM JSON 决策流，由 `AgentDecisionRunner` 把 `availableTools` + `userAssetContext` + `recentMessages` + `agentMessages` 注入 prompt，模型理论上可在 `allowedTools` 范围内自由选择。
- `ContextAssemblyPipeline`（`src/agent-core/context/ContextAssemblyPipeline.ts:22`）已为每个 turn 装配 workspace、recentMessages、`activeAssetContext`、`userAssetContext`，并通过 `applyCapabilityContextProviders` 支持 capability 模块追加 grounding。
- `ToolDefinition`（`src/agent-core/tools/Tool.ts`）已具备 `mutability` / `requiresConfirmation` / `riskLevel` / `ownerAgent` 四维 policy。
- `ToolResult`（`src/agent-core/tools/ToolResult.ts`）已预留 `resultKind` / `summaryFacts` / `entities` / `evidence` / `warnings` / `nextActionHints` 等 additive 字段。
- `AgentRoomEvent`（`src/agent-core/events/AgentRoomEvent.ts:31`）的 `SpecialInfoKind` 已含 `asset_capsule` / `metric_ribbon` / `diff_block` 等通用槽位。

**但工具池本身不支持泛化写作。** `createAgentTools()`（`src/agent-tools/index.ts`）只下发 `careerDomain.tools`，目录下仅 `experience/*`、`resume/*`、`evidence/*`、`jd/*`、`export/*`，没有任何"资产 grounded 文本生成"工具。模型"会选工具"，但根本没有可选的写作工具，于是只能：(a) 走 `generate_resume_from_jd`，或 (b) 退化为纯文本的 `responseType: "final"`（无法 grounding）。

### 2. 为什么实际表现仍像固定工作流？

四处"强约束"叠加形成 funnel：

1. **`FrontDeskIntentSchema` 枚举太窄**（`src/copilot/handoff/FrontDeskHandoffSchema.ts:3-15`）：只允许 `jd.* / resume.* / experience.* / general.chat / clarify`，没有任何 `asset_grounded.*`。模型即便表达写作意图，被 zod 校验后会被 `HandoffNormalizer.inferFallback`（`src/copilot/handoff/HandoffNormalizer.ts:88-92`）改写为 `general.chat`。
2. **HandoffNormalizer fallback 启发式偏 JD/简历**（`src/copilot/handoff/HandoffNormalizer.ts:165-249`）：见"生成/简历/resume/cv"就推 `resume.generate_from_jd`；见"经历/experience"长文就推 `experience.intake`。"根据我的经历写自我介绍"同时命中"经历"+"写"，要么被判为 `experience.intake`，要么保底 `general.chat`，无法进入"写作"分支。
3. **frontdesk prompt 路由表只有 JD / 经历 / 简历 / critic 四档**（`src/agent-core/prompts/prompts/frontdesk.md:44-67`）。该 prompt 在 Example 6 演示了 `experience.match_against_jd` —— 但 grep 显示这个 intent **仅在 prompt 文本里出现**，并未进入 `FrontDeskIntentSchema`，存在一处 **prompt-vs-schema 漂移**。
4. **Architect prompt 把"先匹配再生成"硬绑定**（`src/agent-core/prompts/prompts/architect.md:32`：「When planning generate_resume_from_jd, first plan match_experiences_against_jd in the same turn」）。一旦 FrontDesk 把写作误路由到 architect，立刻进入 JD 匹配 → 简历生成 → variant matrix。

**根因：写作意图在 schema 层就被吃掉**，并非 Specialist 选错了工具。

### 3. 主因归因（FrontDesk prompt / Specialist allowedTools / ContextAssembly）

按权重：

- **FrontDesk prompt + Handoff schema/normalizer：主因（≈60%）**。Schema 不收写作意图 + normalizer fallback 偏 JD/简历，是"误进 JD 匹配"的直接来源。
- **Specialist allowedTools 太窄：次因（≈30%）**。`ArchitectAgent.allowedTools`（`src/agent-core/agents/ArchitectAgent.ts:7-17`）9 个工具全部围绕 JD→简历→variant→export；`ExperienceReceiverAgent.allowedTools`（`src/agent-core/agents/ExperienceReceiverAgent.ts:7-25`）围绕导入/读/写经历。无"读资产+输出文字"这类泛用工具。
- **ContextAssembly grounding：贡献最小（≈10%）**。manifest（experiences/jds/resumes/drafts/active）已经传给所有 Agent；缺的不是 grounding 入口，而是"消费 grounding 生成文本的工具"。EvidenceRAG / GuidelineRAG / PreferenceBank 已经在 `src/rag/*` 与 `src/self-evolution/preference/*` 就绪，目前未被任何写作工具消费。

### 4. 当前 `general.chat` 为什么不适合承担"根据经历写自我介绍"？

- `general.chat` 在 `HandoffNormalizer` 中被强制 `routeTo: "frontdesk"` + `next: "answer_directly"`（`src/copilot/handoff/HandoffNormalizer.ts:88-92`、`243-248`），意味着 **不会进入任何 Specialist loop，不执行任何 tool**，由 FrontDesk 直接 `responseType: "final"` 终结。
- FrontDesk prompt 明确禁止调用工具（`frontdesk.md:7`：「Allowed tools: none by default」）。
- 因此 `general.chat` 路径下：**不读取 experiences、不查 RAG、不查 PreferenceBank、不返回 ToolResult、不产生 SpecialInfo**。硬塞写作必然"凭空捏造经历"或"宽泛敷衍"，违背"不得编造"的硬约束。
- 同时 `general.chat` 无法承载 `usedExperienceIds / usedEvidenceIds / groundingNotes / riskNotes` 等可审计字段，前端也拿不到 ToolResult/SpecialInfo 来渲染卡片。

### 5. Evidence RAG / Guideline RAG / PreferenceBank 哪些可复用？

- **`EvidenceRAGService`**（`src/rag/evidence/EvidenceRAGService.ts`）：已有 `buildEvidencePack`，串联 `JDRequirementParser → ExperienceRetriever / PersistentClaimRetriever → EvidencePackBuilder`，输出 `EvidencePack`。**可作为写作工具的事实底座**（绑定到经历/JD 时）。
- **`GuidelineRAGService`**（`src/rag/guideline/`）：返回 `InstructionPack`，提供风格 / 行业 / 角色级写作指引。**可作为写作工具的 tone/audience/format 辅助层**。
- **`PreferenceBankService`**（`src/self-evolution/preference/PreferenceBankService.ts`）：`recordLearningEvent` / `recordVariantDecision` / `recordExplicitPreference` 与 `PersonalizationPack` 查询已就绪。**可作为写作工具的风格/语言/敏感度偏好输入**，但需在 prompt 层强约束"仅作为 tone/style，不作为事实来源"。
- **`UserAssetContextBuilder` / `ActiveAssetContextBuilder`**：每个 turn 已提供轻量 manifest 与 active id，写作工具可直接消费，不需要新增 context provider。
- **`GroundingContextCoordinator`**（`src/rag/GroundingContextCoordinator.ts`）：已做一层 RAG 编排，写作工具优先经它路由，避免重复实现 retrieval。

结论：**不需要新增 RAG 层**，写作工具是这些服务的"消费者"而非"构造者"。

### 6. 最小优雅方案

> 一句话：**新增 `asset_grounded.*` intent 与一个高内聚 read-only 写作工具，分别接通 FrontDesk 与 Architect/ExperienceReceiver；不动外部 API、不加 Agent、不加 Task Layer。**

落点（仅描述方向，Phase 1+ 实施）：

1. **Handoff schema additive 扩展**：在 `FrontDeskIntentSchema` 上新增 `asset_grounded.write` / `asset_grounded.summarize` / `asset_grounded.interview_answer` / `asset_grounded.profile_text` / `asset_grounded.application_answer` / `asset_grounded.explain`（**枚举追加，不删除旧枚举**）；并修复现有 prompt-vs-schema 漂移项 `experience.match_against_jd`。
2. **FrontDesk prompt 区分语义 goal**：写作类 → `asset_grounded.*` 默认路由到 architect；围绕单条经历的"项目介绍/经历表达"可路由到 experience_receiver。保留 JD 匹配 / 简历生成 / accept / export 旧路由不动。
3. **新增高内聚工具 `compose_career_text`**（read-only, `mutability="read"`, `requiresConfirmation=false`, `riskLevel="low"`）：消费 `userAssetContext` + `EvidenceRAG` + `GuidelineRAG` + `PreferenceBank`；输出 `ToolResult` 时复用 `resultKind: "asset_grounded_text_completed"` + `summaryFacts` + `entities` + `evidence` + `warnings` + `nextActionHints`，**不引入新顶层 ToolResult 字段**。
4. **复用现有 Agent**：把 `compose_career_text` 加入 `ArchitectAgent.allowedTools`（主路径）与 `ExperienceReceiverAgent.allowedTools`（围绕单条经历的写作）；**不新增 CopywriterAgent**。
5. **Architect prompt 分支**：当 handoff intent 是 `asset_grounded.*` 时，仅允许 `compose_career_text` + `get_resume` / `list_resumes` / `get_jd` 等只读工具；显式禁止 `generate_resume_from_jd` / `match_experiences_against_jd` / `accept_generation_variant` / `export_resume`。
6. **HandoffNormalizer 启发式补丁**：识别"写自我介绍/写一段/写项目介绍/面试开场/总结优势/回答申请表"等关键词，优先归类为 `asset_grounded.write` 而非 `general.chat`；保留现有 JD/简历启发式不动。
7. **Narrator 边界明确**：`compose_career_text` 的结果可由 `NarratorService` 做表达增强，**禁止 Narrator 改正文事实**。
8. **可观测**：复用 `LearningEventService` 记录 `asset_grounded.*` 事件流，便于 PreferenceBank 后续学习写作偏好。

### 7. 是否需要新增 Agent？

**不需要。** 三点原因：

- 当前问题不是缺一类智能体，而是**缺一类工具**。复用 `ArchitectAgent` + `ExperienceReceiverAgent` 即可。
- 新增 Agent 会牵连 `AgentNameSchema`（`src/agent-core/validation/AgentOutputSchemas.ts:4`）、`PromptRegistry.AGENT_PROMPT_FILES`（`src/agent-core/prompts/PromptRegistry.ts:6`）、`AgentRoomAgentName`（`src/agent-core/events/AgentRoomEvent.ts:10`）、`careerDomain` registry、前端 agent persona/avatar、AgentRoom 渲染。**这些都是契约层的破坏性改动**。
- 复用方案：`Architect` 在 `asset_grounded.*` intent 下走"只读+写作"分支，`ExperienceReceiver` 在用户明确围绕单条经历表达时承接。这是路由 + prompt + allowedTools 的 additive 调整，与旧链路完全共存。

如果未来写作需求迅速膨胀（多语种、多体裁、人格化），再评估是否拆 `CopywriterAgent`。当前 Phase 1-5 不做。

### 8. 是否需要新增 SpecialInfo kind？

**Phase 5 之前不需要新增。** 优先复用现有结构：

- 写作结果可走 `asset_capsule`（`SpecialInfoKind` 已存在，`src/agent-core/events/AgentRoomEvent.ts:39`）承载 title + content + usedExperienceIds + groundingNotes（通过 `data` + `relatedResourceIds` 字段）。
- 风险与建议可复用 `risk_callout` + `nextActionHints`。
- 如 Phase 5 评估 UX 上"写作草稿"需要独立卡片样式，再 additive 扩展 `SpecialInfoKind` 增加 `writing_result` 或 `asset_grounded_text`。**新增枚举值是 additive，前端不消费时仍可降级渲染为通用卡片。**

### 9. 如何避免影响现有十阶段主链路？

- **路由级隔离**：`asset_grounded.*` intent 下 `architect.md` 只允许只读工具，硬规则禁止 `generate_resume_from_jd` / `accept_generation_variant` / `export_resume`，不会进入 `maybeAugmentResumeGenerationPlan`（`src/agent-core/runtime/AgentOrchestrator.ts:829-835`，augment 仅对 `generate_resume_from_jd` 生效）。
- **CriticGate 不受影响**：`compose_career_text` 是 read-only + low risk，按 `ReviewPolicy` 默认不触发强制 critic。受 critic 强制审查的 `generate_resume_from_jd` / `accept_generation_variant` 链路无变化。
- **PendingAction 不受影响**：`compose_career_text` 不要求确认，不进入 `pendingActions`，不影响 `/copilot/pending-actions` 行为。
- **Workspace contract 不变**：写作工具只在 ToolResult / AgentRoomEvent 中输出文字，不写 `workspacePatch.variants` / `productGenerationId` / `activePanel: "variants"` 这些十阶段关键字段。
- **回归测试**：保留并扩展现有 routing 测试，新增三类回归：写作 → asset_grounded.write 不进 JD match；匹配 JD → 仍走 `match_experiences_against_jd`；基于 JD 生成简历 → 仍走 `resume.generate_from_jd`。

### 10. 分阶段实施计划（与原文 Phase 0–6 对齐）

| Phase | 范围 | 主要文件 | 是否影响外部 API |
|-------|------|---------|-----------------|
| 0（本阶段）| 架构审查，不改代码 | 本文件 | 否 |
| 1 | FrontDesk 语义 goal 修正 | `FrontDeskHandoffSchema.ts`、`FrontDeskHandoff.ts`、`HandoffNormalizer.ts`、`frontdesk.md`、`TaskStateReducer.ts` | additive，不破坏 |
| 2 | 新增 `compose_career_text` 工具 | 新建 `src/agent-tools/writing/*`、`src/agent-domains/career/index.ts`（注册）、可选 PromptRegistry | 否 |
| 3 | 开放 Architect / ExperienceReceiver allowedTools | `ArchitectAgent.ts`、`ExperienceReceiverAgent.ts`、`architect.md`、`experience-receiver.md` | 否 |
| 4 | RAG / PreferenceBank 接入 | `composeCareerText.tool.ts` 内部调用 `EvidenceRAGService` / `GuidelineRAGService` / `PreferenceBankService` | 否 |
| 5 | SpecialInfo / contract 兼容渲染 | 优先 `asset_capsule`；如需独立 kind 再 additive 扩展 `SpecialInfoKind` + 更新 `docs/CONTRACT.md` / `docs/copilot-action-contract.md` | additive，不破坏 |
| 6 | 回归 + 真实 LLM probe | 测试代码 | 否 |

---

## Phase 0 完成情况与对外 API / contract 影响评估

### 完成情况（截至本次输出）

- ✅ 已读取并复核：`AgentOrchestrator.ts`、`FrontDeskAgent.ts` + prompt、`ArchitectAgent.ts` + prompt、`ExperienceReceiverAgent.ts` + prompt、`StrategistAgent.ts`、`PromptRegistry.ts`、`AgentOutputSchemas.ts`、`ContextAssemblyPipeline.ts`、`FrontDeskHandoffSchema.ts`、`HandoffNormalizer.ts`、`Tool.ts`、`ToolResult.ts`、`AgentRoomEvent.ts`、`copilot/types.ts`、`agent-tools/index.ts`、`rag/evidence/EvidenceRAGService.ts`、以及 `src/rag/` 与 `src/self-evolution/preference/` 目录结构。
- ✅ 已识别一处 **现有缺陷**：`experience.match_against_jd` 在 `frontdesk.md:146` 出现但未进入 `FrontDeskIntentSchema`，将在 Phase 1 一并修复。
- ✅ 已识别 `general.chat` 路径无法承载 grounding 写作（路由强制回 frontdesk + 禁止工具调用）。
- ✅ 已确认 RAG / PreferenceBank / UserAssetContext / GroundingContextCoordinator 全部可复用，无需新增 RAG 层。
- ✅ 已确认 `ToolResult` / `AgentRoomEvent.SpecialInfoKind` 现有 additive 扩展点足以承载写作结果，Phase 1-4 可不动外部 contract。
- ❌ 未改动任何源文件（符合 Phase 0 "不直接改代码" 要求）。

### 对现有对外 API / contract 的影响（覆盖 Phase 0–6 全程）

> 评估目标：让前端在所有阶段完成后能识别"哪些字段是新增的、哪些行为是新分支"，并据此判断是否需要前端配合。

#### A. REST API 路径与方法：**零影响**

- `/copilot/chat`、`/copilot/actions`、`/copilot/pending-actions`、`/product/*`、`/exports/*`、`/jobs/*` 全部保持现状。
- 不新增任何 `/career-writing/*`、`/copywriting/*`、`/self-intro/*` 等业务路由。
- HTTP 方法、必填路径参数、URL 结构无改动。

#### B. 请求体（CopilotChatRequest）：**零影响**

- `sessionId / message / resumeText / jdText / targetRole / clientState` 字段不变。
- 用户仍然只通过自然语言 `message` + 已有 `clientState` / `activeAssetContext` 表达写作意图，**不要求前端新增任何字段**。
- `clientState` 不新增字段；如未来某项可选字段确实必要，会作为 optional additive 字段并在本文件单独记录。

#### C. 响应体（CopilotChatResponse）：**仅 additive 扩展，不破坏**

主要字段保持向后兼容：
- `assistantMessage` / `workspace` / `nextActions` / `suggestedPrompts` / `timeline` / `raw` 语义不变。
- `agentRoomEvents`：仅新增事件，不删除/重命名/改语义。前端不消费时旧体验照常。

可能新增的 additive 字段（前端不读时无影响）：
- `ToolResult.resultKind = "asset_grounded_text_completed"`：现有可选字段，新增取值。
- `ToolResult.summaryFacts / entities / evidence / warnings / nextActionHints`：均为 Phase 1 已存在的可选字段，新增取值。
- `AgentRoomEvent.specialInfo.kind`：Phase 1-4 复用 `asset_capsule`；Phase 5 如需独立卡片再新增 `writing_result` 或 `asset_grounded_text`（仍是 additive 枚举）。

#### D. Handoff intent 枚举：**additive 新增**

- `FrontDeskIntentSchema` 新增 `asset_grounded.*` 一组枚举（保留所有旧枚举）。
- `FrontDeskHandoff` 通常在内部使用，但若前端直接消费 `workspace.handoffs[].intent`，会看到新值。前端按未知值降级即可（不影响现有渲染逻辑）。

#### E. PendingAction / ConfirmFlow：**零影响**

- `compose_career_text` 是 read-only 工具，不进入 `pendingActions`。
- 现有 `generate_resume_from_jd` / `accept_generation_variant` / `export_resume` / `update_experience` / `delete_experience` / `save_*` 的确认流程、风险等级、超时策略全部不变。

#### F. Workspace contract：**零影响**

- 写作工具不写 `variants` / `productGenerationId` / `activeVariantId` / `activePanel` / `exportRecords` 等十阶段关键字段。
- `workspacePatch` 仅可能在写作场景为空对象或仅含可观测元数据（不影响主链路渲染）。

#### G. SpecialInfo / ProductBlock：**Phase 5 之前完全复用，之后 additive**

- Phase 1-4：复用 `asset_capsule` / `risk_callout` / `metric_ribbon` 等已有 `SpecialInfoKind`，**前端无需任何改动**。
- Phase 5 可选：additive 新增 `writing_result` / `asset_grounded_text` 枚举值，并更新 `docs/CONTRACT.md` 与 `docs/copilot-action-contract.md`。前端不消费时仍能按未知 kind 降级为通用卡片。

#### H. 十阶段主链路（JD 分析、JD 匹配、简历生成、accept、export、quality、critic、RAG、self-evolution）：**零影响**

- 入参、出参、确认策略、SpecialInfo 展示全部保持现状。
- 路由级隔离 + Architect prompt 分支确保 `asset_grounded.*` 不会混入 JD 匹配 / 简历生成链路。

#### I. 给前端的识别建议（后续阶段完成后）

前端在 Phase 6 完成后可通过以下方式识别"新写作能力"：
1. `agentRoomEvents[i].specialInfo.kind === "asset_capsule"` 且 `source.toolName === "compose_career_text"` —— Phase 1-4 阶段。
2. `toolResults[i].resultKind === "asset_grounded_text_completed"` —— 全程通用判定。
3. `workspace.handoffs[].intent` 以 `asset_grounded.` 开头 —— 全程通用判定。
4. Phase 5 后可能出现 `specialInfo.kind === "writing_result"`（additive）。

> **重要承诺**：以上所有变化都是 additive 的；前端**不立即升级**也不会破坏旧体验。如后续阶段中发现某项确需破坏性改动，将立即停止实现并在本文件追加说明（包括原因、替代方案、对前端的影响）。

### 风险与待跟进项

- ⚠️ `experience.match_against_jd` prompt-vs-schema 漂移：Phase 1 修复时需同时检查 `HandoffNormalizer.asIntent` 与 `TaskStateReducer.tasksFromHandoff` 是否需要兼容性补丁。
- ⚠️ `HandoffNormalizer.classifyMessage` 启发式与 prompt 决策可能冲突：Phase 1 测试需覆盖 `responseType="route"` 场景下 model handoff 优先生效、fallback 启发式仅在 schema 失败时兜底。
- ⚠️ `compose_career_text` 调用 EvidenceRAG 可能拉高单 turn 延迟：Phase 4 需评估是否仅在用户显式指定 JD/经历时才执行 retrieval，否则只走 `userAssetContext` 浅 grounding。
- ⚠️ PreferenceBank 注入需要在 prompt 层强约束"仅 tone/style，不作为事实"：Phase 4 prompt 需明确写出该边界，并由 Phase 6 LLM probe 验证。

---

## 推荐解决方向：能力开放，而不是加层

### 1. FrontDesk 从“固定流程路由”改成“语义 goal 识别”

不要让 FrontDesk 把所有求职相关内容都压成 JD / 简历 / 经历几条固定链路。

FrontDesk 应识别三类目标：

A. 明确固定链路 goal：

* jd.analyze
* experience.match_against_jd
* resume.generate_from_jd
* resume.export
* experience.rewrite
* resume.optimize_item
* critic.review

B. 资产驱动泛化 goal：

* asset_grounded.write
* asset_grounded.summarize
* asset_grounded.explain
* asset_grounded.interview_answer
* asset_grounded.profile_text
* asset_grounded.application_answer

C. 普通轻量回答：

* general.chat

注意：

“根据我的经历写自我介绍”
“帮我写一段面试开场”
“根据 WEEX 经历写项目介绍”
“根据我的经历总结个人优势”
“根据这份 JD 写一段自我介绍”
“帮我回答申请表问题”

这些都属于 B，不是 JD 匹配，也不是普通闲聊。

只有用户明确说：

“匹配 JD”
“哪些经历适合这个 JD”
“分析我和 JD 的匹配度”
“match experiences against JD”

才进入 experience.match_against_jd。

### 2. 不新增 Task Layer，只新增一个高内聚的通用工具能力

新增一个通用工具，而不是为每个任务新增一个工具。

建议工具名：

generate_asset_grounded_text

或：

compose_career_text

职责：

基于用户资产、RAG evidence、PreferenceBank 和用户目标，生成求职相关文字内容。

它不是“自我介绍工具”，也不是“cover letter 工具”，而是一个高内聚的资产 grounded 文本生成工具。

输入不应该过度枚举死：

{
goal: string;
userInstruction: string;
outputType?: "self_intro" | "interview_answer" | "cover_letter" | "profile_summary" | "project_intro" | "application_answer" | "pitch" | "custom";
assetScope?: {
experienceIds?: string[];
resumeId?: string;
jdId?: string;
};
jdText?: string;
constraints?: {
length?: "short" | "medium" | "long";
language?: "zh" | "en" | "auto";
tone?: string;
audience?: string;
format?: "paragraph" | "bullets" | "script" | "email" | "answer";
};
}

输出：

{
title: string;
outputType: string;
content: string;
alternatives?: Array<{
title: string;
content: string;
scenario?: string;
}>;
usedExperienceIds: string[];
usedResumeIds?: string[];
usedJDIds?: string[];
usedEvidenceIds?: string[];
groundingNotes: string[];
riskNotes: string[];
suggestions: string[];
}

工具要求：

1. 只读，不保存、不导出、不修改资产。
2. 可以读取 experiences / resumes / jds。
3. 可以调用或复用 Evidence RAG。
4. 可以使用 PreferenceBank，但只作为风格和偏好，不作为事实来源。
5. 如果用户指定某条经历，如 WEEX，必须解析到真实 experienceId 或明确说明未找到。
6. 如果没有足够经历，返回 needs_input，不要编造。
7. 不返回 resume variants。
8. 不触发 accept/export。
9. 不生成 match matrix。
10. ToolResult 必须结构化：

* resultKind: "asset_grounded_text_completed"
* summaryFacts
* entities: writing_result / experience / jd / resume
* evidence
* warnings
* nextActionHints

### 3. 复用现有 Agent，避免新增 Agent 造成耦合

优先不要新增 CopywriterAgent。

原因：

1. 新增 Agent 会牵涉 AgentName schema、PromptRegistry、domain registry、前端 agent persona、AgentRoom 渲染。
2. 当前问题不是缺一个 Agent，而是现有 Agent 工具能力太窄。
3. 资产 grounded 文本生成可以作为 Architect 的扩展能力，或者作为 ExperienceReceiver / Architect 共同可用的只读工具。

推荐方案：

* 将 `compose_career_text` / `generate_asset_grounded_text` 加入 ArchitectAgent allowedTools。
* 必要时也加入 ExperienceReceiverAgent allowedTools，用于“根据某条经历写一段表达”。
* 修改 architect prompt：

  * 当 goal 是 asset_grounded.write / profile_text / interview_answer / cover_letter 等时，只调用 compose_career_text。
  * 不要调用 generate_resume_from_jd。
  * 不要调用 match_experiences_against_jd。
  * 不要调用 accept/export。
* 修改 experience-receiver prompt：

  * 当用户要求围绕单条经历生成面试表达/项目介绍时，可以调用 compose_career_text 或先读取 experience 再调用。
  * 不要保存或改写原经历，除非用户明确要求“保存/更新”。

这比新增 Agent 更低耦合，也更符合现有架构。

### 4. 用 Tool Policy 释放能力，而不是加流程层

请检查现有工具注册、allowedTools、mutability、requiresConfirmation、riskLevel 等机制。

目标：

* read-only 工具可以更开放。
* content generation 工具可以开放。
* write/export/delete/accept 工具继续严格确认。
* Specialist 可以根据 goal 自主选择只读工具和生成工具。
* 不要靠 FrontDesk 把每个任务预先写死成固定流程。

原则：

读工具：

* list_experiences
* get_experience
* list_resumes
* get_resume
* get_jd
* evidence retrieval
* preference retrieval
* compose_career_text

可以给相关 Agent 更开放。

写工具：

* save
* update
* accept
* export
* delete

继续强约束。

### 5. RAG / PreferenceBank 接入方式

不要新增单独 RAG 层。

请复用现有 Evidence RAG / Guideline RAG / PreferenceBank 的服务或已有 context pack 组装逻辑。

compose_career_text 应该可以拿到：

* 相关 experiences
* 相关 claims / evidence
* active resume
* active JD 或 pasted JD
* PreferenceBank 中的表达偏好 / 稳定偏好
* 用户当前 goal

但要保持事实边界：

* Evidence RAG 提供事实依据。
* PreferenceBank 提供偏好，不提供事实。
* 没有 evidence 时在 riskNotes 说明。
* 输出必须包含 usedExperienceIds。
* 如果无法 grounding，必须 ask clarification 或给出低风险泛化回答，不能编造。

### 6. Narrator 只做表达增强，不做能力本体

可以让 Narrator 对 compose_career_text 的结果做更自然的总结，例如：

“我基于你的 WEEX 实习和项目经历整理了一版 1 分钟自我介绍，你可以继续让我改成更口语/更短/英文版。”

但 Narrator 不允许：

* 决定路由。
* 自行读取资产。
* 自行添加经历事实。
* 改变正文核心含义。
* 替代 ToolResult / SpecialInfo。

### 7. 输出仍走现有聊天区特殊信息

不要为了这类任务新增 CRUD 页面。

优先通过现有 ToolResult / ProductBlock / SpecialInfo 机制展示。

如果新增 kind 成本较低，可以新增：

writing_result 或 asset_grounded_text

结构：

{
title: "自我介绍草稿",
content: "...",
outputType: "self_intro",
usedExperienceIds: [],
usedEvidenceIds: [],
groundingNotes: [],
riskNotes: [],
suggestions: [],
alternatives: []
}

如果新增 SpecialInfo kind 会牵涉前端较多改动，可以先用现有 asset_capsule / metric_ribbon / rich text block 兼容，但 contract 要写清楚，便于前端后续独立接入。

## 分阶段实施计划

### Phase 0：架构审查和边界确认

只读代码和 docs，输出分析，不改代码。

产出：

* 当前误路由根因
* 最小优雅方案
* 要改哪些文件
* 是否复用 Architect / ExperienceReceiver
* 是否新增工具
* 是否新增 SpecialInfo kind
* 风险评估

### Phase 1：FrontDesk 语义 goal 修正

目标：
让 FrontDesk 区分：

* JD match
* resume generation
* asset grounded writing
* general chat

修改：

* frontdesk.md
* handoff schema / normalizer，如有必要
* routing tests

验收：
“根据我的经历写自我介绍”不再进入 JD match。
“帮我看哪些经历匹配 JD”仍然进入 JD match。
“基于 JD 生成简历”仍然进入 resume generation。

---

## Phase 1 完成情况报告（语义 goal 修正）

> 已完成。仅做语义路由与契约一致性修正；未实现 `compose_career_text`，未新增上层 Task Layer，未新增 Agent，未新增/修改外部 REST API。`npm run typecheck` 与 `npm test` 均通过（90 / 90 test files，796 / 796 tests）。

### 1. 修改文件清单

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/copilot/handoff/FrontDeskHandoffSchema.ts` | additive | 在 `FrontDeskIntentSchema` 中追加 `experience.match_against_jd` 与 `asset_grounded.write` 两个枚举值；在 `FrontDeskSuggestedActionSchema` 中追加 `compose_career_text`；新增可选 `goal` / `outputType` / `constraints` 顶层字段；在 `extracted` 中新增可选 `experienceIds` / `experienceQuery`；导出 `AssetGroundedOutputTypeSchema` / `AssetGroundedConstraintsSchema` 类型，便于 Phase 2+ 调用方静态化使用。 |
| 2 | `src/copilot/handoff/FrontDeskHandoff.ts` | additive | TypeScript 端镜像同步：`FrontDeskIntent` / `FrontDeskSuggestedAction` 联合类型扩枚举；新增 `AssetGroundedOutputType` / `AssetGroundedConstraints` 类型；`FrontDeskHandoff` 上加 `goal` / `outputType` / `constraints` 可选字段。 |
| 3 | `src/copilot/handoff/HandoffNormalizer.ts` | 内部修复 + additive | (a) `asIntent` / `suggestedActions` 与 schema 对齐；(b) 新增 `defaultRouteForIntent`，把新 intent 的默认 routeTo 锁定到合法 specialist；(c) 新增 `pickConstraints` 用于结构化解析 `constraints`；(d) 重写 `classifyMessage` 启发式：写作类优先级最高，`experience.match_against_jd` 次之，原有 JD/简历/经历/general.chat 启发式保留兜底；(e) 新增 `detectAssetGroundedWriting` / `detectMatchAgainstJD` / `extractExperienceQuery` 辅助函数；(f) `inferFallback` 把模型 raw handoff 中的 `goal`/`outputType`/`constraints`/`experienceIds`/`experienceQuery` 透传到归一化结果。 |
| 4 | `src/copilot/tasks/TaskStateReducer.ts` | 内部修复 | 在 `tasksFromHandoff` 中显式把 `asset_grounded.write` 与 `experience.match_against_jd` 划入 read-only 分支（与 `general.chat` / `clarify` 同档），不创建 `currentTask`，避免历史卡片出现"幻象任务"。其余 intent 行为完全保持。 |
| 5 | `src/agent-core/prompts/prompts/frontdesk.md` | prompt 修订 | 路由规则区分 JD match / 资产写作；新增"Asset-grounded writing (Phase 1)"小节；Handoff Contract 段补齐 13 个合法 intent 与新可选字段说明（修复 Phase 0 漂移）；新增 Example 8 / 9 / 10 三个写作示例（self_intro / project_intro / JD-anchored self_intro）。 |
| 6 | `tests/frontDeskRoutingPhase1.test.ts` | 新增测试 | 34 个用例，覆盖 schema、normalizer、prompt、task reducer 的一致性。 |

### 2. 本阶段修复的误路由根因

Phase 0 审查中识别的 4 处主因，本阶段全部处理：

1. **`FrontDeskIntentSchema` 不接受写作意图** → 已 additive 加入 `asset_grounded.write` 与 `experience.match_against_jd`（后者修复 prompt-vs-schema 漂移）。
2. **`HandoffNormalizer.inferFallback` 无脑 fallback 到 `general.chat`** → 在 zod 校验通过后保留模型 handoff；启发式 fallback 把"写作类"提升到第一优先级，并强制 `next: "execute_task"` + `routeTo: "architect"`。
3. **`HandoffNormalizer.classifyMessage` 偏 JD/简历** → 写作检测必须同时命中"writing verb + asset scope"；`general.chat` 兜底分支只保留没有任何 asset 关键词的纯闲聊。
4. **`frontdesk.md` 路由表过窄** → 增加资产写作路由规则 + 三个示例；同时在 Handoff Contract 段把所有合法 intent 显式写出，下次模型如再写出 schema 外字符串将立即被 zod 拒绝（不再静默 fallback）。

### 3. 新增 / 调整的 intent 说明

只新增了 **1 个**顶层 intent：`asset_grounded.write`。

具体写作 flavor（self_intro / interview_answer / cover_letter / profile_summary / project_intro / application_answer / pitch / custom）全部放在 handoff 的内部可选字段里：

- `outputType: string`（开放枚举：所有字符串都被 schema 接受，`AssetGroundedOutputTypeSchema` 给出 well-known 集；Phase 2+ 工具应把未识别值视作 `"custom"`）。
- `goal: string`（短标签，通常等于 `outputType`，Phase 2+ 可用作生成指令的高层目标）。
- `constraints?: { length?, language?, tone?, audience?, format? }`。
- `extracted.experienceIds?: string[]` / `extracted.experienceQuery?: string`（关键词若已能解析为 canonical id 用前者，否则放后者交给 Phase 3 specialist 解析）。

另外把 Phase 0 发现的 prompt-vs-schema 漂移项 `experience.match_against_jd` 一并入 schema —— **这不是新功能**，对应的 specialist 工具 `match_experiences_against_jd` 早已存在于 `ExperienceReceiverAgent.allowedTools`，本阶段只是让 prompt 与 schema 重新一致。

### 4. prompt / schema / normalizer / task reducer 一致性

| 维度 | schema 是否接受 | normalizer 默认 routeTo | task reducer 行为 | prompt 是否记录 |
|-----|----------------|------------------------|-----------------|----------------|
| `jd.intake` / `jd.save` / `jd.analyze` | ✅ | strategist | 保持原 JD_INTAKE 链路 | ✅ |
| `resume.generate_from_jd` | ✅ | architect | 保持 RESUME_GENERATE_FROM_JD task | ✅ |
| `experience.intake` / `.save` | ✅ | experience_receiver | 保持 EXPERIENCE_REWRITE task | ✅ |
| `experience.rewrite` | ✅ | experience_receiver | EXPERIENCE_REWRITE | ✅ |
| `experience.match_against_jd`（**Phase 1 加入 schema**） | ✅ | experience_receiver | 不创建 task（read-only） | ✅ |
| `asset_grounded.write`（**Phase 1 新增**） | ✅ | architect | 不创建 task（read-only） | ✅ |
| `resume.optimize_item` / `resume.export` | ✅ | architect | — | ✅ |
| `general.chat` / `clarify` | ✅ | frontdesk | suggestedTasks 透传 | ✅ |

Phase 1 测试套件中的 `frontdesk.md prompt-vs-schema alignment` 把 "prompt 中提到的所有 intent 必须被 `FrontDeskIntentSchema` 接受" 作为 invariant 锁定 —— 未来再次出现漂移会立即 CI 失败。

### 5. 新增测试与回归测试结果

新增测试文件：`tests/frontDeskRoutingPhase1.test.ts`，34 个用例分为 7 组：

1. **FrontDeskIntentSchema additive enums**（5）—— 验证 `asset_grounded.write` / `experience.match_against_jd` 被接受、未知 intent 仍被拒绝、可选字段不影响旧 handoff。
2. **HandoffNormalizer routes asset-grounded writing**（10）—— 覆盖任务要求列举的 7 类写作输入，加 3 条负面用例：`改写这条经历` / `优化这条经历` / `帮我写个段子` 必须保持原有路由。
3. **JD match-against-experiences routing (Phase 0 drift fix)**（3）—— 含一条 JD scope 缺失的负面用例。
4. **Existing fixed pipelines stay intact**（5）—— `基于 JD 生成简历` / `那就生成吧` / 纯 JD intake / 短问候 / `优化这条经历` 全部保持原状。
5. **Raw model handoff defaults align with schema**（3）—— 验证 `defaultRouteForIntent` + `outputType` 的开放语义。
6. **TaskStateReducer keeps writing & match intents task-less**（4）—— 验证 read-only 分支与 RESUME_GENERATE_FROM_JD / EXPERIENCE_REWRITE task 行为分离。
7. **frontdesk.md prompt-vs-schema alignment**（4）—— 直接读取 prompt 文件并断言 13 个合法 intent 全部被 schema 接受、`outputType` / `constraints` 均被记录。

回归命令与结果：

```text
$ npm run typecheck
> tsc --noEmit
（无错误）

$ npm test
Test Files  90 passed (90)
     Tests  796 passed (796)
  Duration  12.73s
```

对比 Phase 0 baseline（89 文件 / 762 用例），本阶段净增 1 个测试文件 + 34 个测试用例；既有 762 个测试 0 失败、0 跳过、0 漂移。

### 6. 是否影响现有十阶段主链路

**不影响。** 已逐项核查：

- **JD 分析（jd.analyze）**：路由 + tool plan 均未改动，`tests/jdMatchOrchestration.test.ts`、`tests/copilotKernelRefactor.test.ts` 等回归测试全部通过。
- **JD 匹配（experience.match_against_jd）**：现在被 schema 正式接受（之前是 prompt 自由文本，会被 zod 打回 `general.chat`）；specialist 仍是 `experience_receiver`，工具仍是已注册的 `match_experiences_against_jd`，行为无变化。
- **简历生成（resume.generate_from_jd）**：不受影响。新增的写作检测**先于** `wantsGenerate` 启发式，但严格要求 "writing verb + asset scope + 非 rewrite 关键字"；`基于这个 JD 生成简历` / `那就生成吧` 都没有写作 verb，因此仍走 `resume.generate_from_jd`（对应回归测试通过）。
- **接受变体 / 一页 PDF 导出 / 质量报告 / Critic / RAG / Self-evolution**：源码未触及，相关测试（`generateResumePendingFlow.test.ts` / `exportPipeline.test.ts` / `pdfExportPipeline.test.ts` / `resumeQualityCriticPipeline.test.ts` / `EvidenceRAGFinal.test.ts` / `PreferenceBankService.test.ts` 等）全部通过。
- **NarratorService**：`asset_grounded.write` 流程目前不会触发 Narrator 分支（Phase 2+ 工具尚未实现），现有 narrator 行为完全不变。

### 7. 是否影响现有对外 API 与 contract

**不影响外部接口。** 详细映射：

| 维度 | 是否变化 | 说明 |
|-----|---------|------|
| REST 路径 / 方法 | ❌ 无变化 | `/copilot/chat`、`/copilot/actions`、`/copilot/pending-actions`、`/product/*`、`/exports/*`、`/jobs/*` 全部保持现状 |
| `CopilotChatRequest` 主结构 | ❌ 无变化 | 用户仍只通过 `message` + `clientState` 表达需求；前端**不需要传**任何新字段 |
| `CopilotChatResponse` 主结构 | ❌ 无变化 | `assistantMessage` / `workspace` / `nextActions` / `suggestedPrompts` / `agentRoomEvents` / `raw` 全部保持原语义 |
| `displaySnapshot` / `productBlocks` / `pendingActions` / `actionResults` | ❌ 无变化 | 没有新增、没有重命名、没有改语义 |
| `ToolResult` 顶层字段 | ❌ 无变化 | Phase 1 不接入工具，无新 `resultKind` 出现 |
| `SpecialInfoKind` 枚举 | ❌ 无变化 | 仍为现有 14 个值；写作能力是否需要独立 kind 留待 Phase 5 评估 |

### 8. additive 字段与内部契约变化（供前端识别）

以下变化是**后端内部契约**，会出现在 `agentRoomEvents` 透传的 handoff payload 与 `workspace.handoffs[]` 历史里。前端**不消费这些字段时旧体验完全不受影响**；如希望未来对接资产写作能力，可按以下清单识别：

#### A. `FrontDeskHandoff` 新增可选字段

```ts
// Phase 1 新增（所有字段均 optional + additive）
type FrontDeskHandoff = {
  // ...原有字段保持不变...
  goal?: string;                  // 短目标标签，写作场景下通常等于 outputType
  outputType?: string;            // 开放枚举：self_intro | interview_answer |
                                  //   cover_letter | profile_summary |
                                  //   project_intro | application_answer |
                                  //   pitch | custom | <未来扩展>
  constraints?: {
    length?: "short" | "medium" | "long";
    language?: "zh" | "en" | "auto";
    tone?: string;
    audience?: string;
    format?: "paragraph" | "bullets" | "script" | "email" | "answer";
  };
  extracted: {
    // ...原有字段保持不变...
    experienceIds?: string[];     // 用户明确指向的多条经历（已是 canonical id）
    experienceQuery?: string;     // 自然语言关键词（如 "WEEX"），尚未解析为 id
  };
};
```

#### B. `FrontDeskIntent` 联合类型扩枚举

```ts
type FrontDeskIntent =
  | "jd.intake" | "jd.save" | "jd.analyze"
  | "resume.generate_from_jd"
  | "experience.intake" | "experience.save" | "experience.rewrite"
  | "experience.match_against_jd"   // 新增（Phase 0 漂移修复）
  | "asset_grounded.write"          // 新增（Phase 1 唯一新顶层 intent）
  | "resume.optimize_item" | "resume.export"
  | "general.chat" | "clarify";
```

#### C. `FrontDeskSuggestedAction` 联合类型扩枚举

```ts
type FrontDeskSuggestedAction =
  // ...原有 8 个保持不变...
  | "compose_career_text";          // 新增（Phase 1，配合 Phase 2 工具落地）
```

#### D. 前端识别建议

- 写作场景判定：`workspace.handoffs[].intent === "asset_grounded.write"`。
- 写作 flavor 判定：`workspace.handoffs[].outputType`（开放字符串，未识别值视作 `custom`）。
- Phase 2 完成后，`agentRoomEvents` 中将出现 `relatedToolName === "compose_career_text"` 与 `ToolResult.resultKind === "asset_grounded_text_completed"`（仍是 additive，前端按未知值降级即可）。

### 9. 风险与对 Phase 2 的输入

- ✅ schema / normalizer / prompt / task reducer 已 100% 一致，Phase 2 可以放心读取 handoff 的 `outputType` / `constraints` / `experienceQuery` 而不必担心字段缺失。
- ⚠️ `asset_grounded.write` 默认 routeTo 为 `architect`，但 `ArchitectAgent.allowedTools` 当前**还没有** `compose_career_text`。Phase 2 必须先注册工具，Phase 3 再把工具加入 allowedTools。在 Phase 2 完成前，模型若被路由到 architect 且选择写作路径，会落到 "无可选 read-only 写作工具" 的窘境 —— 当前由 Architect 在 prompt 层兜底为 `ask_clarification` / `final`，不会破坏现有链路（已通过启动 architect 决策的相关回归测试验证）。
- ⚠️ `experienceQuery` 在 Phase 1 仅做关键词提取（不解析），Phase 3 specialist 需调用 `AssetMentionResolver` 把它解析为 canonical experienceId 才能使用。`IdGuards` 已经禁止把自然语言当 canonical id，因此即使忘了解析也只会触发 ask_clarification，不会污染数据。
- ⚠️ Phase 1 写作启发式严格要求 "writing verb + asset scope"，会少量牺牲召回（例如 "把这段经历说得好一点" 这类极度模糊的句式可能仍兜到 `experience.intake`）。Phase 2 工具落地后可以通过 LLM 模型自身的语义判断进一步纠偏，本阶段优先保证不误伤十阶段链路。

---

### Phase 2：新增通用资产 grounded 文本工具

目标：
新增一个高内聚工具 compose_career_text / generate_asset_grounded_text。

要求：

* 只读
* 读取经历 / 简历 / JD / RAG / PreferenceBank
* 生成文字
* 输出 usedExperienceIds / groundingNotes / riskNotes
* 不触发 variants / accept / export

修改：

* src/agent-tools/writing/*
* src/agent-tools/index.ts
* 相关 tool types/tests
* PromptRegistry 中必要 prompt

---

## Phase 2 完成情况报告（compose_career_text 工具落地）

> 已完成。新增 1 个高内聚 read-only 写作工具 `compose_career_text`，注册进 `careerDomain.tools` 但**未**加入任何 Specialist 的 `allowedTools`（Phase 3 才开放）。未新增 REST API、未新增 Agent、未新增 SpecialInfo kind、未引入新 ToolResult 顶层字段。`npm run typecheck` 与 `npm test` 均通过（91 / 91 test files，810 / 810 tests）。

### 1. 修改文件清单

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/agent-tools/writing/composeCareerText.tool.ts` | 新增 | 工具主实现：scope 解析、PreferenceBank/Evidence RAG 接入、LLM 调用、结构化 ToolResult 构造、id 校验、需要输入分支。约 580 行（含注释与确定性测试 fallback）。 |
| 2 | `src/agent-tools/writing/index.ts` | 新增 | 写作工具桶（`createWritingAgentTools()`），方便后续新增 read-only 写作工具时统一聚合。 |
| 3 | `src/agent-domains/career/index.ts` | additive | 在 `careerDomain.tools` 末尾追加 `...createWritingAgentTools()`，使工具进入 `ToolRegistry`，但 Phase 2 不修改任何 Agent 的 `allowedTools`。 |
| 4 | `src/agent-core/validation/ToolInputSchemas.ts` | additive | 新增 `ComposeCareerTextInputSchema`（zod，所有字段 optional），保持与 `FrontDeskHandoff.outputType / constraints / extracted.experienceIds / extracted.experienceQuery` 一致的内部契约。 |
| 5 | `src/agent-core/prompts/PromptRegistry.ts` | additive | 在 `PRODUCT_PROMPT_FILES` 中注册 `tools.writing.composeCareerText.system`。 |
| 6 | `src/agent-core/prompts/prompts/tools/writing/compose-career-text-system.md` | 新增 | 工具 system prompt：硬规则（不得编造事实）、grounding 信号说明、JSON 输出契约。 |
| 7 | `tests/composeCareerTextPhase2.test.ts` | 新增 | 14 个工具级测试，覆盖注册、边界、三种 grounding 模式、id 校验、PreferenceBank 边界、ToolResult 契约。 |

### 2. 新增工具名称与职责

工具名：**`compose_career_text`**

职责：基于用户真实资产（experiences / active resume / JD / Evidence RAG / PreferenceBank）生成一段求职相关文本。**严格只读**：

- 不写数据库（不调用 save / update / delete / accept / export 任何写入工具）。
- 不创建 `pendingAction`，不进入 `requiresConfirmation` 流程。
- 不写 `workspacePatch`（`activePanel` / `variants` / `productGenerationId` 等十阶段关键字段一律不动）。
- 不调用 `match_experiences_against_jd` / `generate_resume_from_jd`，也不返回 match matrix / resume variants。
- ownerAgent 设为 `"architect"`（与 FrontDesk Phase 1 默认路由一致），但 Phase 2 **未**加入 ArchitectAgent.allowedTools；Phase 3 才会开放调用。

ToolDefinition 关键字段：
| 字段 | 取值 |
|-----|-----|
| `mutability` | `"read"` |
| `requiresConfirmation` | `false` |
| `riskLevel` | `"low"` |
| `ownerAgent` | `"architect"` |

### 3. 工具输入 / 输出 contract

**输入**（zod `ComposeCareerTextInputSchema`，所有字段 optional + additive）：

```ts
{
  goal?: string;                   // 高层目标标签（写作场景下通常等于 outputType）
  userInstruction?: string;        // 用户原话；缺省时回退到 context.userMessage
  outputType?: string;             // 开放枚举：self_intro | interview_answer |
                                   //   cover_letter | profile_summary |
                                   //   project_intro | application_answer |
                                   //   pitch | custom | <未来扩展>
  assetScope?: {
    experienceIds?: string[];      // 仅接受 canonical id（pexp-uuid 格式）
    resumeId?: string;             // 仅接受 canonical id（pres-uuid）
    jdId?: string;                 // 仅接受 canonical id（pjd-uuid）
  };
  experienceQuery?: string;        // 自然语言关键词（如 "WEEX"），由工具用 AssetMentionResolver 解析
  jdText?: string;                 // 直接粘贴的 JD 文本，可与 jdId 二选一
  constraints?: {
    length?: "short" | "medium" | "long";
    language?: "zh" | "en" | "auto";
    tone?: string;
    audience?: string;
    format?: "paragraph" | "bullets" | "script" | "email" | "answer";
  };
}
```

**输出**（嵌入在 `ToolResult.data`，字段全部存在；空数组而非 omit）：

```ts
{
  title: string;
  outputType: string;              // 实际使用的 flavor（未识别值会被规范成 "custom"）
  content: string;                 // 主体文本；needs_input 时为 ""
  alternatives: Array<{            // 可选替代版本（如英文版 / 短版）
    title: string;
    content: string;
    scenario?: string;
  }>;
  usedExperienceIds: string[];     // 仅保留 canonical 且确实在 scope 中的 id
  usedResumeIds: string[];
  usedJDIds: string[];
  usedEvidenceIds: string[];       // 引用的 EvidencePack claim 来源
  groundingNotes: string[];        // 文本→事实来源的可审计说明
  riskNotes: string[];             // 不足、未引用、保守表达提示
  suggestions: string[];           // 推荐的下一步 follow-up
  composeMethod: "llm" |
    "deterministic_test_fallback" |
    "needs_input" |
    "llm_failed" |
    "llm_not_configured";
  personalizationApplied: number;  // PreferenceBank 实际应用条数（0 = 未启用）
  evidencePackUsed: boolean;       // Evidence RAG 是否被调用过
}
```

**id 校验保证**（写在工具内部，无法通过 LLM 越权）：

- `assetScope.experienceIds` 中的非 `pexp-uuid` 字符串会被 `isCanonicalExperienceId` 直接丢弃。
- `usedExperienceIds` 输出严格被 `validExperienceIds` 集合裁剪 —— LLM 即使幻觉返回伪 id 也会被过滤。
- 同理 `usedJDIds` / `usedResumeIds` / `usedEvidenceIds`。

### 4. ToolResult 结构化字段说明（Phase 1 additive 字段，未新增任何顶层 key）

| 字段 | Phase 2 取值 |
|-----|-------------|
| `status` | `"success"` / `"needs_input"` / `"failed"` |
| `resultKind` | **`"asset_grounded_text_completed"`**（新增取值，非新字段）/ **`"asset_grounded_text_needs_input"`**（新增取值） |
| `summaryFacts` | 简短事实陈述：`Drafted a self_intro grounded on N experience(s).` / `Anchored to JD pjd-…` / `Cited K evidence claim(s).` / `Compose method: llm.` |
| `entities` | `writing_result`（包含 `outputType` / `contentPreview` / `usedExperienceIds` / `composeMethod` 等元数据） + 每条被引用的 `experience` + 可选 `jd` / `resume` |
| `evidence` | 每个 `usedExperienceIds` 一条 `{ sourceId, claim: outputType, support: experience content snippet }` |
| `warnings` | 例：`No experience ids were cited` / `Deterministic test fallback was used` / `Evidence RAG was not consulted` |
| `nextActionHints` | 至少包含 `compose_career_text_variant`（"生成更短/更长/英文版"），以及在已引用经历时追加 `open_experience` |
| `pendingActionId` | **永远未定义**（Phase 2 边界） |
| `workspacePatch` | **永远未定义**（Phase 2 边界） |

新增的 `resultKind` 取值是 additive：前端在 Phase 1 时已知 `resultKind` 字段是开放枚举 string，未消费这两个新值时直接走默认渲染分支，不会破坏旧体验。

### 5. RAG / PreferenceBank 接入与边界

#### A. EvidenceRAGService（事实底座）

- **接入条件**：当且仅当 `scope.jdText` 长度 ≥ 40 字符时才调用 `buildEvidencePack`，避免短输入触发不必要的检索成本。
- **使用方式**：把 `evidencePack.allowedClaims`（top 12）作为「pre-vetted claims」section 注入 prompt，并在 system prompt 中要求模型「prefer claims from this pack」。
- **边界**：调用失败一律 `try/catch` 静默忽略 → `evidencePackUsed=false`，`warnings` 中追加 `Evidence RAG was not consulted`，仍可继续生成（可能略显泛化）。

#### B. GuidelineRAGService

- **未在 Phase 2 接入**。Phase 4 会评估为 `tone/audience/format` 提供 `InstructionPack` 引导。Phase 2 优先把 EvidenceRAG / PreferenceBank 的接入打通；Guideline RAG 当前依赖 JD requirement parsing 的副产品，未在 read-only 写作工具中直接消费。

#### C. PreferenceBankService（仅风格）

- **接入条件**：始终尝试调用 `buildPersonalizationPack({ userId, context: { language? }, limit: 10 })`。
- **使用方式**：`stablePreferences` / `contextualPreferences` / `negativePreferences` 拼成 prompt 中**位于 `# Style preferences` 段**的列表（位置在 `# Experiences` 之后）。
- **硬边界**（在 system prompt 中明确，并在测试中断言）：
  > "PreferenceBank items influence ONLY tone, voice, length, structure, and language — they are NEVER a source of factual claims."
- 如果 `personalization.diagnostics.appliedCount > 0`，工具在确定性 fallback 路径中也会写入 `riskNotes` 提醒 "PreferenceBank 仅用于风格/口吻，未作为事实来源"。

#### D. UserAssetContext / AssetMentionResolver

- 工具在解析 `experienceQuery` 时通过现有 `AssetMentionResolver.matchExperience` 走「unique → canonical id」路径；多候选时**不猜**，让上层走 `experience_not_resolved` 的 needs_input。
- `userAssetContext.active.experienceId` / `active.jdId` / `active.resumeId` 仅当通过 `IdGuards` 校验为 canonical id 时才被使用。

### 6. 是否使用真实 LLM；fallback 策略

是。工具默认通过 `context.kernel.frontDeskModelClient` 调用真实 LLM（`responseFormat: "json"`，`temperature: 0.4`，`maxTokens: 2048`）。

| 场景 | 行为 |
|-----|-----|
| LLM 正常返回有效 JSON | `composeMethod: "llm"`，进入 `normalizeLLMOutput` 做 id 集合校验 |
| LLM 抛错且 `NODE_ENV=test` | 走 `composeDeterministic`（确定性占位草稿，仅供测试）；`composeMethod: "deterministic_test_fallback"`，`warnings` 追加显式提醒 |
| LLM 抛错且非测试环境 | 返回 `failed` + `composeMethod: "llm_failed"`，前端可见错误消息 |
| `frontDeskModelClient` 未配置且 `NODE_ENV=test` | 同上 deterministic fallback |
| `frontDeskModelClient` 未配置且非测试 | 返回 `needs_input` + `actionResult.reason: "model_not_available"`，与 `llmNotAvailableResult` 风格一致 |

确定性 fallback **仅在 `NODE_ENV=test` 下启用**（沿用 `isDeterministicFallbackAllowed`），生产 / 开发环境绝不静默退化。

### 7. 是否影响现有十阶段主链路

**不影响。** 已逐项核查：

- **JD 分析 / JD 匹配 / 简历生成 / accept variant / export resume / quality critic / RAG / self-evolution**：源码完全未触及；现有 `match_experiences_against_jd` / `generate_resume_from_jd` / `accept_generation_variant` / `export_resume` 调用路径不变。`compose_career_text` 在 Phase 2 不进入任何 Specialist `allowedTools`，Orchestrator 即使路由到 architect / experience_receiver 也无法 plan 这个工具，因此既有 762 + 34 = 796 个测试 0 失败 0 漂移。
- **`AgentOrchestrator.maybeAugmentResumeGenerationPlan`**（`src/agent-core/runtime/AgentOrchestrator.ts`）只在工具是 `generate_resume_from_jd` 时触发，对 `compose_career_text` 完全惰性。
- **`ReviewPolicy` / `CriticGate`**：本工具是 read-only + low risk，按现有策略不会触发强制 critic 审查；如未来某轮 LLM 输出含明显风险，仍由调用方决定是否再要 critic。

### 8. 是否影响现有对外 API 与 contract

**不影响外部接口。**

| 维度 | 是否变化 | 说明 |
|-----|---------|------|
| REST 路径 / 方法 | ❌ 无变化 | `/copilot/chat`、`/copilot/actions`、`/copilot/pending-actions`、`/product/*`、`/exports/*`、`/jobs/*` 全部保持现状 |
| `CopilotChatRequest` 主结构 | ❌ 无变化 | 用户仍只通过 `message` + `clientState` 表达需求 |
| `CopilotChatResponse` 主结构 | ❌ 无变化 | `assistantMessage` / `workspace` / `nextActions` / `agentRoomEvents` / `raw` 全部保持原语义 |
| `displaySnapshot` / `productBlocks` / `pendingActions` / `actionResults` | ❌ 无变化 | 没有新增、没有重命名、没有改语义 |
| `ToolResult` 顶层字段 | ❌ 无变化 | Phase 2 仅给已有字段贡献新取值，未引入任何新顶层 key |
| `SpecialInfoKind` 枚举 | ❌ 无变化 | 仍为现有 14 个值 |
| `FrontDeskHandoff` 字段 | ❌ 无变化 | Phase 1 已加入的 additive 字段（`outputType` / `constraints` / `experienceQuery`）继续生效 |

### 9. additive 字段与新 resultKind（供前端识别）

> 全部 additive。前端**不消费时旧体验完全不受影响**。

#### A. `ToolResult.resultKind` 新增取值

```ts
// 现有 resultKind 字段（Phase 1 起已存在，类型为开放 string）
type ToolResultKind =
  | "match_completed" | "match_empty" | "generation_completed"
  | "variant_accepted" | "export_pending" | "export_ready" | ...
  | "asset_grounded_text_completed"      // 新增（Phase 2）
  | "asset_grounded_text_needs_input";   // 新增（Phase 2）
```

#### B. `ToolResult.entities[].type` 新增取值

```ts
type ToolResultEntityType =
  | "experience" | "jd" | "resume" | "generation" | "variant" | "export"
  | "writing_result";   // 新增（Phase 2，写作草稿元数据）
```

`entities[type=writing_result]` 的 `data` 包含：`outputType`、`contentPreview`（≤240 chars）、`alternativesCount`、`usedExperienceIds[]`、`usedResumeIds[]`、`usedJDIds[]`、`usedEvidenceIds[]`、`composeMethod`。

#### C. `ToolResult.nextActionHints[].type` 新增取值

```ts
| "compose_career_text_variant"   // "生成更短/更长/英文版" 入口
| "open_experience"               // 跳转到引用的经历
```

#### D. 前端识别建议（Phase 6 完成后）

1. 命中 `toolResults[i].resultKind === "asset_grounded_text_completed"` → 渲染写作草稿卡片，主体文字读 `data.content`，可选展示 `data.alternatives` / `data.usedExperienceIds` 链接。
2. 命中 `resultKind === "asset_grounded_text_needs_input"` → 渲染 "缺资产" 提示，按 `data.suggestions` 引导用户补充。
3. `actionResult.actionType === "compose_career_text"` 是稳定的工具回执标识。
4. 不识别新 `resultKind` 的旧前端会落到默认 `result.message` 渲染（≤140 字摘要），仍然可用。

### 10. 测试结果

```text
$ npm run typecheck
> tsc --noEmit
（无错误）

$ npm test
Test Files  91 passed (91)
     Tests  810 passed (810)
```

新增测试文件：`tests/composeCareerTextPhase2.test.ts`，14 个用例，分为 7 组：

1. **工具注册**（4）—— `createAgentTools()` 暴露；`mutability/riskLevel/requiresConfirmation/ownerAgent` 正确；**确认 `compose_career_text` 不在 ArchitectAgent / ExperienceReceiverAgent 的 `allowedTools`**（Phase 2 边界守卫）。
2. **needs_input 路径**（3）—— 无任何资产时返回 `no_assets`；`experienceQuery` 找不到时返回 `experience_not_resolved`；`assetScope.experienceIds` 内是自然语言 keyword 时仍返回 `experience_not_resolved`，永远不让 LLM 凭空写。
3. **experience-grounded mode**（2）—— stub LLM 测试断言 `usedExperienceIds` 来自真实 canonical id；不返回 `variants` / `productGenerationId` / `pendingActionId`；deterministic fallback 在 `NODE_ENV=test` 且无 LLM 时正确触发。
4. **single-experience mode**（1）—— `experienceQuery="WEEX"` 经 `AssetMentionResolver` 解析为真实 id 并使用。
5. **JD-grounded mode**（1）—— `jdText` 输入不会触发 `match_experiences_against_jd` / `generate_resume_from_jd`，输出 JSON 中 grep 不到 `matchResults` / `variants` 关键字。
6. **id 校验**（1）—— LLM 即使返回伪 `pexp-…` id 或 `weex` 字符串，也会被 `validExperienceIds` Set 严格过滤掉；`usedJDIds` / `usedResumeIds` 同样裁剪到 scope 内。
7. **PreferenceBank 边界**（1）—— prompt 中 `# Style preferences` 段位于 `# Experiences` 段之后；system prompt 显式包含 "PreferenceBank … NEVER a source of factual claims"。
8. **ToolResult contract**（1）—— 顶层 keys 严格在 Phase 1 允许的集合内（无新增），`summaryFacts` / `entities` / `evidence` / `nextActionHints` 全部存在；`entities` 中至少有一个 `type=writing_result` 与一个 `type=experience`；`nextActionHints[0].type === "compose_career_text_variant"`。

回归对比（增量）：

| 阶段 | Test Files | Tests |
|------|-----------|-------|
| Phase 0 baseline | 89 | 762 |
| Phase 1 完成 | 90 (+1) | 796 (+34) |
| **Phase 2 完成** | **91 (+1)** | **810 (+14)** |

既有 796 个测试 0 失败、0 跳过、0 漂移。

### 11. Phase 3 注意事项 —— 何时把 `compose_career_text` 加入 allowedTools

Phase 3 应做且仅做以下事情：

1. **ArchitectAgent.allowedTools** 追加 `"compose_career_text"`（主路径）。
2. **ExperienceReceiverAgent.allowedTools** 追加 `"compose_career_text"`（仅当 handoff 明确围绕单条经历时由 prompt 引导）。
3. **architect.md / experience-receiver.md** 增加 prompt 分支：
   - 当 handoff `intent === "asset_grounded.write"` 时，**仅允许** `compose_career_text` + 必要的只读读取工具（`get_experience` / `list_experiences` / `get_resume` / `get_jd`）。
   - **显式禁止**：`generate_resume_from_jd` / `match_experiences_against_jd` / `accept_generation_variant` / `export_resume` / 所有 `save_*` / `update_*` / `delete_*`。
   - 工具调用顺序建议：先尝试解析 `experienceQuery` → 必要时 `get_experience` 拉取详情 → 再调 `compose_career_text`。
4. **回归测试**：扩展 `tests/composeCareerTextPhase2.test.ts` 或新增 `tests/architectAssetGroundedRoutingPhase3.test.ts`，断言：
   - "根据我的经历写自我介绍" → architect plan 第一步是 `compose_career_text`，**不**包含 `generate_resume_from_jd`。
   - "根据这份 JD 写自我介绍" → architect plan **不**包含 `match_experiences_against_jd`。
   - 现有 "基于 JD 生成简历" / "导出简历" / "接受这个版本" 路径继续 plan 出 `generate_resume_from_jd` / `export_resume` / `accept_generation_variant`。

风险提示：

- ⚠️ **maybeAugmentResumeGenerationPlan 兼容性**：augment 仅作用于 `generate_resume_from_jd`，对 `compose_career_text` 惰性。Phase 3 不需要改动 Orchestrator 的 augment 逻辑。
- ⚠️ **前端 productBlock 兼容**：Phase 2 工具不写 `workspacePatch`，因此 architect 路径的 `pendingActions` / `productBlocks` / `displaySnapshot` 行为完全保留。Phase 3 prompt 改动后，理论上仍只是新增 `agentRoomEvents` 中的 `tool_result(compose_career_text)` 事件 —— 前端旧版渲染依旧降级为通用消息。
- ⚠️ **Critic 行为**：本工具是 read-only / low risk，目前 `ReviewPolicy` 不会自动触发强制 critic。Phase 3 如发现 LLM 输出仍出现幻觉，可在 architect prompt 中显式建议跑一次 `critic` 二次校验，但这不是硬性要求。

### 12. 风险与待跟进项

- ⚠️ **Guideline RAG 未接入**：Phase 2 暂时只接 EvidenceRAG + PreferenceBank。Phase 4 需评估是否额外把 `GuidelineRAGService` 的 `InstructionPack` 注入 prompt（影响 tone / structure，不影响事实）。
- ⚠️ **Evidence RAG 触发条件**：当前仅在 `jdText.length ≥ 40` 时才调用 `buildEvidencePack`。Phase 4 可优化为「显式指定 JD 或经历时也按需调用」，避免在 experience-grounded mode 错过 claim 级别的事实底座。
- ⚠️ **PromptRegistry 测试覆盖**：当前未单独为 `tools.writing.composeCareerText.system` 写 PromptRegistry 加载测试。Phase 5 / Phase 6 LLM probe 时如发现 prompt 漂移再补。
- ⚠️ **真实 LLM 验证**：Phase 6 需要跑一次真实 LLM probe 验证 `usedExperienceIds` 真的能被模型正确填充，并且 deterministic fallback 不会在生产环境意外启用。
- ⚠️ **Narrator 融合**：Phase 5 / Phase 6 阶段，可让 `NarratorService` 把 `asset_grounded_text_completed` 的 ToolResult 转换成更自然的 assistant 文本。Phase 2 已通过 `result.message` 提供了 ≤140 字的草稿摘要作为兜底。

---

### Phase 3：开放现有 Agent 工具能力

目标：
不新增上层任务层，不优先新增 Agent。
让现有 Specialist 能更自然调用新工具。

修改：

* ArchitectAgent allowedTools
* ExperienceReceiverAgent allowedTools，如适合
* architect.md / experience-receiver.md
* tool policy / confirmation 相关测试

要求：

* asset grounded writing 只能调用只读工具 + compose_career_text。
* 不得误调用 generate_resume_from_jd / match_experiences_against_jd / accept / export。

---

## Phase 3 完成情况报告（开放 compose_career_text 给 Specialist）

> 已完成。仅扩展 `ArchitectAgent` / `ExperienceReceiverAgent` 的 `allowedTools` 与对应 prompt；未新增 Agent、未新增 Task Layer、未新增 REST API、未新增 SpecialInfo kind、未引入新 ToolResult 顶层字段、未改动前端契约。`npm run typecheck` 与 `npm test` 均通过（92 / 92 test files，829 / 829 tests）。

### 1. 修改文件清单

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/agent-core/agents/ArchitectAgent.ts` | additive | `allowedTools` 追加 `compose_career_text`、`list_jds`、`get_jd`、`list_experiences`、`get_experience`，让 architect 在 `asset_grounded.write` 分支既能写作，也能用最少的只读读取做 grounding。原有 9 个简历/JD 相关工具完全保留。 |
| 2 | `src/agent-core/agents/ExperienceReceiverAgent.ts` | additive | `allowedTools` 追加 `compose_career_text`，用于单条经历写作（项目介绍 / 面试口述版本 / pitch）。原有 17 个经历库读写 + JD 匹配工具保持不变。 |
| 3 | `src/agent-core/prompts/prompts/architect.md` | prompt 修订 | 顶部 Allowed tools 列表更新；新增 Asset-grounded writing branch (Phase 3) 小节：触发条件、参数从 handoff 的 `goal` / `outputType` / `constraints` / `extracted.experienceIds` / `extracted.experienceQuery` / `extracted.jdText` / `extracted.jdId` / `extracted.resumeId` 推导、严禁调用清单、natural-language 不能当 canonical id；新增 Example 6/7/8/9（self_intro、project_intro、JD-anchored self_intro、profile_summary）。 |
| 4 | `src/agent-core/prompts/prompts/experience-receiver.md` | prompt 修订 | 顶部 Allowed tools 列表更新；Tool Selection Rules 增加 `compose_career_text` 仅用于 read-only 写作的说明；新增 Asset-grounded writing branch (Phase 3) 小节，明确 rewrite/save vs compose vs intake 三类相邻意图的分流；新增 WEEX 项目介绍调用示例。 |
| 5 | `tests/composeCareerTextPhase2.test.ts` | 测试更新 | 之前两条断言 compose_career_text 不在 allowedTools 的 Phase 2 边界守卫，本阶段反转为现已加入 ArchitectAgent / ExperienceReceiverAgent allowedTools，并保留 Phase 2 已有的 12 条工具级别合同断言。 |
| 6 | `tests/agentAssetGroundedRoutingPhase3.test.ts` | 新增测试 | 19 个用例，6 组：A) allowedTools 开放与回归；B) Architect 在 asset_grounded.write 下规划 compose_career_text；C) ExperienceReceiver 单条经历写作；D) 固定链路回归；E) Architect plan → ToolExecutor 真实执行 compose_career_text 并校验 ToolResult 契约；F) prompt 文件与 allowedTools 对齐。 |

### 2. `compose_career_text` 加入哪些 Agent 的 `allowedTools`，以及为什么

| Agent | 是否加入 | 原因 |
|------|--------|------|
| `ArchitectAgent` | 是 | Phase 1 把 `asset_grounded.write` 的默认 `routeTo` 设为 `architect`，且 architect 已经持有 JD/简历相关只读读取工具。把写作工具放在这里最自然，符合最小优雅方案。这是写作意图的**主路径**。 |
| `ExperienceReceiverAgent` | 是 | 用户经常围绕**单条经历**说 `根据 WEEX 写一段面试介绍 / 把这条经历改成口述版本`。这类请求 FrontDesk 路由到 `experience_receiver` 更贴近资产语义；该 Agent 又必然 own 经历库读取工具（`list_experiences` / `match_experience` / `search_experiences` / `get_experience`），直接打通 `先取经历，再围绕它写作`。Prompt 中明确**只用于 read-only 写作**，不替代 `experience.rewrite` / `update_experience` / `save_experience_from_text` 链路。 |
| `StrategistAgent` | 否 | Strategist 仍专注 JD 分析。写作不是它的职责。 |
| `CriticAgent` | 否 | Critic 不应主动生成正文。写作完成后若需事实核查，仍由现有 critic gate 政策决定。 |
| `FrontDeskAgent` | 否 | FrontDesk 仍然 `Allowed tools: none by default`，不直接调用工具。 |

### 3. `architect.md` / `experience-receiver.md` 的新 prompt 分支说明

#### `architect.md`
- 顶部 Role + Allowed tools 字符串扩为 14 个工具（含 `compose_career_text` 与 4 个轻量只读读取工具 `list_jds` / `get_jd` / `list_experiences` / `get_experience`）。
- 新增 Asset-grounded writing branch (Phase 3) 一节，包含：
  1. 触发条件：`handoff.intent === asset_grounded.write`，并列举常见用户句式。
  2. 必须做的 4 件事：① 主步骤永远是 `compose_career_text`；② 参数严格从 handoff 字段映射；③ natural-language 不能进 `experienceIds`，要走 `experienceQuery`；④ scope 不足时也要 plan compose_career_text 让工具自己 `needs_input`，禁止人为编造。
  3. 可选的 1 个只读 lookup（`list_experiences` / `get_experience` / `list_resumes` / `get_resume` / `list_jds` / `get_jd`）。
  4. 严格禁止清单：`generate_resume_from_jd` / `match_experiences_against_jd` / `accept_generation_variant` / `prepare_export_resume` / `export_resume` / `revise_resume_item` / 任何 `save_*` / `update_*` / `delete_*`。
- 在 Examples 段新增 4 个示例（Example 6/7/8/9），覆盖 self_intro / project_intro+experienceQuery / JD-anchored self_intro / profile_summary。

#### `experience-receiver.md`
- 顶部 Role + Allowed tools 增加 `compose_career_text`。
- Tool Selection Rules 增加一条：`compose_career_text` 仅用于围绕一条或几条经历的 read-only 写作。
- 新增 Asset-grounded writing branch (Phase 3) 一节：
  - 触发样例：`根据 WEEX 实习写一段面试时能说的项目介绍` / `把这条经历改成 1 分钟口述版本`。
  - 三相邻意图分流表（rewrite/save vs compose vs intake），明确 `优化这条经历` 等仍走原 `update_experience` 链路。
- 新增 `compose_career_text` 调用示例。

### 4. `asset_grounded.write` 下允许 / 禁止调用的工具

允许（仅用于必要的 grounding 读取，可选）：

- `compose_career_text`（必出现，作为收尾步骤）
- `list_experiences` / `get_experience` / `match_experience` / `search_experiences`
- `list_resumes` / `get_resume`
- `list_jds` / `get_jd`

禁止（这些属于其它链路）：

- `generate_resume_from_jd`
- `match_experiences_against_jd`
- `accept_generation_variant`
- `prepare_export_resume` / `export_resume`
- `revise_resume_item`
- 所有 `save_*` / `update_*` / `delete_*`（含 `save_jd_from_text` / `save_experience_from_text` / `update_experience` / `delete_experience` / `prepare_save_*` / `prepare_update_*` / `prepare_delete_*`）

实际生效层有三道：

1. **prompt 层** — architect.md / experience-receiver.md 显式 forbid。
2. **agent allowedTools 层** — architect 不持有 `save_*` / `update_*` / `delete_*` 类工具；experience_receiver 持有这些工具但 prompt 强制走原链路。
3. **工具自身契约层** — `compose_career_text` 是 `mutability=read` / `requiresConfirmation=false` / `riskLevel=low`，即使被调用也不会创建 `pendingAction`，不会写 `workspacePatch.variants` / `productGenerationId` / `activePanel`。

### 5. 是否新增外部 API

**没有新增任何外部 REST API。** 写作能力 100% 通过现有 `/copilot/chat` 走 FrontDesk → Specialist → Tool 链路承载。`/copilot/actions`、`/copilot/pending-actions`、`/product/*`、`/exports/*`、`/jobs/*` 全部保持现状；不存在 `/career-writing/*` / `/copywriting/*` / `/self-intro/*` 等新业务路由。

### 6. 是否影响现有 `/copilot/chat` 请求体与响应体

**不影响。**

| 维度 | 是否变化 | 说明 |
|-----|---------|------|
| `CopilotChatRequest` 主结构 | 否 | 用户仍只通过 `message` + `clientState` 表达需求 |
| `CopilotChatResponse` 主结构 | 否 | `assistantMessage` / `workspace` / `nextActions` / `agentRoomEvents` / `raw` 全部保持原语义 |
| `displaySnapshot` / `productBlocks` / `pendingActions` / `actionResults` | 否 | 没有新增字段、没有重命名、没有改语义 |
| `ToolResult` 顶层字段 | 否 | Phase 2 已经把 `resultKind = asset_grounded_text_completed / asset_grounded_text_needs_input` 加入了开放枚举字段；Phase 3 不再新增任何顶层 key |
| `SpecialInfoKind` 枚举 | 否 | 仍为现有 14 个值（写作结果是否需要独立卡片留待 Phase 5 评估） |
| `FrontDeskHandoff` 字段 | 否 | Phase 1 已加入的 additive 字段（`outputType` / `constraints` / `experienceQuery` / `goal`）继续生效 |

### 7. 是否影响现有十阶段主链路

**不影响。** 已通过 829 个回归测试逐项确认：

- **JD 分析（jd.analyze）**：strategist 链路源码与 prompt 未触及；`analyze_jd` 工具未改。
- **JD 匹配（experience.match_against_jd）**：`match_experiences_against_jd` 仍然只在 `experience_receiver` 与 `architect` 的固定链路下被调用；asset_grounded 分支的 prompt 显式禁止它。Phase 3 测试 D 组直接断言 `帮我看哪些经历最匹配这份 JD` 仍 plan 出 `match_experiences_against_jd`。
- **简历生成（resume.generate_from_jd）**：`maybeAugmentResumeGenerationPlan` 只对 `generate_resume_from_jd` 触发，对 `compose_career_text` 完全惰性。Phase 3 测试 D 组验证 `基于这个 JD 生成简历` 仍 plan 出 `generate_resume_from_jd`。
- **接受 / 一页 PDF 导出 / 质量报告 / Critic / RAG / Self-evolution**：源码完全未触及；Phase 3 测试 D 组直接验证 `接受这个版本` 仍走 `accept_generation_variant`、`导出这份简历` 仍走 `prepare_export_resume` / `export_resume`。
- **NarratorService**：未改动；asset_grounded 写作的 ToolResult 默认进入 narrator 的常规路径，但 Phase 3 不强制 narrator 改写 compose_career_text 的正文事实。

### 8. 是否影响 pendingAction / workspacePatch / productBlocks / SpecialInfo

**全部不影响。**

- `compose_career_text` 是 read-only / requiresConfirmation=false / riskLevel=low，工具实现层从不创建 `pendingActions` 条目。Phase 3 测试 E 组直接断言执行后 `result.pendingActionId === undefined`。
- `compose_career_text` 不输出 `workspacePatch`。Phase 3 测试 E 组直接断言 `result.workspacePatch === undefined`，且 JSON 序列化后不含 `variants` / `productGenerationId` / `export_job` 等关键字。
- 不写 `productBlocks`。`activePanel` 不变。`displaySnapshot.pendingActions` / `displaySnapshot.productBlocks` 不被修改。
- `SpecialInfoKind` 仍为 Phase 2 之前的 14 个值，Phase 3 不新增。前端按 `ToolResult.resultKind === asset_grounded_text_completed` 识别即可，未识别时降级为通用消息。

### 9. 新增测试与回归测试结果

新增测试文件：`tests/agentAssetGroundedRoutingPhase3.test.ts`，19 个用例分为 6 组：

1. **A. allowedTools 开放与回归**（6）— 验证 `compose_career_text` 已加入 architect / experience_receiver 的 `allowedTools`；验证 9 个 architect 固定工具 + 17 个 experience_receiver 固定工具全部保留；验证工具仍是 read-only / low risk / no-confirmation；验证 `createAgentTools()` 仍然暴露该工具。
2. **B. Architect plans compose_career_text on asset_grounded.write**（4）— 用 stub LLM 驱动 `ArchitectAgent.decide()`，分别覆盖 self_intro、JD-anchored self_intro、profile_summary 与 allowedTools enforcement，全部断言 plan 第一步是 `compose_career_text`、且不出现任何 PHASE3_FORBIDDEN 工具。
3. **C. ExperienceReceiver single-experience writing**（2）— 验证 WEEX 项目介绍 plan 出 `compose_career_text` 且不触发 `save_*` / `update_*` / `prepare_save_*`；验证 `优化这条经历并保存` 仍保留原 `update_experience` 链路。
4. **D. 固定链路回归**（4）— `帮我看哪些经历最匹配这份 JD` → `match_experiences_against_jd`；`基于这个 JD 生成简历` → `generate_resume_from_jd`；`导出这份简历` → `prepare_export_resume` / `export_resume`；`接受这个版本` → `accept_generation_variant`；四条全部不应包含 `compose_career_text`。
5. **E. End-to-end execution**（1）— Architect plan → ToolExecutor 真实运行 `compose_career_text`，断言 `resultKind` ∈ {`asset_grounded_text_completed`, `asset_grounded_text_needs_input`}、`data.content` / `data.usedExperienceIds` 存在、`summaryFacts` / `entities` / `nextActionHints` 全数存在；断言 `pendingActionId` / `workspacePatch` 均 undefined；断言序列化后不含 `variants` / `productGenerationId` / `export_job`。
6. **F. Prompt-vs-allowedTools alignment**（2）— 直接读取 architect.md / experience-receiver.md，断言两个 prompt 都包含 `compose_career_text`、architect.md 包含 `asset_grounded.write` 与 4 个 PHASE3_FORBIDDEN 关键字、experience-receiver.md 包含 `read-only`。

回归命令与结果：

```text
$ npm run typecheck
> tsc --noEmit
（无错误）

$ npm test
Test Files  92 passed (92)
     Tests  829 passed (829)
  Duration  10.00s
```

对比 Phase 2 baseline（91 文件 / 810 用例），本阶段净增 1 个测试文件 + 19 个用例；同时把 Phase 2 中的 2 条 `not.toContain` 守卫反转为 Phase 3 `toContain`，既有 808 + 17 = 825 个测试 0 失败、0 跳过、0 漂移。

### 10. `npm run typecheck` 与 `npm test` 结果

已在第 9 节中记录。两条命令均返回 0 错误。

### 11. 对 Phase 4 的输入：哪些 RAG / PreferenceBank grounding 仍需增强

Phase 3 只把工具开放给 Specialist，并通过 prompt 严格分流；工具内部的 grounding 接入沿用 Phase 2 的实现。Phase 4 应聚焦于如下增强点：

**A. EvidenceRAG 触发条件优化（高优先级）**

- 当前实现：`compose_career_text` 仅在 `jdText.length >= 40` 时调用 `buildEvidencePack`。
- Phase 4 建议改进：
  1. **experience-grounded mode 也按需调用**：当用户已经选定 1–3 条经历且没有 JD（典型场景：`根据 WEEX 写一段项目介绍`）时，可基于经历自身的 `content` 做 claim 级别的 retrieval，而不是只在 JD 存在时才调用 EvidenceRAG。这能让生成的文本更精准引用经历内的可验证事实（指标、技术栈、产出物）。
  2. **缓存 Phase 1 已经解析过的 jdText**：避免一次 turn 内多次调用 EvidenceRAG（当前 architect 可能 plan 出 `get_jd` + `compose_career_text`，两次走 RAG 是浪费的）。
  3. **超时 / 失败降级显式化**：当前 try/catch 静默降级，建议在 `warnings` 中加入 `evidence_rag_timeout` 或 `evidence_rag_unavailable` 的稳定 reason 标识，便于自我进化层学习。

**B. GuidelineRAG 接入（中优先级，目前未接）**

- 当前实现：`compose_career_text` 完全没有调用 `GuidelineRAGService`。
- Phase 4 建议接入：根据 `constraints.audience` / `constraints.tone` / `outputType` 查询 `InstructionPack`，把 tone / structure / industry-specific phrasing guidelines 注入 prompt 的 `# Style preferences` 段（位置必须在 `# Experiences` 之后，且系统 prompt 仍保留 `style preferences are NEVER a source of facts` 硬规则）。
- 边界：GuidelineRAG 不得提供事实类 claim；如发现 InstructionPack 内容包含数字或经历指标，应在 `riskNotes` 警示并不参与 prompt 注入。

**C. PreferenceBank grounding 强化（中优先级）**

- 当前实现：`buildPersonalizationPack({ limit: 10 })`，stable + contextual + negative 三类全数注入。
- Phase 4 建议改进：
  1. **对 `outputType` 做 preference scope 过滤**：例如 self_intro 类不需要 cover_letter 偏好；通过 `context.outputType` 让 PreferenceBank 返回更相关的 top-K。
  2. **应用度记账**：`personalizationApplied` 当前只记录 `diagnostics.appliedCount`。可加入 `appliedPreferenceIds` 列表，便于后续 `LearningEventService` 学习哪些偏好真正被采纳。

**D. 单条经历 + active resume 双重 grounding 协同（低优先级）**

- 当用户场景同时存在 `activeResume` 与 `experienceQuery`，`compose_career_text` 当前只把 resume 用作 `serializeResumeForGrounding` 的字符串 snapshot；可让经历 + resume item 进行交叉验证，例如经历提到 `Power BI 仪表盘` 但 resume 中没有，可以在 `riskNotes` 中提示一致性问题。

**E. 真实 LLM probe 验证（Phase 6 任务，但 Phase 4 应预留 hooks）**

- Phase 6 才会跑真实 LLM 验证。Phase 4 在改 grounding 时应保持 Phase 2 的 `deterministic_test_fallback` 行为不被破坏，否则 Phase 6 probe 在 Stub LLM 模式下也会出问题。

### 12. 风险与待跟进项

- ⚠️ **architect prompt 体积变大**：本阶段 prompt 增加了约 60 行（含 4 个示例）。`architect.md` 现在比 strategist / experience-receiver 都长，未来如果继续叠加分支，要警惕 prompt 走样。Phase 5 / 6 之前不再加新的 architect 分支。
- ⚠️ **experience_receiver 持有写工具但 prompt 强制 read-only 写作**：理论上 LLM 仍可能在 asset_grounded 分支 plan 出 `save_experience_from_text`。在 `AgentOrchestrator.validatePlan` 阶段不会被拒（因为这些工具确实在 allowedTools 里），但实际 Phase 3 测试用 stub LLM 已覆盖正常路径。Phase 4 若发现真实 LLM 误规划，可考虑加 plan-level guard：`handoff.intent === asset_grounded.write` 时拒绝 `save_*` / `update_*` / `delete_*` 类工具步骤。
- ⚠️ **Phase 1 启发式仅覆盖部分句式**：例如 `帮我把 WEEX 改成面试可以说的话` 当前在 normalizer 中可能仍被 fallback 启发式归到 `experience.rewrite`。Phase 4 实际跑真实流量后再评估是否补启发式或在 prompt 层兜底。
- ⚠️ **Critic 行为**：`compose_career_text` 是 read-only / low risk，目前 `ReviewPolicy` 不会自动触发强制 critic。Phase 4 / 5 真实 LLM 跑下来如果发现写作输出仍出现幻觉，可在 architect prompt 中显式建议跑一次 `critic` 二次校验，但这不是硬性要求。

---

### Phase 4：RAG / PreferenceBank grounding

目标：
让 compose_career_text 复用现有 RAG 和 PreferenceBank。

要求：

* 能使用相关 experience claims / evidence。
* 能读取 preference 作为风格偏好。
* 输出中体现 usedExperienceIds / usedEvidenceIds。
* 没有证据时 riskNotes 说明依据不足。
* 不编造事实。

## Phase 4 完成情况报告（RAG / PreferenceBank grounding 增强）

> 已完成。增强集中在 `compose_career_text` 工具内部 grounding 层：不新增 Task Layer、不新增 Agent、不新增 REST API、不新增 SpecialInfo kind，不改 `/copilot/chat` 请求体/响应体主结构。`npm run typecheck` 与 `npm test` 均通过（全量 Vitest 通过，新增 Phase 4 专项 6 个用例）。

### 1. 修改文件

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/agent-tools/writing/composeGroundingHelpers.ts` | 增强 | Phase 4 grounding helper：EvidenceRAG 短 JD / experience fallback 触发、RAG timeout/error diagnostics、GuidelineRAG style-only 规则过滤、PreferenceBank outputType/language/tone/style-only 过滤。 |
| `src/agent-tools/writing/composeCareerText.tool.ts` | 增强 | 将 `constraints.tone` 传入 PreferenceBank 过滤；继续把 EvidenceRAG / GuidelineRAG / PreferenceBank diagnostics 折叠进 `riskNotes`、`warnings`、`summaryFacts`、`data.groundingDiagnostics` 和 `writing_result` entity data。 |
| `tests/composeCareerTextPhase4.test.ts` | 新增/补完 | 6 个 Phase 4 合同测试，覆盖 experience-grounded evidence、single-experience evidence scope、短 JD + evidence、GuidelineRAG fact filtering、PreferenceBank fact filtering、RAG failure degradation。 |

### 2. EvidenceRAG 接入方式

- `compose_career_text` 现在不再把 `jdText.length >= 40` 作为唯一触发条件；只要有 `jdText` 就走 JD-triggered EvidenceRAG，短 JD 会扩展成稳定 retrieval seed。
- 无 JD 但有 experiences 时，会从 1-3 条经历的 title / role / organization / tags / content 合成 pseudo seed，触发 `EvidenceRAGService.buildEvidencePack`，再把 claims 限定回当前 resolved experience ids。
- RAG timeout/error 不再静默：`warnings` 会输出稳定 token（如 `evidence_rag_unavailable` / `evidence_rag_timeout`），`data.riskNotes` 会追加用户可见风险说明，`data.groundingDiagnostics.evidenceRag` 保留 trigger/status/detail。

### 3. GuidelineRAG 接入方式

- `compose_career_text` 根据 `outputType`、`constraints.tone`、`constraints.audience`、`constraints.format`、JD/经历 seed 调用 `GuidelineRAGService.buildInstructionPack`。
- 仅把 `writingRules` / `softPreferences` 中通过过滤的 style rules 注入 prompt 的 `# Writing guidelines (style/structure ONLY)` 段。
- GuidelineRAG 不作为事实来源：包含明显数字、百分比、年份、引用实体名等 fact-bearing 气味的 guideline rule 会被移除，不进入 LLM prompt，并在 `riskNotes` / diagnostics 中记录 filtered count。

### 4. PreferenceBank 使用边界

- PreferenceBank 仍只影响 tone / voice / length / structure / language，不提供事实。
- 查询时按 language 构造 scope；工具内再按 `outputType` 过滤不适用偏好（如短文本丢弃 full-resume `section_order`），并按显式 `constraints.tone` 丢弃明显冲突 tone 偏好。
- 偏好文本若包含明显未证实事实或指标（数字、百分比、年份、引用实体名），不会注入 prompt。
- 输出中保留 additive 可追踪信息：`data.personalizationApplied`、`data.appliedPreferenceIds`、`data.groundingDiagnostics.preferenceBank`，以及 `writing_result` entity data 中同名诊断字段。

### 5. Contract / additive 字段变化

- 未新增 ToolResult 顶层字段。
- 未新增 REST API、请求字段、响应主结构或 SpecialInfo kind。
- 仅在既有 `ToolResult.data` 与 `writing_result` entity `data` 内追加诊断字段：`groundingDiagnostics`、`guidelineRagApplied`、`instructionPackVersion`、`personalizationApplied`、`appliedPreferenceIds`、`evidenceRagTrigger/status`、`guidelineRagStatus` 等。
- 这些字段均为 additive，旧前端可忽略；主识别仍可使用 Phase 2 已有 `resultKind = "asset_grounded_text_completed"`。

### 6. 测试结果

- `npx vitest run tests/composeCareerTextPhase4.test.ts`：通过（6 / 6）。
- `npm run typecheck`：通过。
- `npm test`：通过；Phase 1–3 相关测试、JD 分析、JD 匹配、简历生成、accept、export、quality critic 等主链路回归均未失败。

### 7. 对外部 API 与十阶段主链路影响

- 外部 API：无影响。没有改 `/copilot/chat` envelope，没有新增 endpoint，没有要求前端传新字段。
- 十阶段主链路：无影响。`compose_career_text` 仍是 read-only / low-risk / no-confirmation，不创建 `pendingAction`，不写 `workspacePatch`，不产出 variants / productGenerationId / export_job。
- JD-grounded writing 只调用 writing 工具内部 RAG，不触发 `match_experiences_against_jd`、`generate_resume_from_jd`、accept 或 export。

### 8. Phase 5 需要注意

- Phase 5 若要前端独立渲染写作结果，建议仍优先识别 `ToolResult.resultKind === "asset_grounded_text_completed"` 与 `actionResult.actionType === "compose_career_text"`；是否新增 `writing_result` / `asset_grounded_text` SpecialInfo kind 可继续保持 additive。
- `groundingDiagnostics` 已足够支撑 UI 展示“使用了哪些 grounding 信号 / 哪些 RAG 降级”，但不要把 GuidelineRAG / PreferenceBank 渲染成事实来源。
- 真实 LLM probe（Phase 6）仍需重点观察：模型是否遵守 guideline/preference style-only 边界、是否在短 JD + 少经历场景编造指标、ExperienceReceiver 是否偶发把 read-only 写作误规划成 save/update。

### Phase 5：SpecialInfo / contract 最小接入

目标：
让写作结果能通过聊天区被前端识别。

要求：

* 不破坏现有 SpecialInfo。
* 新增 writing_result / asset_grounded_text contract，或临时复用现有结构。
* docs 更新。
* 前端后续能独立渲染。

## Phase 5 完成情况报告（SpecialInfo / contract 最小接入）

> 已完成。选择新增 additive `SpecialInfoKind = "writing_result"`，让 `compose_career_text` 的结果在 `agentRoomEvents[]` 中稳定投影为聊天区特殊信息。未新增 REST API、未新增 Agent、未新增 Task Layer，未改 `/copilot/chat` 请求体/响应体主结构，未改 pendingAction / workspacePatch / productBlocks / export / resume generation 主链路。

### 1. 修改文件

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/agent-core/events/AgentRoomEvent.ts` | additive type | `SpecialInfoKind` 追加 `"writing_result"`；保留原有 14 个 kind 语义不变。 |
| `src/agent-core/events/AgentRoomEventProjector.ts` | 投影增强 | 当 ToolResult `resultKind` 为 `asset_grounded_text_completed` / `asset_grounded_text_needs_input` 时，投影为 `eventKind="special_info"` + `specialInfo.kind="writing_result"`；普通 ToolResult / ProductBlock / pendingAction 投影保持不变。 |
| `tests/AgentRoomEventProjector.test.ts` | 测试增强 | 新增 success / needs_input 两个写作结果投影测试，并保留既有 match matrix、candidate form、decision panel、asset capsule 等测试。 |
| `docs/CONTRACT.md` | contract 文档 | 新增 `writing_result` SpecialInfo contract、识别信号、字段含义、事实来源边界、降级策略。 |
| `docs/copilot-action-contract.md` | contract 文档 | 明确 `compose_career_text` 不是新 action/API，而是 `/copilot/chat` 内部 read-only tool 的 additive display contract。 |

### 2. 是否新增 SpecialInfo kind

新增：`writing_result`。

这是 additive enum 扩展：旧前端不识别时可跳过或走通用卡片，不影响已有 `match_matrix`、`experience_candidate_form`、`jd_analysis_result`、`variant_compare_board`、`decision_panel`、`asset_capsule`、`export_receipt`、`risk_callout` 等 SpecialInfo。

### 3. `writing_result` contract

触发来源：

- `ToolResult.resultKind === "asset_grounded_text_completed"`
- `ToolResult.resultKind === "asset_grounded_text_needs_input"`
- `actionResult.actionType === "compose_career_text"`

AgentRoomEvent：

```ts
{
  eventKind: "special_info",
  relatedToolName: "compose_career_text",
  specialInfo: {
    kind: "writing_result",
    title,
    summary,
    data: {
      title,
      content,
      outputType,
      alternatives,
      usedExperienceIds,
      usedResumeIds,
      usedJDIds,
      usedEvidenceIds,
      groundingNotes,
      riskNotes,
      suggestions,
      groundingDiagnostics,
      styleReferenceSignals,
      factSourceFields,
      styleOnlyFields
    },
    relatedResourceIds,
    actions,
    source: { toolName: "compose_career_text" }
  }
}
```

事实来源边界：

- 事实/正文展示：`content`、`usedExperienceIds`、`usedEvidenceIds`、`groundingNotes`、`riskNotes`。
- retrieval 状态说明：`groundingDiagnostics.evidenceRag`。
- 仅风格/表达参考：`groundingDiagnostics.guidelineRag`、`groundingDiagnostics.preferenceBank`、`styleReferenceSignals`。前端不得把 GuidelineRAG / PreferenceBank 展示为事实证据。

### 4. 前端识别方式

推荐优先级：

1. `agentRoomEvents[i].specialInfo.kind === "writing_result"` 且 `relatedToolName === "compose_career_text"`。
2. `raw.toolResults[i].resultKind === "asset_grounded_text_completed"`。
3. `raw.toolResults[i].resultKind === "asset_grounded_text_needs_input"`。
4. `raw.toolResults[i].actionResult.actionType === "compose_career_text"`。

旧前端降级：

- 不识别 `writing_result` 时，继续显示 `assistantMessage.content`。
- 或显示 `raw.toolResults[i].message` / `raw.toolResults[i].data.content`。
- Unknown SpecialInfo kind 必须可跳过，不阻塞聊天。

### 5. 是否影响外部 API / 主链路

- 外部 API：无影响。`/copilot/chat` 和 `/copilot/actions` envelope 不变，无新增 endpoint。
- pendingAction：无影响。`compose_career_text` 仍是 read-only / no-confirmation，不创建 pending action。
- workspacePatch / productBlocks：无影响。写作结果不写 workspacePatch，不生成 ProductBlock，不写 variants / productGenerationId / export_job。
- 十阶段主链路：无影响。JD 分析、JD 匹配、简历生成、accept、export、quality critic 仍走原路径；现有 SpecialInfo kind 映射不变。

### 6. 测试结果

- `npx vitest run tests/AgentRoomEventProjector.test.ts`：通过（21 / 21）。
- `npm run typecheck`：通过。
- `npm test`：通过（全量回归通过）。

### 7. Phase 6 真实 LLM probe 需要重点验证

- 真实 `asset_grounded.write` turn 是否一定产生 `writing_result` AgentRoomEvent，并保留 `usedExperienceIds` / `usedEvidenceIds`。
- `needs_input` 场景是否以 `writing_result` 卡片表达缺少资产，而不是普通失败文本。
- GuidelineRAG / PreferenceBank 是否仅影响表达风格，真实输出不新增未证实事实或指标。
- ExperienceReceiver 单条经历写作是否仍是 read-only，不误触发 save/update。
- JD-grounded writing 是否只生成写作卡片，不触发 match matrix / resume variants。

### Phase 6：回归测试与真实 LLM 验证

必须跑：

* npm run typecheck
* npm test
* 真实 LLM probe

真实输入：

1. “根据我的经历帮我写一条 1 分钟中文自我介绍”
   预期：

* 不触发 JD match matrix
* 不触发 generate_resume_from_jd
* 返回自然文字
* 有 usedExperienceIds / groundingNotes

2. “根据 WEEX 实习经历帮我写一段面试项目介绍”
   预期：

* 使用 WEEX experience
* 不编造指标
* 输出面试口吻文本

3. “根据这份 JD 写一段自我介绍：<JD 文本>”
   预期：

* 使用 JD context
* 仍然是 writing task
* 不生成简历 variants
* 不展示 match matrix 作为主结果

4. “帮我看哪些经历最匹配这份 JD：<JD 文本>”
   预期：

* 仍然进入 JD match
* match matrix 正常

5. “基于这个 JD 生成简历：<JD 文本>”
   预期：

* 仍然进入 resume generation
* variants / recommendedVariantId / comparisonMatrix 正常

## 测试要求

新增测试至少覆盖：

1. FrontDesk routing：
   “根据我的经历帮我写一条自我介绍”
   → asset_grounded.write / compose_career_text
   → 不进入 JD match

2. FrontDesk routing：
   “根据 WEEX 实习经历写一段项目介绍”
   → asset_grounded.write
   → 尝试解析 WEEX experienceId

3. FrontDesk routing：
   “根据这份 JD 写一段自我介绍”
   → asset_grounded.write with jdText
   → 不进入 match_experiences_against_jd

4. Regression：
   “帮我看哪些经历匹配这份 JD”
   → experience.match_against_jd

5. Regression：
   “基于这份 JD 生成简历”
   → resume.generate_from_jd

6. Tool test：
   有 experiences 时 compose_career_text 返回 content + usedExperienceIds。

7. Tool test：
   无 experiences 时返回 needs_input，不编造。

8. Tool test：
   PreferenceBank 只能影响 tone，不能新增事实。

9. Regression：
   现有十阶段主链路测试全部通过。

## 最终报告格式

完成后输出：

1. 架构判断：

   * 当前架构合理部分
   * 当前泛化不足根因
   * 为什么不新增上层 Task Layer

2. 采用方案：

   * 是否新增工具
   * 是否复用 Architect / ExperienceReceiver
   * 是否新增 Agent，如没有，说明为什么
   * 是否新增 SpecialInfo kind

3. 修改文件清单。

4. Contract 变化。

5. RAG / PreferenceBank 如何接入。

6. Narrator 是否改动，边界是什么。

7. 测试结果：

   * npm run typecheck
   * npm test
   * 新增测试

8. 真实 LLM 验证结果。

9. 对现有十阶段主链路是否有影响。

10. 后续建议：

* 是否需要前端新增 writing_result 渲染
* 是否需要继续开放更多 read-only tools
* 是否需要后续再评估是否拆出 CopywriterAgent

````

这个版本的核心改动是：**不再主张新增任务层，也不优先新增 Agent**。

更优雅的方向是：

```text
保持现有架构薄
把能力做成高内聚工具
把路由从固定流程改成语义 goal
开放 read-only tools
用 policy 约束危险工具
复用 RAG / PreferenceBank 做 grounding
````

这样扩展性会比“每多一个需求就加一个 Agent / 加一个层 / 加一个 workflow”更好。
