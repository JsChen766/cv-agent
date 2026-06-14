# Coolto / 库投 Agent 内部架构重构分阶段计划

版本：v1.0  
目标仓库：`JsChen766/cv-agent`  
重构性质：内部架构升级，不改变任何现有对外接口与后端-Agent 对接 contract  
适用范围：`src/agent-core`、`src/agent-domains`、`src/agent-tools`、`src/copilot` 中与 Agent Runtime 内部编排相关的代码

---

## 0. 本轮重构的核心目标

本轮不是新增一个具体功能，也不是马上接入真实 RAG、向量库或 self-evolution 算法。

本轮目标是：

> 在不改变任何现有 API、前后端契约、Agent 输出契约、Tool 契约、ProductBlock 契约的前提下，把当前 Agent 内部从“一个大 Orchestrator + 静态 Agent/Tool”重构为“可插拔能力层 + 稳定执行管线”，为未来 RAG、长期记忆、反思、自评估、自我进化、用户偏好学习、证据追踪、技能盲区检测等能力预留高质量架构插槽。

最终希望达到：

1. 工程扩展性更好：新增内部 Agent、Tool、Domain、ContextProvider、Retriever、Memory、Reflection、Evaluation 不再需要修改大量中心化逻辑。
2. 智能能力扩展性更好：未来可以低成本接入 RAG、Self-Reflection、Self-Evaluation、Self-Evolution、用户偏好学习、有效性回灌。
3. 抽象更合理：AgentOrchestrator 不再承担所有职责，而是变成协调器。
4. 高内聚低耦合：Context、Execution、Review、Evidence、Reflection、Evaluation、Result Assembly 各自独立。
5. 兼容现有系统：所有现有前端、后端、测试、合同继续工作。

---

## 1. 绝对不能破坏的 Contract

本轮重构必须严格遵守以下边界。

### 1.1 不改变 API Route

不得改变：

- `POST /copilot/chat`
- `POST /copilot/chat/stream`
- `POST /copilot/actions`
- pending action 相关 API
- product 相关 API
- files / exports / jobs 相关 API
- debug API 的现有返回结构

可以新增内部类、内部接口、内部测试辅助，但不要新增必须被前端依赖的新 route。

### 1.2 不改变 Copilot Request / Response Contract

不得改变：

- `CopilotChatRequest`
- `CopilotChatResponse`
- `CopilotActionRequest`
- `CopilotActionResult`
- `CopilotMessageMetadata`
- `CopilotWorkspace`
- `DisplaySnapshot`
- SSE event envelope

可以在内部使用新的对象，但最终返回给前端的结构必须与现有结构兼容。

### 1.3 不改变 Agent Output Contract

不得改变：

- `AgentDecisionSchema`
- `PlanStepSchema`
- `CriticReviewSchema`
- `AgentNameSchema` 的现有值
- `Agent.decide()` 的现有调用方式

本轮可以在内部包装 agent manifest、agent runner、decision runner，但不要要求现有 agent prompt 或输出格式发生破坏性变化。

### 1.4 不改变 Tool Contract

不得改变：

- `ToolDefinition`
- `ToolResult`
- `ToolExecutor.execute()` 的外部语义
- `requiresConfirmation`
- `riskLevel`
- `mutability`
- `ownerAgent`
- inputSchema / outputSchema 验证机制

可以新增 ToolCapability、ToolPolicy、ToolAdapter 等内部辅助层，但不能破坏现有工具定义方式。

### 1.5 不改变 ProductBlock Contract

不得改变已有 ProductBlock 类型名称和字段语义，例如：

- `experience_list`
- `experience_card`
- `experience_detail`
- `experience_candidate_form`
- `jd_analysis_result`
- `action_result`
- `experience_match_results`
- `jd_match_results`

可以优化内部生成 ProductBlock 的逻辑，但不能让前端必须适配新 contract。

---

## 2. 当前架构问题总结

### 2.1 AgentOrchestrator 过重

当前 `AgentOrchestrator` 同时承担：

- session / turn 创建
- user message 保存
- AgentContext 构建
- FrontDesk routing
- handoff normalization / application
- specialist loop
- plan validation
- tool execution
- pending action 创建
- critic review
- revision loop
- workspace patch 合并
- product block 生成
- response compose
- stream event emit
- trace record
- display snapshot persistence

这导致后续接入 RAG、Memory、Reflection、Evaluation 时很容易继续往 Orchestrator 里堆逻辑，架构会越来越难维护。

### 2.2 ContextProvider 入口太薄

当前已经有 `ContextProvider` 概念，但接口只有：

```ts
provide(context: AgentContext): Promise<Record<string, unknown>>;
```

它只能“提供上下文”，不能表达：

- 检索
- 写入记忆
- 证据归一化
- 用户反馈学习
- 反思沉淀
- 评估回灌
- token budget 管理
- retrieval scope 管理

因此它只是一个上下文入口，还不是完整的智能能力扩展层。

### 2.3 Domain / Agent / Tool 已经有抽象，但还不够平台化

当前已有：

- `AgentDomainModule`
- `AgentDomainRegistry`
- `ToolDefinition`
- `ToolRegistry`
- `ToolExecutor`

这些是好的基础，但目前 domain 基本仍然静态聚合到 career domain，agent 名称、prompt 注册、agent room mapping 等仍有中心化硬编码。

本轮不要求彻底动态插件化，但要把内部结构改到未来可以自然演进。

### 2.4 CriticGate 是单轮审查，不是 self-evolution

当前 `CriticGate` 可以对高影响工具结果做 review，并触发 revision loop。

这很适合作为“质量门”，但还不是：

- 长期反馈学习
- 用户偏好学习
- 成功率回灌
- 策略记忆
- 技能盲区检测
- 自我进化机制

本轮应把 CriticGate 周边沉淀出 Review / Evaluation / Reflection 的内部接口，而不是马上实现复杂学习算法。

### 2.5 缺少 Evidence 作为一等内部对象

库投的核心不是普通聊天，而是“基于真实经历证据生成求职材料”。

未来 RAG 和 self-evolution 都需要统一 Evidence Contract：

- 生成内容来自哪条经历？
- 哪些技能来自用户真实经历？
- 哪些 claim 缺证据？
- 哪些经历经常被匹配？
- 哪些版本被用户接受？
- 哪些表达导致风险？

当前 evidence 更像工具能力，不是 runtime 级内部结构。

---

## 3. 建议的目标内部架构

目标不是重写系统，而是逐步演进为下面结构：

```text
src/agent-core
  ├── runtime
  │   ├── AgentOrchestrator.ts              # 保留对外 facade，逐步瘦身
  │   ├── AgentRunCoordinator.ts            # 单轮运行协调
  │   ├── AgentDecisionRunner.ts            # 调 agent.decide + trace + validation
  │   ├── PlanExecutionService.ts           # 执行 plan step / tool / pending action
  │   ├── ReviewPipeline.ts                 # CriticGate 包装与 review policy
  │   ├── AgentResultAssembler.ts           # workspace/productBlocks/response/metadata assembly
  │   └── RunState.ts                       # RunState 类型集中管理
  │
  ├── context
  │   ├── ContextAssemblyPipeline.ts         # 上下文组装管线
  │   ├── ContextProvider.ts                 # 保留/迁移现有接口
  │   ├── BaseContextProvider.ts             # workspace/recent/active/user asset 适配
  │   ├── ProductContextProvider.ts          # 现有 ProductContextProvider 迁移或增强
  │   └── ContextBudgetManager.ts            # 先 Noop，未来控制 token budget
  │
  ├── capabilities
  │   ├── AgentCapabilityRegistry.ts         # 内部能力注册表
  │   ├── AgentCapabilityModule.ts           # context/retrieval/memory/reflection/evaluation 聚合
  │   └── defaultCapabilities.ts             # 默认 Noop 能力集合
  │
  ├── retrieval
  │   ├── RetrievalProvider.ts               # 统一检索接口
  │   ├── RetrievalQuery.ts
  │   ├── RetrievalResult.ts
  │   ├── RetrievalScope.ts
  │   └── NoopRetrievalProvider.ts
  │
  ├── evidence
  │   ├── EvidenceItem.ts
  │   ├── EvidenceBundle.ts
  │   ├── EvidenceNormalizer.ts
  │   └── EvidenceTrace.ts
  │
  ├── memory
  │   ├── MemoryProvider.ts                  # 长期记忆接口
  │   ├── MemoryRecord.ts
  │   ├── NoopMemoryProvider.ts
  │   └── adapters/ProductMemoryContextProvider.ts
  │
  ├── reflection
  │   ├── LearningEvent.ts
  │   ├── LearningEventRecorder.ts
  │   ├── ReflectionSink.ts
  │   ├── NoopReflectionSink.ts
  │   └── ReflectionContextProvider.ts
  │
  ├── evaluation
  │   ├── EvaluationHook.ts
  │   ├── EvaluationSignal.ts
  │   ├── NoopEvaluationHook.ts
  │   └── ReviewPolicy.ts
  │
  ├── domain
  │   ├── AgentDomainModule.ts               # 保留现有
  │   ├── AgentDomainRegistry.ts             # 保留并轻微增强
  │   └── AgentManifest.ts                   # 内部 manifest，不替换现有 Agent contract
  │
  ├── tools
  │   ├── Tool.ts                            # 保留现有 ToolDefinition
  │   ├── ToolRegistry.ts
  │   ├── ToolExecutor.ts
  │   └── ToolPolicy.ts                      # 内部 policy，非 breaking
  │
  └── validation
      └── AgentOutputSchemas.ts              # 不做 breaking 修改
```

注意：这个目录结构是目标方向，不要求第一阶段一次性全部落地。

---

## 4. 分阶段实施计划

---

# Phase 0：Contract Freeze 与基线测试加固

## 目标

在开始重构前，先把“不允许破坏的行为”锁住。否则后面架构重构很容易无意中改坏前端 contract。

## 要做什么

1. 增加或整理 contract guard tests。
2. 覆盖 `/copilot/chat`、`/copilot/actions`、pending action confirmation 的基本返回结构。
3. 覆盖 `AgentDecisionSchema`、`ToolDefinition`、`ToolResult`、`ProductBlock` 的兼容性。
4. 给 `AgentOrchestrator.handleChat()`、`handleExplicitAction()`、`confirmPendingAction()` 加 smoke tests。
5. 确认现有 `npm run typecheck`、`npm test` 通过。

## 建议新增测试文件

```text
tests/agentContractFreeze.test.ts
```

重点测试：

- `CopilotChatResponse` 仍包含原有字段。
- `metadata.productBlocks` 仍可被读取。
- `metadata.displaySnapshot` 仍存在或兼容。
- `raw.agentTrace`、`raw.toolResults`、`raw.actionResults` 的结构不破坏。
- `POST /copilot/actions` 的显式 action mapping 不破坏。
- pending action 创建、确认、取消流程不破坏。
- `ToolDefinition` 的字段没有被删除或改名。
- `AgentDecisionSchema` 仍接受现有五类 agent。

## 不做什么

- 不改架构。
- 不新增功能。
- 不改 prompt。
- 不改前端 contract。

## 验收标准

- `npm run typecheck` 通过。
- `npm test` 通过。
- 新增 contract tests 通过。
- 本阶段 commit 只应该增加测试与少量 test helper。

## 给 Codex 的简化 Prompt

```text
请在不修改任何业务逻辑的前提下，为当前后端 Agent Runtime 增加 contract freeze 测试。重点锁定 /copilot/chat、/copilot/actions、pending action confirmation、AgentDecisionSchema、ToolDefinition、ProductBlock、CopilotChatResponse 的兼容性。不要改现有 API、不要改前端 contract、不要改 agent/tool schema。完成后运行 typecheck 和 tests，并总结哪些 contract 被锁定。
```

## Phase 0 完成情况（2026-06-14）

### 已完成

- 新增 `tests/agentContractFreeze.test.ts`，仅增加 contract freeze 测试，没有修改业务逻辑、API route、prompt、agent/tool schema 或前端 contract。
- 覆盖 `POST /copilot/chat` 的基础响应 envelope：`sessionId`、`turnId`、`assistantMessage`、`timeline`、`workspace`、`nextActions`、`raw`。
- 覆盖 assistant metadata 兼容性：`metadata.productBlocks`、`metadata.displaySnapshot`、`displaySnapshot.productBlocks`、`displaySnapshot.toolResults`。
- 覆盖 raw debug/compat 字段：`raw.agentTrace`、`raw.toolResults`、`raw.actionResults`、`artifactIds`、`evidenceChainIds`、`critiqueItemIds`、`decisionIds`。
- 覆盖 `POST /copilot/actions` 的显式 action mapping，确认 `export_resume` 仍创建 pending action，且不会退回 chat routing。
- 覆盖 pending action confirmation：创建、确认、重复确认保持 200/兼容响应，不破坏确认语义。
- 为 `AgentOrchestrator.handleChat()`、`handleExplicitAction()`、`confirmPendingAction()` 增加直接 smoke tests。
- 覆盖 `AgentDecisionSchema` 仍接受现有五类 agent：`frontdesk`、`experience_receiver`、`strategist`、`architect`、`critic`。
- 覆盖 career domain 下所有 `ToolDefinition` 的必备字段：`name`、`description`、`ownerAgent`、`inputSchema`、`outputSchema`、`mutability`、`requiresConfirmation`、`riskLevel`、`execute`。
- 覆盖 `ToolResultSchema` 兼容 `success`、`needs_input` 等现有结果形状。
- 覆盖现有 `ProductBlock` 类型名保持不变：`experience_list`、`experience_card`、`experience_detail`、`experience_candidate_form`、`jd_analysis_result`、`action_result`、`experience_match_results`、`jd_match_results`。

### 验证结果

- `npm run typecheck` 通过。
- `npx vitest run tests/agentContractFreeze.test.ts` 通过：7 tests passed。
- `npm test` 通过：52 test files passed，530 tests passed。

### 变更范围确认

- 本阶段代码变更范围符合 Phase 0：新增 contract freeze 测试，并追加本文档完成记录。
- 未修改 `AgentOrchestrator` 运行逻辑。
- 未修改 `/copilot/chat`、`/copilot/chat/stream`、`/copilot/actions`、pending action、product、files、exports、jobs、debug 等 API route。
- 未修改 `CopilotChatRequest`、`CopilotChatResponse`、`CopilotActionRequest`、`CopilotActionResult`、`CopilotMessageMetadata`、`CopilotWorkspace`、`DisplaySnapshot` 或 SSE event envelope。
- 未修改 `AgentDecisionSchema`、`ToolDefinition`、`ToolResult` 或 `ProductBlock` contract。

---

# Phase 1：内部类型与 RunState 边界整理

## 目标

先把 `AgentOrchestrator.ts` 内部散落的运行时类型集中出来，为后续拆分服务做准备。

## 要做什么

1. 新增：

```text
src/agent-core/runtime/RunState.ts
src/agent-core/runtime/RunResult.ts
```

2. 将以下类型从 `AgentOrchestrator.ts` 移出：

- `RunState`
- `ExecutedPlan`
- `LoopRunResult`
- `AutoRevisionContext`

3. 保持类型字段不变，不改变运行逻辑。
4. 如果有循环依赖，优先抽离纯 type 文件。
5. 保持 `AgentOrchestrator` public methods 不变。

## 不做什么

- 不拆业务逻辑。
- 不重写 loop。
- 不新增新能力。

## 验收标准

- `AgentOrchestrator.ts` 行数略微下降。
- public API 不变。
- 类型引用更清晰。
- `npm run typecheck` 通过。
- `npm test` 通过。

## 给 Codex 的简化 Prompt

```text
请只做 Agent Runtime 内部类型整理：从 AgentOrchestrator.ts 中抽离 RunState、ExecutedPlan、LoopRunResult、AutoRevisionContext 等内部类型到独立 runtime type 文件。不要改变任何运行逻辑、API、schema、ToolDefinition、AgentDecisionSchema 或 ProductBlock。完成后运行 typecheck 和 tests。
```

## Phase 1 完成情况（2026-06-14）

### 已完成

- 新增 `src/agent-core/runtime/RunState.ts`，集中导出 `RunState` 与 `AutoRevisionContext`。
- 新增 `src/agent-core/runtime/RunResult.ts`，集中导出 `ExecutedPlan` 与 `LoopRunResult`。
- 从 `src/agent-core/runtime/AgentOrchestrator.ts` 移除上述四个内部 type alias，改为 type-only import。
- 保持 `RunState`、`ExecutedPlan`、`LoopRunResult`、`AutoRevisionContext` 的字段和语义不变。
- 保持 `AgentOrchestrator` public methods 不变：`handleChat()`、`handleChatStream()`、`handleExplicitAction()`、`confirmPendingAction()`、`getSession()`。

### 验证结果

- `npm run typecheck` 通过。
- `npx vitest run tests/agentContractFreeze.test.ts tests/agentRuntimeLoopAndCritic.test.ts tests/copilotExplicitActions.test.ts` 通过：3 test files passed，23 tests passed。
- `npm test` 通过：52 test files passed，530 tests passed。

### 变更范围确认

- 本阶段只做 runtime 内部类型文件整理。
- 未拆分或重写 specialist loop、plan execution、critic review、pending action confirmation、finishRun 或 result assembly 逻辑。
- 未修改 API route、request/response envelope、`AgentDecisionSchema`、`ToolDefinition`、`ToolResult`、`ProductBlock` 或 prompt。
- Phase 0 contract freeze tests 继续通过，可作为后续 Phase 2+ 的 baseline guard。

---

# Phase 2：引入 Capability Registry，但默认 Noop

## 目标

新增统一的内部能力注册层，让未来 RAG、Memory、Reflection、Evaluation 能以模块方式注册，而不是写进 `AgentOrchestrator`。

## 要做什么

新增目录：

```text
src/agent-core/capabilities
```

新增文件：

```text
AgentCapabilityModule.ts
AgentCapabilityRegistry.ts
defaultCapabilities.ts
```

建议接口：

```ts
type AgentCapabilityModule = {
  id: string;
  contextProviders?: ContextProvider[];
  retrievalProviders?: RetrievalProvider[];
  memoryProviders?: MemoryProvider[];
  reflectionSinks?: ReflectionSink[];
  evaluationHooks?: EvaluationHook[];
};
```

`AgentCapabilityRegistry` 负责：

- 注册 capability modules。
- 聚合 context providers。
- 聚合 retrieval providers。
- 聚合 memory providers。
- 聚合 reflection sinks。
- 聚合 evaluation hooks。
- 检测重复 id。

`defaultCapabilities` 初期只返回 Noop 能力，或者包装现有 `ProductContextProvider`。

## 重要要求

- 先不要把 RAG 真接进去。
- 所有新能力默认 Noop。
- 不改变现有 runtime 行为。
- 只提供内部 registry。

## 验收标准

- 可以在 `AgentOrchestrator` constructor 中创建 `capabilityRegistry`，但不影响现有行为。
- 没有任何 response 改变。
- `npm run typecheck` 通过。
- `npm test` 通过。

## 给 Codex 的简化 Prompt

```text
请新增 agent-core/capabilities 内部能力注册层，用于未来注册 context、retrieval、memory、reflection、evaluation 能力。默认实现必须是 Noop 或现有逻辑适配，不要接真实 RAG，不要改变任何 API、response、AgentDecisionSchema、ToolDefinition、ProductBlock 或现有行为。完成后运行 typecheck 和 tests。
```

## Phase 2 完成情况（2026-06-14）

### 已完成

- 新增 `src/agent-core/capabilities/AgentCapabilityModule.ts`，定义内部 `AgentCapabilityModule` 以及 context、retrieval、memory、reflection、evaluation 能力槽位类型。
- 新增 `src/agent-core/capabilities/AgentCapabilityRegistry.ts`，支持注册 capability modules、聚合各类 providers/sinks/hooks，并检测重复 module id。
- 新增 `src/agent-core/capabilities/defaultCapabilities.ts`，提供默认 `core.noop` capability module；默认不注册任何真实 provider，不接 RAG、不读写 memory、不触发 reflection/evaluation。
- 在 `AgentOrchestrator` constructor 中创建 `AgentCapabilityRegistry(createDefaultCapabilities())`，但不接入任何运行路径，因此不改变现有上下文、工具执行、review、response 或 metadata 行为。
- 新增 `tests/AgentCapabilityRegistry.test.ts`，覆盖默认 Noop 能力、provider 聚合顺序、重复 id 检测。

### 验证结果

- `npm run typecheck` 通过。
- `npx vitest run tests/AgentCapabilityRegistry.test.ts tests/agentContractFreeze.test.ts` 通过：2 test files passed，10 tests passed。
- `npm test` 通过：53 test files passed，533 tests passed。

### 变更范围确认

- 本阶段只新增内部能力注册层与测试。
- 未接入真实 RAG、retrieval、memory、reflection 或 evaluation 实现。
- 未修改 API route、request/response envelope、`AgentDecisionSchema`、`ToolDefinition`、`ToolResult`、`ProductBlock`、prompt 或任何前端 contract。
- 默认 capability module 为 Noop；不会改变 runtime 现有行为。
- 已检查非测试代码中本阶段新增/触达文件没有引入测试替身形式或测试替身命名。

---

# Phase 3：重构 Context Assembly Pipeline

## 目标

把当前 `buildAgentContext()` 中的上下文组装逻辑拆成可插拔管线。

当前上下文构建包含：

- workspace
- recentMessages
- trace
- messageBus
- loopController
- activeAssetContext
- userAssetContext
- productContext
- availableTools

这些不应该长期堆在 Orchestrator 里。

## 要做什么

新增目录：

```text
src/agent-core/context
```

新增文件：

```text
ContextAssemblyPipeline.ts
ContextAssemblyInput.ts
BaseContextProvider.ts
ContextBudgetManager.ts
```

将现有 `src/agent-core/memory/ContextProvider.ts` 迁移或 re-export 到 `src/agent-core/context/ContextProvider.ts`。为了兼容，可以保留旧路径 re-export：

```ts
export type { ContextProvider } from "../context/ContextProvider.js";
```

`ContextAssemblyPipeline` 负责：

1. 获取 workspace。
2. 获取 recentMessages。
3. 创建 trace。
4. 创建 messageBus。
5. 创建 loopController。
6. 构建 activeAssetContext。
7. 构建 userAssetContext。
8. 运行 capabilityRegistry 中的 contextProviders。
9. 合并 provider 输出到 `AgentContext.productContext` 下的独立命名空间。
10. 返回 `RunState`。

建议命名空间：

```ts
productContext: {
  ...existingProductContext,
  capabilities: {
    retrieval?: ...,
    memory?: ...,
    reflection?: ...,
    evaluation?: ...
  }
}
```

注意：外部 response 不应该暴露这些内部 context，除非原本就会通过 metadata 暴露。默认保持不可见或内部使用。

## 不做什么

- 不改变 `AgentContext` 现有字段名。
- 不改变 `BaseAgent.buildPayload()` 的输出结构，除非只是把同样的 `productContext` 传进去。
- 不实现真实检索。
- 不改变 prompt。

## 验收标准

- `AgentOrchestrator.buildAgentContext()` 变薄，主要委托给 `ContextAssemblyPipeline`。
- 旧行为不变。
- `productContext` 仍包含 `targetRole`、`hasJDText`、`requestJDText` 等现有信息。
- `npm run typecheck` 通过。
- `npm test` 通过。

## 给 Codex 的简化 Prompt

```text
请将 AgentOrchestrator 中的 buildAgentContext 上下文组装逻辑抽离为 ContextAssemblyPipeline。保持 AgentContext 字段、Copilot response、AgentDecisionSchema、ToolDefinition、ProductBlock 全部不变。新增的 context provider/capability 输出只能进入内部 productContext 命名空间，默认不改变现有行为。完成后运行 typecheck 和 tests。
```

## Phase 3 完成情况（2026-06-14）

### 已完成

- 新增 `src/agent-core/context/ContextAssemblyPipeline.ts`，承接原 `AgentOrchestrator.buildAgentContext()` 中的上下文组装逻辑。
- 新增 `src/agent-core/context/ContextAssemblyInput.ts`，集中定义 context assembly 的输入与 pipeline 依赖类型。
- 新增 `src/agent-core/context/ContextProvider.ts`，作为新的 context provider 类型入口。
- 将 `src/agent-core/memory/ContextProvider.ts` 改为兼容 re-export，旧 import 路径继续可用。
- 新增 `src/agent-core/context/BaseContextProvider.ts` 与 `src/agent-core/context/ContextBudgetManager.ts`，为后续上下文 provider 和 token budget 管理预留内部位置；本阶段默认不接入运行路径。
- `AgentOrchestrator.buildAgentContext()` 已变薄，改为委托 `ContextAssemblyPipeline.assemble()`，调用点和返回 `RunState` 字段保持不变。
- `ContextAssemblyPipeline` 保持原有字段组装：workspace、recentMessages、trace、messageBus、loopController、activeAssetContext、userAssetContext、productContext、availableTools。
- capability context provider 输出只会进入 `productContext.capabilities.context`；默认 `core.noop` 下没有 providers，因此现有 `productContext` 保持原样。
- 新增 `tests/ContextAssemblyPipeline.test.ts`，覆盖默认 Noop 不改变 `productContext`，以及 provider 输出不会泄漏到 `productContext` 根层级。

### 验证结果

- `npm run typecheck` 通过。
- `npx vitest run tests/ContextAssemblyPipeline.test.ts tests/agentContractFreeze.test.ts tests/agentRuntimeLoopAndCritic.test.ts` 通过：3 test files passed，23 tests passed。
- `npm test` 通过：54 test files passed，535 tests passed。

### 变更范围确认

- 未修改 `AgentContext` 字段名或结构。
- 未修改 Copilot response、SSE envelope、`AgentDecisionSchema`、`ToolDefinition`、`ToolResult`、`ProductBlock` 或 prompt。
- 未接入真实 retrieval/RAG、memory、reflection 或 evaluation。
- `BaseAgent.buildPayload()` 未改动；默认运行时不会新增 `productContext.capabilities`。
- 已检查非测试代码中本阶段新增/触达文件没有引入测试替身形式或测试替身命名。

---

# Phase 4：引入 Retrieval 与 Evidence 内部接口

## 目标

让系统变成 RAG-ready，但不在本阶段接真实 RAG。

这一阶段只定义接口与 Noop 实现，为未来经历库向量检索、JD 检索、简历版本检索、对话历史检索、知识图谱检索、技能盲区检测做准备。

## 要做什么

新增目录：

```text
src/agent-core/retrieval
src/agent-core/evidence
```

### Retrieval 接口建议

```ts
type RetrievalScope =
  | "experience"
  | "jd"
  | "resume"
  | "conversation"
  | "file"
  | "strategy_memory"
  | "skill_graph";

type RetrievalQuery = {
  userId: string;
  sessionId?: string;
  turnId?: string;
  query: string;
  scopes: RetrievalScope[];
  limit?: number;
  constraints?: Record<string, unknown>;
};

type RetrievalResult = {
  id: string;
  scope: RetrievalScope;
  sourceId?: string;
  title?: string;
  text: string;
  score?: number;
  metadata?: Record<string, unknown>;
  evidence?: EvidenceItem[];
};

interface RetrievalProvider {
  id: string;
  supports(scope: RetrievalScope): boolean;
  retrieve(query: RetrievalQuery): Promise<RetrievalResult[]>;
}
```

### Evidence 接口建议

```ts
type EvidenceItem = {
  id: string;
  sourceType: "experience" | "jd" | "resume" | "conversation" | "file" | "system";
  sourceId?: string;
  text?: string;
  span?: { start?: number; end?: number };
  confidence?: number;
  usage?: "support" | "risk" | "missing" | "preference" | "feedback";
  metadata?: Record<string, unknown>;
};

type EvidenceBundle = {
  items: EvidenceItem[];
  summary?: string;
  missing?: string[];
  risks?: string[];
};
```

### Noop 实现

新增：

```text
NoopRetrievalProvider.ts
EvidenceNormalizer.ts
```

`NoopRetrievalProvider.retrieve()` 返回 `[]`。

## 重要要求

- 不要把 retrieval 结果直接塞进 prompt，除非通过 ContextAssemblyPipeline 的 Noop namespace。
- 不要接向量数据库。
- 不要修改任何 product service。
- 不要改变工具输出。

## 验收标准

- capability registry 可以注册 retrieval providers。
- ContextAssemblyPipeline 可以看到 retrieval providers，但默认不调用或只调用 Noop。
- 所有 tests 通过。

## 给 Codex 的简化 Prompt

```text
请新增 agent-core/retrieval 与 agent-core/evidence 的内部接口和 Noop 实现，使系统具备未来接入 RAG 和证据追踪的架构插槽。不要接真实向量库，不要改变任何 API、response、ToolDefinition、AgentDecisionSchema、ProductBlock 或现有业务行为。完成后运行 typecheck 和 tests。
```

## Phase 4 完成情况（2026-06-14）

### 已完成

- 新增 `src/agent-core/retrieval/RetrievalScope.ts`，定义内部 retrieval scope：experience、jd、resume、conversation、file、strategy_memory、skill_graph。
- 新增 `src/agent-core/retrieval/RetrievalQuery.ts`、`RetrievalResult.ts`、`RetrievalProvider.ts`，沉淀未来 RAG 接入所需的查询、结果、provider 接口。
- 新增 `src/agent-core/retrieval/NoopRetrievalProvider.ts`，默认 `supports()` 返回 `false`，`retrieve()` 返回空数组。
- 新增 `src/agent-core/retrieval/index.ts`，集中导出 retrieval 内部接口。
- 新增 `src/agent-core/evidence/EvidenceItem.ts`、`EvidenceBundle.ts`，定义证据条目、证据用途、证据 bundle 的内部 contract。
- 新增 `src/agent-core/evidence/EvidenceNormalizer.ts`，提供 Noop 风格的证据归一化入口：默认空输入返回 `{ items: [] }`，已有 bundle/数组只做浅复制，不触发业务副作用。
- 新增 `src/agent-core/evidence/index.ts`，集中导出 evidence 内部接口。
- 将 `AgentCapabilityModule` 的 `retrievalProviders` 从临时占位类型替换为正式 `RetrievalProvider` 接口。
- `defaultCapabilities` 的 `core.noop` module 注册 `NoopRetrievalProvider`，使 capability registry 已具备 retrieval provider 插槽；运行路径默认不调用 retrieval。
- 新增 `tests/RetrievalEvidenceInterfaces.test.ts`，覆盖 Noop retrieval、RetrievalResult 携带 EvidenceItem、EvidenceNormalizer 行为。
- 更新 `tests/AgentCapabilityRegistry.test.ts`，覆盖默认 Noop retrieval provider 注册与聚合。

### 验证结果

- `npm run typecheck` 通过。
- `npx vitest run tests/AgentCapabilityRegistry.test.ts tests/RetrievalEvidenceInterfaces.test.ts tests/agentContractFreeze.test.ts tests/ContextAssemblyPipeline.test.ts` 通过：4 test files passed，15 tests passed。
- `npm test` 通过：55 test files passed，538 tests passed。

### 变更范围确认

- 未接入真实向量库、数据库、RAG 服务或外部检索源。
- 未把 retrieval 结果塞进 prompt，也未改变 ContextAssemblyPipeline 的默认输出。
- 未修改任何 product service、tool 输出、API route、request/response envelope、`AgentDecisionSchema`、`ToolDefinition`、`ToolResult`、`ProductBlock` 或 prompt。
- 默认 retrieval provider 为 Noop，不改变现有业务行为。
- 已检查非测试代码中本阶段新增/触达文件没有引入测试替身形式或测试替身命名。

---

# Phase 5：引入 Memory / Reflection / Evaluation 内部接口

## 目标

让系统变成 self-evolution-ready，但不实现复杂自我学习算法。

这一阶段只沉淀内部事件和接口，让未来可以记录：

- 用户接受了哪个 variant
- 用户拒绝了哪个 variant
- 用户要求更保守 / 更量化
- 哪个工具失败
- 哪个 agent 反复需要 revision
- 哪条经历经常被匹配
- 哪个 JD 缺少证据
- 哪类技能是盲区

## 要做什么

新增目录：

```text
src/agent-core/memory
src/agent-core/reflection
src/agent-core/evaluation
```

如果现有 `src/agent-core/memory` 已存在，则保留 README，并补充正式接口。

### MemoryProvider 建议

```ts
type MemoryRecord = {
  id: string;
  userId: string;
  type: "preference" | "strategy" | "feedback" | "summary" | "skill_gap" | "system";
  text: string;
  weight?: number;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

interface MemoryProvider {
  id: string;
  retrieve(input: { userId: string; query: string; limit?: number }): Promise<MemoryRecord[]>;
  remember?(record: MemoryRecord): Promise<void>;
}
```

### LearningEvent 建议

```ts
type LearningEventType =
  | "variant.accepted"
  | "variant.rejected"
  | "variant.revised"
  | "experience.saved"
  | "experience.updated"
  | "jd.saved"
  | "tool.failed"
  | "critic.needs_revision"
  | "critic.blocked"
  | "generation.completed"
  | "export.completed"
  | "user.preference_signal";

type LearningEvent = {
  id: string;
  type: LearningEventType;
  userId: string;
  sessionId?: string;
  turnId?: string;
  source?: string;
  payload?: Record<string, unknown>;
  evidence?: EvidenceItem[];
  createdAt: string;
};
```

### ReflectionSink 建议

```ts
interface ReflectionSink {
  id: string;
  record(event: LearningEvent): Promise<void>;
}
```

### EvaluationHook 建议

```ts
interface EvaluationHook {
  id: string;
  beforeRun?(input: EvaluationRunInput): Promise<void>;
  afterRun?(output: EvaluationRunOutput): Promise<void>;
  onToolResult?(result: EvaluationToolResult): Promise<void>;
  onCriticReview?(review: EvaluationCriticReview): Promise<void>;
}
```

### 默认实现

新增：

```text
NoopMemoryProvider.ts
NoopReflectionSink.ts
NoopEvaluationHook.ts
LearningEventRecorder.ts
```

`LearningEventRecorder` 初期只把事件送到 sinks，默认 sink 不做任何持久化。

## 不做什么

- 不写入数据库。
- 不改变用户数据模型。
- 不新增迁移。
- 不让 agent 行为因为 memory 发生变化。
- 不实现真正 self-evolution。

## 验收标准

- 能在运行过程中安全 record learning event，但默认无副作用。
- 能在后续阶段从 action / critic / tool result 中采集事件。
- 不影响现有返回。
- 所有 tests 通过。

## 给 Codex 的简化 Prompt

```text
请新增 agent-core/memory、agent-core/reflection、agent-core/evaluation 的内部接口和 Noop 实现，定义 MemoryProvider、LearningEvent、ReflectionSink、EvaluationHook、LearningEventRecorder。当前不要持久化、不要改变业务行为、不要改变任何 API/contract，只为未来 self-evolution 和反馈学习预留架构插槽。完成后运行 typecheck 和 tests。
```

## Phase 5 完成情况（2026-06-14）

### 已完成

- 新增 `src/agent-core/memory/MemoryRecord.ts`，定义内部 memory record 类型与 record 分类。
- 新增 `src/agent-core/memory/MemoryProvider.ts`，定义 `MemoryProvider` 与 retrieval input。
- 新增 `src/agent-core/memory/NoopMemoryProvider.ts`，默认 `retrieve()` 返回空数组，`remember()` 不做持久化。
- 新增 `src/agent-core/memory/index.ts`，集中导出现有 context providers 与新增 memory 接口。
- 新增 `src/agent-core/reflection/LearningEvent.ts`，定义 `LearningEvent` 与 `LearningEventType`。
- 新增 `src/agent-core/reflection/ReflectionSink.ts` 与 `NoopReflectionSink.ts`，默认 sink 不做持久化。
- 新增 `src/agent-core/reflection/LearningEventRecorder.ts`，提供 best-effort event recorder：向 sinks 投递事件并收集 delivered/failed 结果，不抛出 sink 失败。
- 新增 `src/agent-core/reflection/index.ts`，集中导出 reflection 内部接口。
- 新增 `src/agent-core/evaluation/EvaluationHook.ts`，定义 `EvaluationHook` 与 run/tool/critic hook 输入类型。
- 新增 `src/agent-core/evaluation/NoopEvaluationHook.ts`，默认 hook 方法全部无副作用。
- 新增 `src/agent-core/evaluation/index.ts`，集中导出 evaluation 内部接口。
- 将 `AgentCapabilityModule` 中的 memory/reflection/evaluation 临时占位类型替换为正式 `MemoryProvider`、`ReflectionSink`、`EvaluationHook`。
- `defaultCapabilities` 的 `core.noop` module 注册 `NoopMemoryProvider`、`NoopReflectionSink`、`NoopEvaluationHook`。
- 新增 `tests/MemoryReflectionEvaluationInterfaces.test.ts`，覆盖 Noop memory、LearningEventRecorder、Noop reflection/evaluation 行为。
- 更新 `tests/AgentCapabilityRegistry.test.ts`，覆盖默认 Noop memory/reflection/evaluation 注册与聚合。

### 验证结果

- `npm run typecheck` 通过。
- `npx vitest run tests/AgentCapabilityRegistry.test.ts tests/MemoryReflectionEvaluationInterfaces.test.ts tests/agentContractFreeze.test.ts` 通过：3 test files passed，13 tests passed。
- `npm test` 通过：56 test files passed，541 tests passed。

### 变更范围确认

- 未写入数据库，未新增迁移，未改变用户数据模型。
- 未把 memory/reflection/evaluation 接入 agent 决策、prompt、tool execution、critic review 或 response assembly。
- 未修改 API route、request/response envelope、`AgentDecisionSchema`、`ToolDefinition`、`ToolResult`、`ProductBlock` 或 prompt。
- 默认 memory/reflection/evaluation 全部为 Noop，不改变现有业务行为。
- 已检查非测试代码中本阶段新增/触达文件没有引入测试替身形式或测试替身命名。

---

# Phase 6：拆分 Plan Execution Service

## 目标

把 plan step 执行、tool 执行、pending action 创建、tool schema hydration、scope guard、ID guard 等逻辑从 `AgentOrchestrator` 中抽离。

## 要做什么

新增：

```text
src/agent-core/runtime/PlanExecutionService.ts
src/agent-core/runtime/ToolExecutionPolicy.ts
```

`PlanExecutionService` 负责：

- 执行 plan steps。
- 对每个 step 执行 tool 或创建 pending action。
- 调用 `ToolExecutor`。
- 应用 `ContextHydrator`。
- 应用 `guardToolIds`。
- 应用 `guardToolScope`。
- 应用 `stripInternalToolArgs`。
- 处理 `requiresConfirmation`。
- 处理 pending action preview。
- 返回 `ExecutedPlan`。

`AgentOrchestrator` 只保留调用：

```ts
const executed = await this.planExecutionService.executePlan(run, decision.plan);
```

## 重要要求

- 不改变任何 tool 执行结果。
- 不改变 pending action 创建结构。
- 不改变 confirmation preview。
- 不改变 requiresConfirmation 行为。
- 不改变工具失败时 break 的语义。

## 验收标准

- `AgentOrchestrator.executePlan()` 和 `executeToolOrCreatePendingAction()` 相关逻辑明显减少。
- 所有现有 action tests 通过。
- pending action tests 通过。
- critic review 仍能接收到 `ToolExecutionRecord`。

## 给 Codex 的简化 Prompt

```text
请把 AgentOrchestrator 中的 plan/tool/pending action 执行逻辑抽离到 PlanExecutionService，保持所有 tool execution、requiresConfirmation、pending action preview、ID guard、scope guard、hydration、ToolResult 行为完全不变。不要改 ToolDefinition、ToolResult、AgentDecisionSchema、API 或 ProductBlock。完成后运行 typecheck 和 tests。
```

## Phase 6 完成情况

### 已完成

- 新增 `src/agent-core/runtime/PlanExecutionService.ts`，承接 plan step 执行、tool execution、hydration、ID guard、scope guard、`requiresConfirmation` 判断、pending action 创建、pending action preview、ToolResult visibility 归一与 `ExecutedPlan` 返回。
- 新增 `src/agent-core/runtime/ToolExecutionPolicy.ts`，以现有 `requiresConfirmation` 与内部 auto-revision 授权规则为唯一判断来源，不引入新的执行策略。
- `AgentOrchestrator.executePlan()` 已改为委托 `PlanExecutionService.executePlan()`，`AgentOrchestrator` 不再保留 plan/tool/pending action 执行主体逻辑。
- 保留 `AgentOrchestrator` 现有 observation、public agent message、prepare save experience、prepared resume rewrite 等内部协作点，通过回调注入 `PlanExecutionService`，保证上下文写入和 pending action preview 行为不变。
- `sanitizeReadToolConfirmationResult` 与 `ensureToolResultVisibility` 迁入 runtime service 层，其中 `sanitizeReadToolConfirmationResult` 继续从 `AgentOrchestrator` re-export，保持现有测试/内部引用兼容。

### 验证结果

- `npm run typecheck` 通过。
- `npx vitest run tests/agentContractFreeze.test.ts tests/copilotExplicitActions.test.ts tests/generateResumePendingFlow.test.ts tests/prepareUpdateExperienceFix.test.ts tests/securityFollowup.test.ts tests/agentRuntimeLoopAndCritic.test.ts` 通过：6 test files passed，57 tests passed。
- `npm test` 通过：56 test files passed，541 tests passed。

### 变更范围确认

- 未修改 `ToolDefinition`、`ToolResult`、`AgentDecisionSchema`、API route/request/response envelope 或 `ProductBlock`。
- 未改变 tool execution、`requiresConfirmation`、pending action preview、ID guard、scope guard、hydration、ToolResult visibility 或失败时 break 的既有语义。
- 未接入新的外部数据源、持久化或真实检索逻辑。
- 已检查非测试代码中本阶段新增/触达文件没有引入测试替身形式或测试替身命名。

---

# Phase 7：拆分 Agent Decision Runner 与 Review Pipeline

## 目标

把 agent decision 调用、trace、routing、critic review、revision request 相关逻辑分层。

## 要做什么

新增：

```text
src/agent-core/runtime/AgentDecisionRunner.ts
src/agent-core/runtime/ReviewPipeline.ts
src/agent-core/evaluation/ReviewPolicy.ts
```

### AgentDecisionRunner

负责：

- 调用 `agent.decide()`。
- 注入 routeHint / task。
- 记录 trace。
- 记录 decision meta。
- 处理 decision 失败或 fallback。

注意：不要改变 `BaseAgent.decide()` contract。

### ReviewPipeline

包装当前 `CriticGate`：

- 根据 ReviewPolicy 判断是否 review。
- 调用 CriticGate。
- 记录 evaluation hook。
- 产生 learning event，例如：
  - `critic.needs_revision`
  - `critic.blocked`
  - `critic.needs_user_confirmation`
- 返回与当前相同的 review result。

### ReviewPolicy

初期只是包装现有 `shouldReviewTool()` 规则。

未来可以演进为：

- 根据工具风险等级 review。
- 根据 evidence 缺失 review。
- 根据用户偏好 review。
- 根据生成类型 review。

## 不做什么

- 不改变 critic prompt。
- 不改变 CriticReviewSchema。
- 不改变 revision loop 最大次数。
- 不改变 blocked / needs_user_confirmation / pass 的行为。

## 验收标准

- CriticGate 行为保持一致。
- revision loop 行为保持一致。
- 新 ReviewPipeline 可以接 evaluation / reflection，但默认 Noop。
- 所有 tests 通过。

## 给 Codex 的简化 Prompt

```text
请新增 AgentDecisionRunner 和 ReviewPipeline，把 agent.decide 调用与 CriticGate review 从 AgentOrchestrator 中抽离出来。ReviewPolicy 初期必须完全等价于现有 shouldReviewTool 规则。不要改变 AgentDecisionSchema、CriticReviewSchema、critic 行为、revision loop、API 或 ProductBlock。完成后运行 typecheck 和 tests。
```

## Phase 7 完成情况

### 已完成

- 新增 `src/agent-core/runtime/AgentDecisionRunner.ts`，统一封装 `agent.decide()` 调用、`routeHint` / `task` 透传、decision meta 读取与 decision trace completion。
- 新增 `src/agent-core/runtime/ReviewPipeline.ts`，包装当前 `CriticGate` review 调用，并预留 evaluation hook 与 learning event recorder 接入点。
- 新增 `src/agent-core/evaluation/ReviewPolicy.ts`，以现有 critic review 工具集合为唯一规则来源；`CriticGate.shouldReviewTool()` 继续作为兼容导出并委托 `defaultReviewPolicy`。
- `AgentOrchestrator` 中 frontdesk/specialist 的直接 `agent.decide()` 调用已改为 `AgentDecisionRunner`，原 trace/event 写入位置和 metadata 内容保持不变。
- `AgentOrchestrator` 中 specialist loop 与 pending action confirmation 的 critic review 调用已改为 `ReviewPipeline.review()`，revision loop、retry 上限、blocked / needs_user_confirmation / needs_revision / pass 分支保持不变。
- `CriticGate` 内部 critic agent 的两次 `decide()` 调用已改为通过 `AgentDecisionRunner`，critic prompt、`CriticReviewSchema` 解析与 conservative fallback 行为保持不变。
- `Planner` 改为可注入并默认使用 `AgentDecisionRunner`，保持返回已验证 plan 的行为不变。
- `LearningEvent` 内部类型补充 `critic.needs_user_confirmation`，供 `ReviewPipeline` 未来记录使用；默认 Noop/空 recorder 不改变业务行为。

### 验证结果

- `npm run typecheck` 通过。
- `npx vitest run tests/agentRuntimeLoopAndCritic.test.ts tests/agentContractFreeze.test.ts tests/copilotConfirmContract.test.ts tests/generateResumePendingFlow.test.ts tests/agentDecisionReliability.test.ts tests/agentPromptContract.test.ts` 通过：6 test files passed，55 tests passed。
- `npm test` 通过：56 test files passed，541 tests passed。

### 变更范围确认

- 未修改 `AgentDecisionSchema`、`CriticReviewSchema`、critic prompt、revision loop 最大次数、API route/request/response envelope 或 `ProductBlock`。
- ReviewPolicy 初期规则与原 `shouldReviewTool()` 等价：仅 review `generate_resume_from_jd`、`revise_resume_item`、`save_experience_from_text`、`update_experience`。
- 默认 evaluation/reflection 接入点不产生新的持久化、外部调用或用户可见行为。
- 已检查非测试代码中本阶段新增/触达文件没有引入测试替身内容或测试替身命名。

---

# Phase 8：拆分 Result Assembly

## 目标

把 workspace patch、ProductBlock、AgentRoomEvent、ResponseComposer、metadata/displaySnapshot 组装逻辑从 Orchestrator 中抽离。

## 要做什么

新增：

```text
src/agent-core/runtime/AgentResultAssembler.ts
src/agent-core/runtime/AssistantMessageProjector.ts
```

`AgentResultAssembler` 负责：

- 调用 `mergeWorkspacePatch()`。
- 调用 `buildProductBlocks()`。
- 调用 `buildWorkspaceSnapshot()`。
- 调用 `buildRelatedResourceIds()`。
- 调用 `projectAgentRoomEvents()`。
- 调用 `ResponseComposer.compose()`。
- 生成 assistant message metadata。
- 生成 displaySnapshot。
- 返回 `CopilotChatResponse` 所需内部结构。

`AgentOrchestrator.finishRun()` 应变薄。

## 重要要求

- 不改变 `buildProductBlocks()` 的输出 contract。
- 不改变 metadata 字段。
- 不改变 displaySnapshot 字段。
- 不改变 AgentRoomEvent 投影。
- 不改变 assistant message save 逻辑的外部结果。

## 验收标准

- `finishRun()` 更短，只负责调用 assembler、保存 message、保存 workspace、complete turn。
- 历史恢复仍正常。
- 前端卡片仍正常。
- 所有 tests 通过。

## 给 Codex 的简化 Prompt

```text
请把 AgentOrchestrator.finishRun 中的 response/productBlocks/workspacePatch/displaySnapshot/AgentRoomEvent/metadata 组装逻辑抽离到 AgentResultAssembler，保持 CopilotChatResponse、metadata、ProductBlock、displaySnapshot、AgentRoomEvent 完全兼容。不要改前端 contract。完成后运行 typecheck 和 tests。
```

---

# Phase 9：Domain / Agent Manifest 内部增强

## 目标

提升工程扩展性，让未来新增 agent/domain 更容易，但不破坏现有 `AgentNameSchema` 和 agent 输出格式。

## 要做什么

新增：

```text
src/agent-core/domain/AgentManifest.ts
```

建议内部 manifest：

```ts
type AgentManifest = {
  name: AgentName;
  domainId: string;
  roleLabel?: Record<string, string>;
  description?: string;
  promptKey?: string;
  allowedTools: string[];
  capabilities?: string[];
  intents?: string[];
};
```

增强 `AgentDomainModule`，但保持兼容：

```ts
type AgentDomainModule = {
  id: string;
  agents?: readonly AgentFactory[];
  tools?: readonly ToolDefinition[];
  manifests?: readonly AgentManifest[];
  capabilities?: readonly AgentCapabilityModule[];
};
```

注意：`manifests` 和 `capabilities` 是新增 optional 字段，不破坏现有 domain module。

`AgentDomainRegistry` 可增加：

- `listAgentManifests()`
- `listTools()`
- `listCapabilities()`

## 不做什么

- 不新增新的 AgentName。
- 不改变现有五个 agent。
- 不改变 prompt 加载方式。
- 不改变 allowedTools 行为。

## 验收标准

- careerDomain 可以选择性提供 manifests。
- 没提供 manifest 时系统仍正常。
- 所有 tests 通过。

## 给 Codex 的简化 Prompt

```text
请为 AgentDomainModule 增加 optional 的 AgentManifest 与 capabilities 支持，增强 AgentDomainRegistry 的 list 能力，但不要改变现有 AgentNameSchema、AgentFactory、ToolDefinition、prompt、allowedTools 或 runtime 行为。所有新增字段必须 optional 并向后兼容。完成后运行 typecheck 和 tests。
```

---

# Phase 10：内部 Learning Event 采集点接入

## 目标

在不改变业务行为的前提下，把关键操作转成内部 learning events，送入 Noop ReflectionSink / EvaluationHook。

## 可以采集的事件

### Tool 执行类

- tool success
- tool failed
- tool needs_input
- pending action created
- pending action confirmed
- pending action cancelled

### Product 类

- experience saved
- experience updated
- jd saved
- resume generated
- variant accepted
- resume exported

### Critic 类

- critic pass
- critic needs_revision
- critic blocked
- critic needs_user_confirmation

### 用户偏好类

- `revise_more_conservative`
- `revise_more_quantified`
- `confirm_metric`
- `prefer`
- `reject`

## 要做什么

1. 在 `PlanExecutionService` 中记录 tool-level events。
2. 在 `ReviewPipeline` 中记录 critic-level events。
3. 在 `handleExplicitAction` / action mapping 或 result assembly 附近记录 user preference events。
4. 所有事件都进入 `LearningEventRecorder`。
5. 默认 sink 是 Noop，不落库，不改变行为。

## 重要要求

- 事件记录失败不能影响主流程。
- 默认不暴露给前端。
- 不引入数据库迁移。
- 不改变 response。

## 验收标准

- 测试中可以用 fake reflection sink 验证事件被记录。
- 默认运行下无额外副作用。
- 所有 tests 通过。

## 给 Codex 的简化 Prompt

```text
请在内部接入 LearningEventRecorder，采集 tool result、pending action、critic review、variant/user preference 等关键事件。默认 ReflectionSink/EvaluationHook 必须是 Noop，事件记录失败不得影响主流程，不得改变任何 API、response、ProductBlock、ToolResult 或 AgentDecisionSchema。完成后运行 typecheck 和 tests。
```

---

# Phase 11：Product Flow 与 Agent Runtime 边界整理

## 目标

为未来“产品状态机 + Agent 智能决策”打基础，但本阶段不改变前端接口和用户体验。

现在显式 action mapping 和 chat routing 混在 Orchestrator 中，未来产品级稳定流程需要更清晰的 flow boundary。

## 要做什么

新增：

```text
src/agent-core/flow/ProductFlowRouter.ts
src/agent-core/flow/ExplicitActionMapper.ts
src/agent-core/flow/FlowIntent.ts
```

迁移内容：

- `mapExplicitAction()` 从 Orchestrator 抽离到 `ExplicitActionMapper`。
- chat 中一些确定性 intent 识别可以先不迁移，或者只建立空壳。
- `ProductFlowRouter` 初期只包装已有逻辑，不改变行为。

## 重要要求

- 不改变 `/copilot/actions` 行为。
- 不改变 action type。
- 不改变 `ProductActionType`。
- 不改变 needs_input / unsupported / step 的现有返回语义。

## 验收标准

- action mapping 单独可测试。
- Orchestrator 中 action mapping 逻辑减少。
- 所有 action contract tests 通过。

## 给 Codex 的简化 Prompt

```text
请把 AgentOrchestrator 中的 explicit action mapping 抽离到 agent-core/flow/ExplicitActionMapper，并预留 ProductFlowRouter/FlowIntent 内部结构。保持所有 ProductActionType、/copilot/actions 行为、needs_input/unsupported/step 语义、response contract 完全不变。完成后运行 typecheck 和 tests。
```

---

# Phase 12：文档、架构图与开发者指南

## 目标

重构完成后，补充内部架构文档，让后续每次新增能力都知道放在哪里。

## 要做什么

新增或更新：

```text
docs/agent-internal-architecture-v2.md
docs/agent-extension-guide.md
docs/agent-capability-layer.md
```

文档应说明：

1. 什么属于 public contract，不能随便改。
2. 什么属于 internal extension point。
3. 如何新增 ContextProvider。
4. 如何新增 RetrievalProvider。
5. 如何新增 MemoryProvider。
6. 如何新增 ReflectionSink。
7. 如何新增 EvaluationHook。
8. 如何新增 EvidenceNormalizer。
9. 如何新增 Tool。
10. 如何新增 Domain。
11. 如何验证没有破坏前端 contract。

## 验收标准

- 文档能让下一个开发者不读完整 Orchestrator 也知道架构。
- 文档明确禁止直接往 Orchestrator 塞 RAG / memory / reflection 逻辑。
- 所有 tests 通过。

## 给 Codex 的简化 Prompt

```text
请为本轮 Agent 内部架构重构补充 docs，包括 agent-internal-architecture-v2、agent-extension-guide、agent-capability-layer。文档要说明 public contract 边界、internal extension points，以及未来如何新增 ContextProvider、RetrievalProvider、MemoryProvider、ReflectionSink、EvaluationHook、EvidenceNormalizer、Tool、Domain。不要改代码行为。完成后运行 typecheck 和 tests。
```

---

## 5. 推荐执行顺序

建议不要一次性让 Codex 做完整重构。

推荐顺序：

```text
Phase 0  Contract Freeze
Phase 1  RunState 类型整理
Phase 2  Capability Registry
Phase 3  Context Assembly Pipeline
Phase 4  Retrieval + Evidence 接口
Phase 5  Memory + Reflection + Evaluation 接口
Phase 6  PlanExecutionService
Phase 7  AgentDecisionRunner + ReviewPipeline
Phase 8  AgentResultAssembler
Phase 9  AgentManifest / Domain 增强
Phase 10 LearningEvent 采集
Phase 11 ProductFlowRouter / ExplicitActionMapper
Phase 12 文档
```

每个阶段都应该单独提交，单独测试。

---

## 6. 每阶段共同验收标准

每个阶段完成后都必须满足：

```bash
npm run typecheck
npm test
```

并且检查：

1. 没有修改前端仓库。
2. 没有修改 API route path。
3. 没有修改 request/response envelope。
4. 没有删除现有 ProductBlock 类型。
5. 没有删除现有 AgentName。
6. 没有改 `ToolDefinition` 必填字段。
7. 没有改 `AgentDecisionSchema` 输出结构。
8. 没有改变 pending action confirmation 语义。
9. 没有把 RAG / memory / reflection 硬写进 Orchestrator。
10. 没有引入数据库迁移，除非后续阶段明确允许。

---

## 7. 本轮重构后应该达到的架构质量

### 7.1 AgentOrchestrator 变成 Facade / Coordinator

它仍然保留现有 public methods：

```ts
handleChat()
handleChatStream()
handleExplicitAction()
confirmPendingAction()
getSession()
```

但内部主要委托给：

- ContextAssemblyPipeline
- AgentDecisionRunner
- PlanExecutionService
- ReviewPipeline
- AgentResultAssembler
- LearningEventRecorder

### 7.2 RAG-ready

未来接入 RAG 时，不应该改 Orchestrator，而是新增：

```text
ExperienceVectorRetrievalProvider
JDKeywordRetrievalProvider
ConversationHistoryRetrievalProvider
SkillGraphRetrievalProvider
```

然后注册进 CapabilityRegistry。

### 7.3 Memory-ready

未来接入长期记忆时，不应该直接查数据库拼 prompt，而是实现：

```text
UserPreferenceMemoryProvider
StrategyMemoryProvider
FeedbackMemoryProvider
```

然后由 ContextAssemblyPipeline 注入相关摘要。

### 7.4 Reflection-ready

未来做 self-evolution 时，不应该在 critic 里硬写学习逻辑，而是让：

```text
LearningEventRecorder -> ReflectionSink -> MemoryProvider / StrategyStore
```

形成闭环。

### 7.5 Evaluation-ready

未来要比较新 RAG、新 prompt、新 reranker、新 agent 策略时，可以通过 EvaluationHook 采集：

- route latency
- tool count
- loop count
- critic revision count
- pending confirmation count
- user accept/reject
- generation success/failure
- evidence coverage

---

## 8. 最终架构与用户提供架构图的对应关系

用户图中的五层可以映射为：

### 第一层：数据采集与感知层

对应后端未来：

- file import tools
- experience import tools
- MCP connector adapters
- ingestion pipeline
- Evidence source registry

本轮只预留 Retrieval/Evidence 接口，不扩展 MCP。

### 第二层：结构化知识库

对应后端未来：

- RetrievalProvider
- MemoryProvider
- EvidenceBundle
- skill graph provider
- version stream provider
- recency decay provider

本轮先定义接口。

### 第三层：逻辑推理与策略层

对应现有：

- frontdesk
- experience_receiver
- strategist
- architect
- critic
- specialist loop
- CriticGate

本轮重构为：

- AgentDecisionRunner
- PlanExecutionService
- ReviewPipeline
- ProductFlowRouter

### 第四层：表现层

对应现有：

- ProductBlockPresenter
- ResponseComposer
- AgentRoomEventProjector
- ProductVariant
- export service

本轮通过 AgentResultAssembler 整理。

### 第五层：自我进化层

对应未来：

- LearningEventRecorder
- ReflectionSink
- EvaluationHook
- MemoryProvider
- skill gap signal
- effectiveness feedback

本轮只建立 Noop 能力层和事件采集点。

---

## 9. 风险与控制

### 风险 1：一次性重构太大，破坏现有流程

控制方式：严格分阶段，每阶段独立测试，先 contract freeze。

### 风险 2：抽象过度，代码变复杂但没有收益

控制方式：所有新接口初期只服务两个目标：减少 Orchestrator 职责、为 RAG/Memory/Reflection/Evaluation 预留插槽。不要做无用抽象。

### 风险 3：Codex 改着改着顺手改 contract

控制方式：每个 prompt 都写明不允许改 API/schema/ProductBlock/ToolDefinition/AgentDecisionSchema，并依靠 Phase 0 tests 防守。

### 风险 4：Noop 能力没有价值

Noop 的价值不是功能，而是边界。先把边界建好，未来真实 RAG / self-evolution 才能低风险接入。

### 风险 5：LearningEvent 采集影响主流程

控制方式：LearningEventRecorder 必须 best-effort，所有 sink 失败都 swallow 并记录 trace，不影响用户请求。

---

## 10. 最推荐的第一轮执行内容

如果你现在只想先给 Codex 一个小范围 prompt，我建议先做 Phase 0 + Phase 1。

第一轮不要直接拆 Orchestrator。

第一轮目标：

1. 锁定 contract。
2. 抽离内部类型。
3. 为后续大改降低风险。

第一轮 prompt：

```text
你是一名专业的 TypeScript 后端架构工程师。请在 JsChen766/cv-agent 仓库中执行 Agent 内部架构重构的第一阶段：Contract Freeze + Runtime 类型整理。

要求：
1. 不修改任何 API route、request/response contract、AgentDecisionSchema、ToolDefinition、ProductBlock、PendingAction、CopilotChatResponse。
2. 新增 contract freeze 测试，覆盖 /copilot/chat、/copilot/actions、pending action confirmation、AgentDecisionSchema、ToolDefinition、ProductBlock、CopilotChatResponse 的基础兼容性。
3. 将 AgentOrchestrator.ts 内部的 RunState、ExecutedPlan、LoopRunResult、AutoRevisionContext 等内部类型抽离到独立 runtime type 文件。
4. 不改变任何运行逻辑，不改 prompt，不改前端仓库。
5. 完成后运行 npm run typecheck 和 npm test。
6. 输出修改文件列表、测试结果、确认没有破坏现有 contract。
```

---

## 11. 本计划的最终一句话总结

本轮重构的目标不是让 Agent 立刻拥有 RAG 或 self-evolution，而是让后端具备未来自然接入这些能力的架构位置。

最终后端应该从：

```text
AgentOrchestrator 里塞所有智能逻辑
```

升级为：

```text
AgentOrchestrator 负责协调
ContextPipeline 负责上下文
RetrievalLayer 负责检索
EvidenceLayer 负责证据
MemoryLayer 负责长期记忆
ReflectionLayer 负责学习事件
EvaluationLayer 负责质量度量
PlanExecutionService 负责执行
ReviewPipeline 负责审查
ResultAssembler 负责输出
```

这样才能在不破坏现有产品的前提下，让 Coolto / 库投后端真正具备工程扩展性和智能能力扩展性。
