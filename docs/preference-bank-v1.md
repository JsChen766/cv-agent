# PreferenceBank v1

## 1. 目标

PreferenceBank 是 CV-Agent 面向用户的自我演化模块。它不搜索 agent workflow，不修改 reasoning strategy，也不更新模型参数。它持续学习用户在不同申请场景中的简历偏好，并将这些偏好用于后续检索、经历排序、写作规则组合和简历生成。

三类核心能力的职责如下：

```text
Guideline RAG  回答专业上应该怎么写
Evidence RAG   回答基于真实经历能够写什么
PreferenceBank 回答当前用户在当前场景下更偏好怎么写
```

事实边界始终由 Evidence RAG 和系统硬约束决定。PreferenceBank 只能做软约束、排序和表达偏好，不得增加未经证实的事实。

## 2. 与内部架构 Phase 4 和 Phase 10 的关系

PreferenceBank 直接复用了现有内部能力插槽。

### Phase 4

Phase 4 提供了 `RetrievalProvider`、`RetrievalQuery`、`RetrievalResult` 和 `strategy_memory` scope。PreferenceBank 通过 `PreferenceRetrievalProvider` 将用户偏好作为可检索的 strategy memory 暴露给 capability registry。

### Phase 10

Phase 10 提供了 `LearningEventService`、`LearningEventRecorder` 和 `ReflectionSink`。PreferenceBank 通过 `PreferenceReflectionSink` 接收以下事件：

- `variant.accepted`
- `variant.rejected`
- `variant.revised`
- `user.preference_signal`

事件记录失败仍由原有 best-effort 机制隔离，不影响用户主流程。

## 3. 核心闭环

```text
用户交互
  ↓
Learning Event
  ↓
Preference Signal Extractor
  ↓
Atomic Preference Consolidator
  ↓
Persistent User Preference Store
  ↓
Contextual Preference Retrieval
  ↓
PersonalizationPack
  ↓
Guideline RAG / Evidence RAG / Generator
  ↓
新的用户反馈
```

只有完成上述闭环，系统才属于偏好演化，而不是简单地把历史对话放进 prompt。

## 4. 当前可学习的信号

### 4.1 明确偏好

系统能够从对话或显式 API 中识别：

- 更保守，不夸大职责
- 更量化，但只使用已确认指标
- 更简洁或更详细
- 保留或弱化技术细节
- 突出研究贡献
- 突出产品或业务影响
- 使用直接、非营销式语言
- 严格遵守事实边界
- 用户自定义的其他明确写作偏好

明确偏好可立即成为 `active` preference。

### 4.2 版本行为

系统能够从以下行为学习：

- 接受某个 variant
- 拒绝某个 variant
- 点击“偏好此风格”

接受与拒绝会从 variant 的文本特征、场景标签和引用经历中抽取隐式信号。“偏好此风格”属于明确风格信号，会立即激活相关风格偏好，但不会把该 variant 的经历选择误当成用户长期经历偏好。

### 4.3 重复反馈

相同偏好在不同时间再次出现会被视为强化证据，而不是重复数据。相同 generation 和 variant 的重复 accept/reject 投递会去重，避免一次动作被事件链重复计算。

## 5. 偏好数据模型

每条偏好包含：

- `dimension`
- `value`
- `instruction`
- `scope`
- `strength`
- `confidence`
- `supportCount`
- `contradictionCount`
- `status`
- `evidenceEventIds`
- `firstObservedAt`
- `lastObservedAt`
- `lastUsedAt`

当前支持的主要维度：

```text
writing_style
verbosity
packaging_strength
evidence_risk
experience_selection
section_order
technical_depth
metric_usage
role_focus
language_style
```

偏好范围可由以下字段限定：

```text
roleFamily
applicationType
language
section
targetRole
industry
```

这可以避免将“研究岗位突出论文”错误泛化为所有岗位都突出论文。

## 6. 状态与更新逻辑

偏好状态包括：

```text
candidate
active
stale
rejected
locked
```

v1 的更新原则：

- 明确偏好立即成为 `active`
- 普通隐式风格信号通常需要重复观察后才成为 `active`
- 经历选择偏好可在一次强接受信号后激活
- 支持与反对信号共同更新 signed strength
- 非明确偏好按时间进行检索强度衰减
- `locked` 和明确偏好不做时间衰减
- 衰减降低检索权重，不删除历史证据

## 7. PersonalizationPack

生成前，系统按当前岗位和申请场景构建：

```ts
type PersonalizationPack = {
  version: "preference-bank-v1";
  stablePreferences: PreferenceInstruction[];
  contextualPreferences: PreferenceInstruction[];
  negativePreferences: PreferenceInstruction[];
  experienceAffinities: ExperienceAffinity[];
  uncertainPreferences: PreferenceInstruction[];
  retrievalTrace: PreferenceRetrievalTrace[];
  diagnostics: PreferenceDiagnostics;
};
```

使用规则：

- `stablePreferences` 和 `contextualPreferences` 作为生成软约束
- `negativePreferences` 用于降低或避免某类表达
- `experienceAffinities` 只对 Evidence RAG 结果做有界 reranking
- `uncertainPreferences` 仅用于 trace，不作为强制要求
- Evidence RAG 的 allowed claims 不会被 PreferenceBank 扩张

## 8. 生成链路集成

当前生成链路为：

```text
JD
  ↓
Guideline RAG 构建基础 InstructionPack
  ↓
PreferenceBank 构建 PersonalizationPack
  ↓
将偏好写入 InstructionPack 的 softPreferences
  ↓
Evidence RAG 构建基础 EvidencePack
  ↓
按 experience affinity 做有界重排
  ↓
GroundingContextCoordinator
  ↓
LLM generation prompt
```

`ProductGeneration.inputSnapshot` 会保存：

```text
instructionPack
evidencePack
personalizationPack
groundingContext
```

这为未来前端 trace 和用户解释提供了完整输入快照。

## 9. Capability adapters

PreferenceBank 作为正式 capability module 注册：

```text
PreferenceReflectionSink
PreferenceMemoryProvider
PreferenceRetrievalProvider
PreferenceContextProvider
```

因此它同时接入：

- Phase 10 learning event 采集
- Phase 4 strategy memory 检索
- ContextAssemblyPipeline
- product generation pipeline

## 10. 持久化

迁移文件：

```text
src/persistence/postgres/migrations/0014_preference_bank.sql
```

新增表：

```text
product_preference_event
product_user_preference
```

内存模式使用 `InMemoryPreferenceRepository`，PostgreSQL 模式使用 `PostgresPreferenceRepository`。

## 11. API

### 查看偏好

```http
GET /product/preferences?status=active&limit=200
```

### 写入明确偏好

```http
POST /product/preferences/explicit
Content-Type: application/json

{
  "instruction": "更简洁，减少背景描述，直接写技术行动。",
  "scope": {
    "roleFamily": "ai_ml",
    "language": "zh"
  }
}
```

`polarity` 可设为 `negative`，用于提供明确反向反馈。

### 预览当前场景的 PersonalizationPack

```http
POST /product/preferences/preview
Content-Type: application/json

{
  "targetRole": "AI Algorithm Engineer Intern",
  "jdText": "Develop LLM and RAG algorithms with Python and PyTorch."
}
```

该接口不需要真正生成简历，适合后端验收。

### 三类上下文联合预览

原有接口：

```http
POST /product/rag/preview
```

现在会同时返回：

```text
instructionPack
evidencePack
personalizationPack
groundingContext
```

## 12. 当前边界

v1 已形成可运行的核心闭环，但以下能力尚未完成：

- 前端偏好管理和 trace 展示
- 对简历逐句编辑产生 `variant.revised` 事件的完整接线
- 单次申请的 episode summary
- 多 episode 的高级画像总结
- 基于面试、offer、拒信等结果的 outcome utility
- 使用 embedding 或 LLM 对复杂偏好进行语义归并
- 用户对单条 preference 的锁定、删除和手动纠错界面

这些属于 v2 的增强项，不影响 v1 通过明确偏好、accept、reject、prefer 行为完成基本用户适配。

## 13. 验证

```bash
npm run typecheck
node node_modules/vitest/vitest.mjs run --pool=forks --poolOptions.forks.singleFork=true
```

当前验证结果：

```text
68 test files passed
598 tests passed
```
