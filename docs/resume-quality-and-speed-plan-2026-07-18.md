# 简历单页质量与生成速度优化计划

**状态**：P0–P2 工程与 PostgreSQL 实测完成；P3 工程完成但真实模型局部修复成功率验收未通过；真实 DOM/生产基线仍待 P4
**日期**：2026-07-18  
**优先级**：质量硬门禁优先；在不增加整份简历 LLM 重试的前提下同步优化速度

## 1. 背景

实测生成结果存在以下问题：

1. 简历生成耗时过长；
2. 部分 bullet 的最后一行未达到可用行宽的 `66.7%`；
3. 默认生成结果可能在浏览器中排成两页。

本计划的核心目标不是继续堆叠整份简历的 LLM 修订轮次，而是采用：

```text
一次完整简历生成（内部 bullet 备选池）
  → 快速确定性排版搜索
  → 浏览器真实渲染复核
  → 仅在必要时批量局部修复失败 bullet
```

由此同时获得稳定质量和更低延迟。

## 2. 硬性目标

默认简历只有在同时满足以下条件时，才允许保存为候选并进入 `resume_review`：

- A4 纵向排版，浏览器实际渲染恰好一页；
- `page_count == 1` 且无任何页面 overflow；
- 每一条 bullet 的实际最后一行宽度占可用文本行宽 `>= 0.667`；
- 无事实错误；
- 布局选择没有造成已经具备证据的 JD coverage 回退；
- 预览、打印和最终导出使用同一模板、字体、字号、行高和间距参数。

若来源事实不足以满足上述条件，系统必须进入明确的补充内容或失败流程，不得把不合格结果伪装为已完成简历。

默认页面密度继续采用：

- 最低使用率：`80%`；
- 优化目标：`88%`；
- 最大使用率：`95%`。

该区间用于兼顾信息密度、可读性以及浏览器排版误差。一页和 `66.7%` 尾行比例是硬门槛，页面使用率不足则优先引导补充真实经历，不得编造内容填充。

## 3. 当前问题定位

### 3.1 存在绕过质量链的生成入口

[`app/tools/actions/capabilities.py`](../app/tools/actions/capabilities.py) 中的 `generate_resume_from_jd` 直接调用 LLM 生成 Markdown 并保存 variant，没有进入结构化生成、布局测量、事实检查和最终质量门。

这意味着即使主 `resume_generation` subgraph 已具备布局规则，部分入口仍可能输出未经检查的简历。

### 3.2 默认规划仍允许跨入第二页

[`app/graphs/resume/nodes.py`](../app/graphs/resume/nodes.py) 的 `_layout_constraint_from_state` 将默认模式设为软性一页目标：

```python
LayoutConstraint(max_pages=None, requested_pages=1, ...)
```

只有显式识别到“一页”请求时才设置 `max_pages=1`。产品默认目标与控制流因此不一致。

### 3.3 尾行问题会被路由刻意跳过

`layout_route` 当前在硬违规只包含以下类型时直接进入 `fact_check`：

- `bullet_too_short`；
- `bullet_awkward_wrap`；
- `page_underfilled`。

因此确定性修复器未能解决的短尾行不会继续修复，而是在后续流程中变成 `needs_user_decision`。

现有 [`tests/unit/test_graphs/test_resume_layout_flow.py`](../tests/unit/test_graphs/test_resume_layout_flow.py) 也明确保护了“bullet-only 问题跳过修订”的行为，需要同步反转测试契约。

### 3.4 后端估算与浏览器真实排版尚未形成闭环

当前后端使用 Pillow 和固定字体估算 glyph advance，但 `resume_layout_hard_gate_enabled` 默认关闭。后端估算通过并不能证明浏览器真实 DOM 一定是一页，也不能证明浏览器换行后的尾行一定达到 `66.7%`。

截图中第一页留有空间、后续项目和技能仍被移动到第二页，说明需要重点校准：

- 浏览器字体是否实际加载完成；
- item/section 的 `break-inside` 行为；
- 后端 block 分页规则与浏览器分页规则；
- preview 和 print CSS 是否完全一致；
- `layout_tuning` 是否被前端完整应用。

### 3.5 确定性排版本身存在明显性能瓶颈

2026-07-18 本地基线：

```text
25 passed in 25.43s
```

最慢用例：

```text
12.67s  test_layout_optimizer_selects_content_inside_target_band
 6.91s  test_layout_optimizer_uses_bounded_tuning_then_reports_content_gap
 2.98s  test_layout_paginates_by_blocks_and_enforces_single_page
```

主要原因：

- [`app/domain/resume/layout_service.py`](../app/domain/resume/layout_service.py) 在换行过程中对逐步增长的字符串反复测宽，接近二次复杂度；
- [`app/domain/resume/layout_optimizer.py`](../app/domain/resume/layout_optimizer.py) 每移除一个 bullet 都重新测量整份简历；
- 不同 tuning 和候选之间没有充分复用 bullet、文本行和 block 高度结果。

### 3.6 Structured output 兼容回退可能放大 LLM 延迟

[`app/providers/openai_format.py`](../app/providers/openai_format.py) 每次 structured 调用都可能依次尝试：

1. `json_mode`；
2. `json_schema`；
3. prompt-based JSON。

如果当前供应商不支持前面的协议，一次业务生成可能变成多次顺序网络调用，并叠加 Provider 自身重试。

## 4. 总体方案

### 4.1 统一质量入口

所有生成入口必须统一调度 `resume_generation` subgraph：

- 自然语言生成；
- JD 页面“生成简历”；
- Product Action；
- Application Package 内的简历生成；
- Tier 3 全局编辑后的重新生成。

`tools/` 不得反向 import `graphs/`。因此直接生成 Markdown 的 Product Action 应停止承担生成职责，由 API/router 层把请求调度到 `resume_generation`；Tool 只保留符合既有依赖方向的领域操作。

依赖方向继续遵守：

```text
api → graphs → tools → domain ← infra
```

### 4.2 一次完整生成，最终只产生一个变体

LLM 首次调用生成一份结构化简历。内部可以为排版保留带来源信息的 bullet/事实备选池，但整个流程只能产生、持久化并向用户展示 **一个** resume variant：

- 每条 bullet 保留 `source_experience_id`；
- 每条 bullet 保留 `source_fact_ids`；
- 每条 bullet 保留 `matched_jd_requirement_ids`；
- 同一来源事实不得通过同义改写重复占位；
- 候选按 JD 价值、量化结果、责任与方法排序。

这里的“候选”只指同一份简历内部的 bullet、事实子句或组合状态，不是多份简历变体。`state.variants`、数据库写入和 `resume_review.resume` 在成功终态都必须只有一个结果；不提供三变体选择界面。

正常请求只允许一次完整简历 LLM 调用。

### 4.3 确定性联合排版搜索

将当前逐条贪心删除升级为 DP 或有界 beam search。搜索状态至少包含：

- 已选择的 item 和 bullet；
- 当前页面高度；
- 每条 bullet 的行数和最后一行比例；
- 已覆盖的 JD requirement IDs；
- 已使用的 source fact IDs；
- 教育、工作和项目的组成约束；
- 当前 JD 价值分和信息密度分。

硬约束：

- 一页；
- 所有 bullet 尾行比例通过；
- 教育经历不得遗漏；
- 有工作/项目来源时保留至少一个对应 item；
- 不得产生事实和 coverage 回退。

优化目标：

1. 页面使用率尽量接近 `88%`；
2. 最大化 JD 匹配和证据价值；
3. 最小化重复信息；
4. 在同等质量下减少 bullet 数和视觉碎片。

### 4.4 确定性 bullet 重组

在调用 LLM 修复前，先在同一 item 内使用带来源的事实子句进行重组：

- 合并过短 bullet 与相关事实子句；
- 对短第二行重新划分子句边界；
- 允许把一个过长 bullet 拆成两个均合格的独立 bullet；
- 不得跨 source experience 合并事实；
- 合并后对 `source_fact_ids` 和 `matched_jd_requirement_ids` 做稳定并集。

`unfixable_grounded_short` 不再作为 `66.7%` 门槛的通过例外。无法扩展或合并的低价值短 bullet 应删除；高价值但无法自然满足的内容应进入局部修复或明确失败流程。

### 4.5 局部 LLM 修复

只有确定性搜索无法获得合格结果时，才允许一次批量局部调用：

- 输入仅包含失败 bullet；
- 输入包含对应来源经历、未使用事实和目标宽度；
- 每条失败 bullet 可在一次响应内返回 `2–3` 个仅供后端测量的有来源等价文本；
- 后端重新测量并确定性选择；
- 禁止重新生成整份简历。

这些局部等价文本是内部瞬时候选，未被选中的文本不持久化、不进入 API，也不形成额外 variant。

调用预算：

```text
常规：1 次完整生成
困难：1 次完整生成 + 1 次批量局部修复
```

### 4.6 浏览器真实渲染复核

后端估算用于快速搜索，浏览器 DOM 作为最终版面事实来源。

前端必须：

1. 使用与 profile version/hash 对应的字体资产和 CSS；
2. 等待 `document.fonts.ready`；
3. 在不可见测量容器中完成真实排版；
4. 上报实际页数、overflow、页面使用率以及每条 bullet 最后一行比例；
5. 只有真实测量通过后才展示可接受候选；
6. 真实测量失败时返回具体 bullet ID、实际比例和 overflow 高度，触发一次局部修复或失败结果。

在完成足够样例校准前，后端尾行门槛建议使用约 `0.72` 的保守 gate，以保证浏览器实际值仍不低于 `0.667`。最终数值由中英文真实 DOM 样例决定。

### 4.7 对外接口契约冻结

P0–P3 只允许改动内部观测、Graph、领域服务、Repository、排版算法和 Provider 能力，不新增、删除或改名公开 HTTP endpoint，不增加既有响应字段，也不改变既有字段的类型、值域、interrupt type 或 Product Action payload。特别约束如下：

- `generate_resume_from_jd` Product Action 的 request/response envelope 和 `application_package_review` 语义保持不变；内部由 Application graph 委托统一的 resume subgraph；
- `resume_review` / `application_package_review` 继续使用单个 `resume` 字段；deprecated `variants` 的既有形态不变；
- structured patch 的 `qualityStatus` 仍保持既有 `pass | needs_revision` 值域；内部持久化质量状态不得泄漏或替换该字段；
- DOM observation 在 P0–P3 通过内部 service/repository、fixture capture/import 脚本和后续已存在的内部事件通道采集，不新增公开 HTTP route；若未来确需新增前端上报接口，单独版本化并另行评审，不属于本计划。

每个阶段都必须运行 API/OpenAPI/interrupt snapshot 回归；任何非预期 contract diff 都视为阶段失败。

## 5. 实施阶段

### P0：建立观测基线与回归样例

**原估计**：0.5–1 天

**按下述完整方案复核后的估计**：2–3 天。原估计只足够手工保存样例和增加临时日志，不足以完成可并发隔离、可持久化、可统计、可测试的端到端观测闭环。

#### P0.1 阶段边界与设计决策

P0 只建立事实基线，不改变 P1–P5 的产品行为：

- 不修改默认 `max_pages`、`layout_route`、质量门禁或候选持久化规则；
- 不修改排版选择算法，不在 P0 引入缓存、DP、beam search 或局部 LLM 修复；
- structured output 仍按现有 `json_mode → json_schema → prompt JSON` 顺序尝试，不在 P0 做能力缓存；
- DOM 指标在 P0 只记录、比对和形成 fixture，不参与候选放行；真正的浏览器硬门禁仍属于 P4；
- 不改变 `LLMProvider` 的业务返回类型。观测通过请求级 recorder 旁路收集，现有测试 double 和调用方无需返回新的包装对象；
- 不记录完整 prompt、LLM 原始响应、API key、数据库 SQL 参数或用户原始消息。生产环境默认只保存计数、耗时、模型信息、hash 和布局报告；原始 structured snapshot 仅允许在 development/test 显式开启，并在进入 fixture 前脱敏；
- P0 基线中的一次 `run` 定义为一次 HTTP/Graph 调用，从路由入口开始，到 `resume_review`/`resume_content_gap` interrupt、正常完成、失败或客户端取消为止。interrupt 恢复请求创建新的 run，并通过 `thread_id`、`turn_id` 和可选 `parent_run_id` 关联，不把暂停等待用户的时间计入生成延迟。

当前仓库只包含后端，不虚构前端仓库路径。P0 在本仓库内交付 DOM observation 契约、存储和 fixture；本次问题的首份真实 DOM JSON 可由现有前端在 `document.fonts.ready` 后上报，或通过 fixture capture 脚本的 `--dom-input` 导入。预览/打印组件的正式自动测量和门禁改造仍在 P4 的前端配合范围内。

所有计时使用 `time.perf_counter_ns()`，只在序列化时转换为整数 `duration_ms`；时间戳使用 UTC。并行 span 不直接相加计算阶段占比，报告器应使用子 span 时间区间并集计算 critical-path wall time，避免 context assembly 中并行数据库读取被重复累计。

#### P0.2 请求级观测模型

新增 `trace_version = "resume-generation-trace-v1"`。每次 run 在内存中维护一个请求隔离的 recorder，使用 `contextvars` 传播到异步任务和 Provider；Provider 是进程级 singleton，也不能把本次请求的统计保存在 Provider 实例字段中，否则并发请求会互相污染。

一个 run 至少包含以下字段：

```json
{
  "run_id": "rgrun-...",
  "request_id": "...",
  "thread_id": "thread-...",
  "turn_id": "turn-...",
  "trigger": "chat_stream",
  "status": "interrupted",
  "trace_version": "resume-generation-trace-v1",
  "started_at": "2026-07-18T08:00:00Z",
  "graph_duration_ms": 12345,
  "endpoint_duration_ms": 12410,
  "resume_id": "resume-...",
  "variant_id": "variant-...",
  "payload_hash": "sha256:...",
  "nodes": [],
  "llm_calls": [],
  "embedding_calls": [],
  "database_calls": [],
  "layout_calls": [],
  "persistence_calls": [],
  "quality_result": {}
}
```

节点记录不能用 `{node_name: duration}` 覆盖，因为 `draft_generation`、`layout_measure` 等节点可能循环执行。每条节点记录包含 `node`、`attempt`、`started_offset_ms`、`duration_ms` 和 `status`（`completed`、`interrupted`、`failed`、`cancelled`）。Graph 节点 wrapper 必须在 `finally` 中结束 span，并原样重新抛出 LangGraph interrupt、取消和业务异常。

LLM 记录分清三种容易混淆的计数：

- `logical_call_count`：业务代码调用一次 `chat`、`chat_structured` 或 `chat_with_tools`；
- `protocol_attempt_count`：同一个 structured logical call 尝试了多少种协议，例如 `json_mode`、`json_schema`、`json_prompt`；
- `physical_request_count`：包含 transport retry 后真正发出的网络请求总数。

每个 LLM logical call 至少记录：当前 node、operation、provider、model、schema 名称、最终 structured mode、逐协议尝试结果、逐协议 transport attempt 数、`retry_count`、输入/输出/总 token、首 token 耗时（流式调用可用时）、总耗时和错误类别。token 只采用供应商返回的 `usage_metadata`/`response_metadata`；供应商不返回时保存 `null` 和 `usage_available=false`，不得用字符数伪造 token。

当前 `ChatOpenAI(max_retries=3)` 的 SDK 内部重试对调用方不可见。P0 将其调整为 `max_retries=0`，在 Provider 内增加等价的显式有限重试：保持总尝试上限不变，只对 timeout、连接错误、HTTP `408/409/429/5xx` 重试，schema 校验错误和普通 `4xx` 不重试。Anthropic 和远程 embedding 使用同一计数规则。该改动只让现有重试可观测，不改变 structured 协议顺序；协议缓存和总预算收敛留到 P5。

其它阶段记录：

| 类别 | 必填属性 |
|---|---|
| embedding | provider、model、batch size、输入总字符数、vector 数、transport attempts、duration、status |
| database | 稳定 operation 名、`read/write`、row count（可得时）、duration、status；不保存 SQL 和参数 |
| layout | profile version/hash、item/bullet 数、optimizer 总耗时、`measure_resume_layout` 调用次数与各次耗时、最终 page count/usage/violation count |
| persistence | resume create/ownership check、variant insert、workspace snapshot update 各自耗时和结果 |
| quality | `quality_status`、issue codes、事实错误数、coverage 回退数、最终路由 |

#### P0.3 持久化结构

使用独立的 append-only 观测表，不把运行指标塞进 `resume_variants.structured`，避免产品数据模型、画布 payload 和观测数据相互耦合。

`resume_generation_runs`：

| 列 | 设计 |
|---|---|
| `id` | `TEXT PRIMARY KEY`，前缀 `rgrun-` |
| `user_id` | `TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE` |
| `thread_id` / `turn_id` / `request_id` | 请求关联字段；`thread_id` 可在无 checkpointer 的测试模式为空 |
| `parent_run_id` | interrupt 恢复或同一工作流后续 run 的可选自引用外键，父 run 删除时置空 |
| `trigger` | `chat`、`chat_stream`、`product_action`、`application_package`、`tier3_edit`、`interrupt_resume`、`tool_bypass` |
| `status` | `running`、`completed`、`interrupted`、`failed`、`cancelled` |
| `resume_id` / `variant_id` | 最终产品实体，可空，外键删除时置空 |
| `provider` / `model` / `trace_version` | 基线分组和兼容字段 |
| `graph_duration_ms` / `endpoint_duration_ms` | 可直接做 percentile 的顶层数值列 |
| `llm_logical_calls` / `llm_physical_requests` / `input_tokens` / `output_tokens` | 高频汇总列，避免每次从 JSONB 展开 |
| `payload_hash` | canonical structured JSON 的 SHA-256；即使不保存正文也可识别同一输入 |
| `payload_snapshot` | `JSONB NULL`；仅 development/test 且 capture flag 开启时写入 |
| `layout_report` | 最终后端 `LayoutReport` JSONB，可空 |
| `metrics` | 全量 node/LLM/embedding/DB/layout/persistence span JSONB |
| `error_code` | 失败时保存稳定错误码，不保存包含用户文本的异常详情 |
| `started_at` / `completed_at` / `created_at` | UTC 时间 |

索引至少包括 `(created_at)`、`(provider, model, created_at)`、`(thread_id, turn_id)`、`(variant_id)` 和 `(status, created_at)`。

`resume_layout_observations` 用于一份 variant 的多次真实 DOM 测量：

| 列 | 设计 |
|---|---|
| `id` | `TEXT PRIMARY KEY`，前缀 `rlobs-` |
| `run_id` | 可空，关联 `resume_generation_runs`；旧 variant 的手工基线允许没有 run |
| `user_id` / `resume_id` / `variant_id` | 所有权和产品实体关联 |
| `surface` | `preview`、`review`、`print`、`application_package` |
| `measurement_version` | 首版固定为 `browser-layout-observation-v1` |
| `profile_version` / `profile_hash` / `profile_matches` | 前后端模板一致性 |
| `fonts_ready` / `loaded_font_families` | 字体是否完成加载及实际字体集合 |
| `page_count` / `overflow_px` / `page_usage_ratio` | 顶层真实 DOM 结果 |
| `viewport` / `page_metrics` / `bullet_metrics` | JSONB 明细；bullet 使用稳定 `bullet_id` |
| `client_build` / `observed_at` / `created_at` | 前端版本和客户端/服务端时间 |
| `idempotency_key` | 防止前端重发产生重复样本；对 `(variant_id, surface, idempotency_key)` 建唯一约束 |

浏览器上报宽度原值，后端重新计算比例，避免客户端提交互相矛盾的数据：

```json
{
  "runId": "rgrun-...",
  "surface": "preview",
  "measurementVersion": "browser-layout-observation-v1",
  "profileVersion": "resume-template-v2",
  "profileHash": "...",
  "fontsReady": true,
  "loadedFontFamilies": ["SimSun", "Times New Roman"],
  "pageCount": 2,
  "overflowPx": 37.5,
  "usedHeightPx": 1081.2,
  "availableHeightPx": 1040.0,
  "viewport": {"widthPx": 1440, "heightPx": 1200, "devicePixelRatio": 1},
  "bullets": [
    {
      "bulletId": "bullet-...",
      "lineCount": 2,
      "lastLineWidthPx": 181.2,
      "availableLineWidthPx": 320.0
    }
  ],
  "clientBuild": "...",
  "observedAt": "2026-07-18T08:00:12Z",
  "idempotencyKey": "..."
}
```

服务端计算 `page_usage_ratio = usedHeightPx / availableHeightPx` 和每条 `last_line_ratio`，拒绝非有限数、负尺寸、重复 bullet ID、空 profile 和不属于当前用户的 resume/variant/run。profile 不匹配本身是需要记录的问题，因此 P0 不因 mismatch 拒绝 observation，而是写入 `profile_matches=false`。

#### P0.4 运行链路

```text
HTTP route 创建 TraceRecorder（只在内存）
  → router/provider 事件先写入 recorder
  → 首个 resume node wrapper 确认这是 resume run，并 best-effort INSERT running row
      → 非 resume 请求不持久化；旧 Tool 旁路由 capability 显式标记并在终态补写 run
  → 每个 resume node 建立 node span
      → context assembly: 并行 DB / RAG / embedding 子 span
      → Provider: logical call / protocol attempt / transport attempt / token
      → layout: optimizer span + 每次 measure span
      → persist: resume / variant / workspace 子 span
  → quality/output 绑定 status、resume_id、variant_id、payload hash、layout report
  → terminal interrupt/completed/failed/cancelled 时单次 UPDATE 完整 metrics
  → 浏览器稍后 POST DOM observation，按 run/variant 关联
  → baseline 脚本读取 run + observation，输出 p50/p95、阶段占比和差异报告
```

观测数据库失败不得让简历生成失败。start/update 失败只写一条不含正文的 warning，并在内存 recorder 中标记 `telemetry_persist_failed=true`。但是基线采样运行若观测缺失，报告脚本必须把该样本列为 invalid，不得静默排除后仍宣称完成基线。

#### P0.5 逐文件实施方案

以下是 P0 需要新增或修改的完整文件清单。未列出的业务文件不应在 P0 顺手修改。

##### 1. 基础观测与配置

| 文件 | 类型 | 具体改动 |
|---|---|---|
| `app/core/observability.py` | 新增 | 定义无框架依赖的 `TraceRecorder`、span/event 数据类、`contextvars` 绑定、`perf_counter_ns` 计时、父子 span、并发安全的 append、canonical JSON hash、allowlist 属性清洗和 snapshot 序列化。该文件不得 import 任何 `app.*` 模块。 |
| `app/core/config.py` | 修改 | 增加 `resume_observability_enabled`、`resume_observability_capture_payloads`、`resume_observability_sample_rate`、`llm_max_transport_retries`、`embedding_max_transport_retries`。生产环境强制禁止 raw payload capture；sample rate 对 P0 基线环境设为 `1.0`。 |
| `app/graphs/runtime.py` | 修改 | 从 `RunnableConfig.configurable` 读取当前 `TraceRecorder`，提供类型安全的 `trace_from_config()`；不在 module global 保存请求状态。 |
| `app/graphs/tracing.py` | 修改 | 保留现有 SSE helper，新增 resume node wrapper。wrapper 分配同名节点的 attempt 序号，记录完成/interrupt/异常/取消状态，并把 recorder 绑定为当前 context，使深层 Provider/RAG/domain 调用自动归属当前 node。 |

##### 2. Domain 与数据库持久化

| 文件 | 类型 | 具体改动 |
|---|---|---|
| `app/domain/resume/observability_models.py` | 新增 | 定义 `ResumeGenerationRunStart`、`ResumeGenerationRunFinish`、`BrowserLayoutObservationCreate/Result` 等 Pydantic v2 领域模型、状态/trigger/surface Literal 和数值校验；不包含 FastAPI、asyncpg 或 LangGraph 类型。 |
| `app/domain/resume/observability_repository.py` | 新增 | 定义 `ResumeObservabilityRepository` Protocol：`start_run`、`finish_run`、`save_layout_observation`、`get_run_for_user`；所有权查询属于接口契约。 |
| `app/domain/resume/observability_service.py` | 新增 | 负责 run/observation ID、canonical ratio 计算、resume/variant/run 关联校验、profile match 计算和幂等语义；只依赖 repository Protocol。 |
| `app/infra/db/repositories/resume_observability_repo.py` | 新增 | 实现上述 Protocol。run 完成采用一次参数化 UPDATE；observation 通过 join `resumes`/`resume_variants` 校验 user ownership；JSONB 使用现有 codec/序列化约定。 |
| `alembic/versions/0015_resume_generation_observability.py` | 新增 | 创建 `resume_generation_runs`、`resume_layout_observations`、CHECK/UNIQUE/FK 和上述索引；upgrade 可重复检查，downgrade 只删除这两张表，不触碰 resume 产品表。 |
| `app/tools/base.py` | 修改 | 在 `ServiceContainer` 增加可选 `resume_observability: ResumeObservabilityService | None`。保持 optional，避免大量现有测试 fixture 立刻必须构造数据库观测服务。 |
| `app/api/deps.py` | 修改 | 在 `build_service_container` 注入 `ResumeObservabilityService(PostgresResumeObservabilityRepository(pool))`，供内部 Graph 生命周期和 fixture import 路径使用；不暴露新的 HTTP dependency 或 endpoint。依赖装配仍只发生在 API wiring 层。 |

##### 3. Graph、RAG、布局和持久化打点

| 文件 | 类型 | 具体改动 |
|---|---|---|
| `app/graphs/resume/graph.py` | 修改 | 所有 16 个实际执行节点统一通过 wrapper 注册；节点描述和稳定观测名集中在此处，禁止在每个 node 手写开始/结束日志。conditional route 函数继续保持纯函数，不当作 node 重复计时。 |
| `app/graphs/application/graph.py` | 修改 | Application Package 当前直接重复注册整套 resume node，必须复用同一个 wrapper/节点描述表；额外记录 `package_plan`、`package_artifacts`，否则 Product Action 基线会漏掉包生成阶段。此处只统一观测注册，不在 P0 重构业务图。 |
| `app/graphs/resume/state.py` | 修改 | 只增加必要的 `observability_run_id`/`parent_run_id` 可选状态字段，便于 checkpoint 恢复关联；完整 metrics 不进入 LangGraph state，避免 checkpoint 膨胀。 |
| `app/graphs/resume/nodes.py` | 修改 | 在 `layout_measure_node` 增加 optimizer 总 span 和候选 item/bullet 数；在 persistence node 分开记录 JD promote、resume create/ownership read、variant insert、workspace update；把最终 structured hash、可选 snapshot、layout report、quality status、resume/variant ID 绑定到 recorder。不得借此修改 P1 的质量路由。 |
| `app/tools/actions/capabilities.py` | 修改 | 给现有直接 Markdown 生成旁路增加 `tool.generate_resume_from_jd` span，标记 `trigger=tool_bypass`，记录 LLM/持久化并绑定 resume/variant。P0 只让旁路可见，P1 再删除其生成职责。 |
| `app/memory/context_assembly.py` | 修改 | 给并行的 JD、profile、preferences、experience/evidence、guideline 五条分支加稳定 operation span；记录返回项数量，不记录返回正文。保留现有 `asyncio.gather` 并行行为。 |
| `app/rag/evidence/service.py` | 修改 | 分别记录 requirement embedding、experience vector query、recent/category fallback query、evidence-pack embedding 和 claims hydration DB write；标注 batch size、row count、fallback 原因。 |
| `app/rag/guideline/service.py` | 修改 | 记录 vector-column capability read、query embedding、vector query、全文 fallback query；不记录 query 原文。 |
| `app/domain/resume/layout_service.py` | 修改 | 在同步 `measure_resume_layout` 外围记录每次测量耗时、profile、文本/item/bullet 数和结果摘要。domain 仅依赖无框架的 `app.core.observability`，仍可独立单测。 |
| `app/domain/resume/layout_optimizer.py` | 修改 | 记录一次 optimize 的测量调用数、候选删减/调参次数、最大 usage 和最终 fit 状态；不在 P0 改算法。 |

##### 4. Provider 可观测性

| 文件 | 类型 | 具体改动 |
|---|---|---|
| `app/providers/retry.py` | 新增 | 实现可测试的显式 transport retry helper、重试分类、退避和逐 attempt 事件；调用方传 operation，不捕获/吞掉 `CancelledError`。 |
| `app/providers/base.py` | 修改 | 增加内部 token usage 归一化 helper 和稳定的 provider operation 类型；`LLMProvider` 公共返回契约保持不变。 |
| `app/providers/openai_format.py` | 修改 | SDK 内部 retry 设为 0；所有 chat/tool/structured/embed 调用走显式 helper。structured 使用 `include_raw=True` 获取 `AIMessage.usage_metadata`，记录每个协议 attempt；prompt JSON fallback 走同一个 logical call 的子 attempt，避免重复计数。 |
| `app/providers/anthropic_format.py` | 修改 | 同样记录 model、tool/structured mode、raw usage、transport retry 和耗时；Anthropic embedding fallback 继承同一 trace，不创建伪造的第二个 logical resume call。 |
| `app/providers/local_embedding.py` | 修改 | 记录模型首次加载和每批 encode 耗时、batch/vector 数；不记录向量或输入文本。cold load 与 warm encode 在报告中分开。 |

##### 5. API 生命周期与 DOM 上报

| 文件 | 类型 | 具体改动 |
|---|---|---|
| `app/api/observability.py` | 新增 | 提供 route 共用的 recorder 创建、config 注入、run start/finish、状态映射和 best-effort flush；确保非流式、SSE、Product Action 使用同一语义。 |
| `app/api/routes/copilot.py` | 修改 | 在 `/chat`、`/chat/stream`、`generate_resume_from_jd` Product Action 三条入口注入 recorder；记录 endpoint 总耗时；在 terminal 事件、异常和 finally 中恰好完成一次 run。其它 Product Action 不创建 resume run。 |
| `app/api/routes/threads.py` | 修改 | `/threads/{thread_id}/resume` 为 interrupt 恢复创建新 recorder，通过上一次 run 绑定 `parent_run_id`，并记录 `trigger=interrupt_resume`；纯 discard 不计入生成基线。重复 idempotent 响应不得创建第二条 run。 |
| `app/api/sse.py` | 修改 | 在 `agent.interrupt`、`agent.completed`、`agent.failed` 和客户端取消处通知 recorder terminal 状态；继续输出现有 SSE payload，不向前端暴露内部 metrics 或 PII。 |
| `app/api/routes/product/resume.py` | 不改 | 对外 resume HTTP contract 冻结；P0 不新增 DOM observation endpoint。DOM JSON 由内部 fixture capture/import 路径进入 observability service/repository。 |

##### 6. Fixture、基线脚本和文档产物

| 文件 | 类型 | 具体改动 |
|---|---|---|
| `tests/fixtures/resume_regression/README.md` | 新增 | 说明 fixture schema、脱敏规则、字体/profile 前置条件、known-bad 与 expected-pass 的区别，以及如何更新而不是盲目重录 golden。 |
| `tests/fixtures/resume_regression/manifest.json` | 新增 | 列出 case ID、语言、密度、profile hash、tags、输入/报告/DOM 文件路径和 P0 预期。 |
| `tests/fixtures/resume_regression/incident_two_page_zh/structured.json` | 新增 | 本次截图问题的脱敏 structured payload；稳定保留 bullet/item ID、字符类别、字符串长度和布局 tuning。 |
| `tests/fixtures/resume_regression/incident_two_page_zh/layout-report.json` | 新增 | 同一 payload 的后端估算报告。 |
| `tests/fixtures/resume_regression/incident_two_page_zh/dom-preview.json` | 新增 | 等待字体完成后的真实 preview DOM 指标，明确记录实际两页/overflow/失败 bullet。 |
| `tests/fixtures/resume_regression/incident_two_page_zh/expected.json` | 新增 | P0 为 `known_bad`，断言能复现“后端估算与 DOM 不一致”；P4 修复后才把期望翻转为 pass。 |
| `tests/fixtures/resume_regression/zh_sparse/*` | 新增 | 中文稀疏内容，验证低使用率与单行短 bullet。 |
| `tests/fixtures/resume_regression/zh_dense/*` | 新增 | 中文密集内容，验证临近页底和 block 分页。 |
| `tests/fixtures/resume_regression/en_times_dense/*` | 新增 | 英文 Times New Roman 密集简历。 |
| `tests/fixtures/resume_regression/mixed_long_tech/*` | 新增 | 中英混排和长技术名，如 Kubernetes/OpenTelemetry/PostgreSQL。 |
| `tests/fixtures/resume_regression/long_numeric_tokens/*` | 新增 | 长数字、百分号、版本号、URL-like token 的临界换行。 |
| `tests/fixtures/resume_regression/tail_ratio_below_gate/*` | 新增 | DOM 尾行比例略低于 `0.667` 的失败边界。 |
| `tests/fixtures/resume_regression/tail_ratio_at_gate/*` | 新增 | DOM 尾行比例略高于或等于 `0.667` 的通过边界。 |
| `scripts/capture_resume_regression_fixture.py` | 新增 | 按 run/variant 导出 structured、layout report 和 observation，并支持 `--dom-input` 导入本次问题的手工浏览器 JSON；执行确定性脱敏、canonical JSON、hash 和 manifest 更新。若脱敏会改变字符宽度类别，脚本必须拒绝导出并要求使用经授权的等宽替代数据。 |
| `scripts/benchmark_resume_generation.py` | 新增 | 支持 `--warmup`、`--runs`、case filter、非流式/流式入口和输出路径；从已持久化 run 汇总 nearest-rank p50/p95、冷/热启动、成功/失败、阶段 critical-path 占比、logical/protocol/physical LLM 次数和 token。 |
| `docs/baselines/resume-generation-p0-baseline.json` | 新增 | 机器可读基线，包含环境指纹、样本选择、逐 run ID 和聚合结果，不含正文。 |
| `docs/baselines/resume-generation-p0-baseline.md` | 新增 | 人工可读结论：端到端 p50/p95、各 node/stage p50/p95、阶段占比、LLM 次数分布、token、backend-vs-DOM 差异和 invalid sample。 |
| `.gitignore` | 修改 | 忽略本地未脱敏的 `artifacts/resume-observability/` 和 benchmark 临时输出；只提交经过审核的 fixture 与 baseline 汇总。 |

#### P0.6 固定样例规范

每个 case 使用同一目录协议：

```text
<case>/
├── structured.json
├── layout-constraint.json
├── layout-report.json
├── dom-preview.json
├── dom-print.json          # P0 可为 pending；P4 前必须补齐
└── expected.json
```

fixture 中禁止真实姓名、邮箱、电话、公司内部 URL 和未经授权的完整经历正文。脱敏不能简单把中文换成 `***`，因为这会破坏 glyph 宽度和换行复现。姓名、联系方式和标识符使用相同字符类别、近似字宽与相同长度的稳定替代值；若本次问题依赖具体 bullet 长度，则使用用户批准的脱敏副本，或构造能得到相同行宽结果的合成事实。

测试不对整个 `LayoutReport` 做脆弱的逐字节 golden 比较，只固定影响行为的字段：profile hash、page count、overflow、page usage、每条 bullet 的 line count/last-line ratio/status、forced break IDs。浮点断言必须声明像素或比例 tolerance。

P0 对本次问题 fixture 的正确结果不是“测试通过一页”，而是稳定证明现状：

```text
backend_layout_report 与保存时完全一致
dom_preview.page_count == 2 或 overflow_px > tolerance
至少一条 DOM bullet last_line_ratio < 0.667（若本次样本确有该问题）
backend 与 DOM 的 page_count / ratio 差异可被报告器识别
```

这样 P1/P2/P4 修复时才有真实的回归靶点，而不会在 P0 通过修改 fixture 掩盖问题。

#### P0.7 测试改动

| 文件 | 关键断言 |
|---|---|
| `tests/unit/test_core/test_observability.py` | 嵌套/并行 span、attempt 序号、异常/取消收尾、canonical hash、attribute 脱敏、contextvars 并发隔离。 |
| `tests/unit/test_graphs/test_resume_observability.py` | graph 中所有 resume node 均被 wrapper 注册；循环节点不会覆盖；interrupt 记为 interrupted；metrics 不写入 graph state。 |
| `tests/unit/test_providers/test_observability.py` | json mode 成功、三层 fallback、transport retry、不可重试 4xx、usage 存在/缺失、logical/protocol/physical 三类计数准确。 |
| `tests/unit/test_memory_context_assembly.py` | 五条并行分支都有 span，数量属性正确，属性里没有 JD/经历正文。 |
| `tests/unit/test_domain/test_resume_observability_service.py` | DOM 比例由服务端计算、非法尺寸/重复 bullet 拒绝、profile mismatch 被记录、幂等 key 稳定。 |
| `tests/unit/test_infra/test_resume_observability_repo.py` | SQL 参数化、JSONB、start/finish、跨用户 observation 被拒绝、重复 observation 幂等。 |
| `tests/unit/test_api_contracts.py` | 固定现有 Product Action、resume serializer、interrupt 和 structured patch 契约；确认观测能力未新增公开 route/字段。 |
| `tests/unit/test_api_resume_observability_lifecycle.py` | chat、SSE、Product Action、interrupt resume 的 start/finish 恰好一次；客户端取消记为 cancelled；idempotent resume 不重复建 run。 |
| `tests/unit/test_api_sse.py` | terminal interrupt/completed/failed 正确结束 recorder，事件 payload 仍符合现有契约且不包含内部 metrics。 |
| `tests/unit/test_resume_bypass_observability.py` | 旧 `generate_resume_from_jd` Tool 被明确标为 `tool_bypass`，LLM 与 variant persistence 均可追踪，但业务输出不变。 |
| `tests/unit/test_resume_regression_fixtures.py` | manifest 和所有 JSON schema 可读；problem fixture 能复现 known-bad backend/DOM 差异；临界比例样例边界正确。 |
| `tests/unit/test_architecture_boundaries.py` | 扩展断言：core 仍无 `app.*` import；domain observability 无框架/infra import；graphs/providers 不 import infra repo。 |
| `tests/integration/test_resume_observability_repository.py` | 在真实 PostgreSQL 中验证 migration、FK、JSONB round-trip、run finish、observation ownership 和唯一幂等约束。 |

Provider、graph 和 domain 单测必须使用 fake clock/fake provider/fake repository，不访问网络或真实数据库。PostgreSQL 表、FK、JSONB 和并发幂等另放 integration test；基线脚本是显式执行的性能采样，不能混入普通 `pytest` 造成 LLM 成本和不稳定性。

#### P0.8 基线采样方法

为了让后续“相对 P0 下降 40%/30%”可验证，基线必须固定以下条件：

1. 记录 git commit、Python/OS、数据库位置、provider、model、embedding provider/model、layout profile version/hash、关键 feature flags；`base_url` 只记录 host hash；
2. 先做 2 次不计入统计的 warmup；local embedding 的首次模型加载另列 cold-start，不混入 warm p50/p95；
3. 至少 30 个有效 run，覆盖中英文、稀疏/密集和临界换行；每个 case 的次数和权重写入 baseline JSON；
4. 非流式和 SSE 分开报告。SSE 延迟以 terminal interrupt/completed 事件到达服务端生成器的时刻为终点；另报告可用时的 time-to-first-token；
5. 成功、明确内容不足、质量失败和基础设施失败分别统计。主 p50/p95 使用成功到达候选/明确业务终态的 run，失败率和失败延迟单独展示，不能静默删除失败样本；
6. percentile 使用 nearest-rank，并在报告中写明样本数；少于 20 个有效 run 时不得发布 p95；
7. 阶段占比同时给出 wall-clock critical path 和累计 operation time。并行 DB/RAG 子 span 只在累计表相加，不得让阶段占比总和伪装成 100%；
8. LLM 调用表同时报告 logical、protocol attempt 和 physical request 的 p50/p95/max，以及每个 structured mode 的成功率；
9. 观测缺字段、run 未完成、profile hash 不一致或 DOM observation 缺失的样本列入 `invalid_samples`，修复后重跑，不得以 `0` 填充。

基线报告至少包含：

```text
端到端：graph / endpoint p50、p95、max
节点：每个 resume node 的 calls、p50、p95、占 critical path 比例
LLM：model、mode、logical/protocol/physical calls、retry、token、duration
RAG：embedding 与 DB wall time、batch size、fallback 次数
布局：optimizer wall time、measure 次数、单次 measure p50/p95
持久化：resume/variant/workspace 各自耗时
质量：终态分布、page/overflow/tail-line/backend-vs-DOM 差异
```

#### P0.9 实施顺序

1. 先实现 core recorder、显式 Provider attempt/token 记录及其纯单元测试；
2. 增加 migration、domain Protocol/service、infra repository 和 dependency wiring；
3. 用统一 wrapper 覆盖全部 resume node，再补 context/RAG/layout/persistence 子 span；
4. 接入 `/chat`、`/chat/stream`、Product Action 的 start/finish 生命周期，验证异常和客户端取消也能结束 run；
5. 通过内部 fixture capture/import 脚本调用 observability service，用本次问题数据保存第一条 DOM observation；不新增公开 HTTP endpoint；
6. 建立 manifest 和八类 fixture，先锁定 `incident_two_page_zh` 的 known-bad 行为；
7. 运行 unit/integration、`ruff`、`mypy`；
8. 固定环境执行至少 30 个有效 run，提交 JSON/Markdown 基线；
9. P0 验收后才开始 P1，P1/P2/P4 的效果均以同一 run schema 和 fixture 对比。

#### P0.10 完成定义

P0 只有同时满足以下条件才算完成：

- 每个 resume node 的每次执行都存在唯一的 duration/status 记录，interrupt、异常和取消无悬空 span；
- OpenAI-format 和 Anthropic-format 均能记录 model、structured mode、协议尝试、实际 transport retry 和供应商 token usage；
- embedding、关键数据库读取、layout optimizer/measure 和 resume 持久化可分辨，不只剩一个总耗时；
- 本次两页/尾行问题有脱敏 structured、后端 report 和真实 DOM observation，自动测试能复现而不是掩盖该问题；
- 固定样例至少覆盖中文、英文、稀疏、密集、混排长技术名、长数字、`0.667` 两侧和临界页底 block；
- baseline 有至少 30 个有效 run，并给出端到端 p50/p95、阶段占比和三种 LLM 调用计数；
- 生产日志和默认 metrics 不含 prompt、completion、用户正文、SQL 参数、向量、邮箱或电话；
- observability 表写入失败不改变简历业务结果，baseline 工具却能明确报出观测缺失；
- 新增测试通过，`ruff check`、`ruff format --check`、`mypy app` 通过，架构边界测试无反向依赖；
- P0 没有修改默认页数、质量门、layout route、排版选择或候选放行行为。

交付物：

- 可复现本次截图问题的脱敏回归 fixture；
- append-only run 与 DOM observation 数据；
- 当前端到端 p50/p95 机器可读/人工可读报告；
- 各阶段耗时占比、后端/DOM 差异和 LLM 实际 logical/protocol/physical 调用次数。

#### P0.11 实施结果（2026-07-18）

**工程状态**：观测代码、持久化契约、合成回归框架和自动测试已实施；真实事故样本和生产式 30-run 基线仍待外部数据，因此 P0 的“工程交付”已完成，P0.10 的“正式运营验收”尚未全部满足。

已完成：

- 新增请求隔离的 `TraceRecorder`，使用 `contextvars` 传播，支持重复 node attempt、嵌套/并行 span、异常、中断和取消收尾；
- OpenAI-format、Anthropic-format 和本地 embedding 已接入 logical/protocol/physical 调用、供应商 token usage 与显式 transport retry 观测；SDK 内部 retry 已关闭；
- 新增 `resume_generation_runs`、`resume_layout_observations` 领域模型、Protocol、Service、PostgreSQL repository 和 `0015` migration；
- 普通 chat、SSE、Product Action、interrupt resume 使用同一 recorder 生命周期，并对 start/finish 做 exactly-once 和 best-effort 隔离；
- resume/application graph 节点统一使用 wrapper；context assembly、Evidence RAG、Guideline RAG、layout measure/optimizer 和持久化均有稳定 operation span；
- 新增内部 DOM observation 领域模型、Service、Repository 与 fixture import 能力；页面使用率与尾行比例由服务端根据原始尺寸重算，包含所有权、profile mismatch 记录和幂等语义；遵循后续补充的契约冻结要求，未保留新增公开 endpoint；
- 建立无真实 PII 的合成 fixture 协议和边界样例；真实 `incident_two_page_zh` 在缺少授权 structured/DOM 输入时明确标记为 `pending/invalid`，没有伪造；
- baseline JSON/Markdown 已建立，但在没有真实固定环境 run 时明确标记为 pending，不发布虚假的 p50/p95。

已验证：

```text
原有 unit suite：272 passed
P0 新增/定向回归：21 passed
架构/API/SSE/Application 定向回归：40 passed
P0 变更文件 ruff check / format：通过
P0 变更文件 mypy：通过
```

尚待外部条件完成：

1. 导入本次问题经授权且保持字宽类别的 structured payload，以及 `document.fonts.ready` 后的 preview/print DOM JSON；
2. 在固定 provider、model、数据库和字体环境执行至少 30 个有效 run，发布真实 p50/p95；
3. 在可访问 PostgreSQL/Docker 的环境执行 `0015` migration 与 repository integration test。本次本地 Docker socket 权限未获批准，未把静态/单元测试冒充数据库集成验证。

该缺口不阻止 P1 先实施 fail-closed 质量保护，但在真实基线完成前，P2 只能声明绝对性能是否达到 `p95 <= 300ms` 和 layout suite `<= 3s`，不能声明相对 P0 的 `40%/30%` 降幅。

### P1：锁死质量门禁并移除旁路

**预计**：1 天

#### P1.1 阶段边界与设计决策

P1 只改变质量契约和入口，不在此阶段实现 P2 的新搜索算法或 P3 的局部模型修复：

- 默认请求固定 `max_pages=1, requested_pages=1`；只有明确的 `page_count >= 2` 或明确多页措辞允许 `max_pages=None`；
- 默认请求中，第二页、overflow、任意 bullet 尾行违规、profile/font mismatch、事实错误和 coverage 回退均为失败，不再允许用户把它当作合格候选接受；
- `page_underfilled` 进入补充真实内容流程；其它达到修复预算后仍存在的硬违规进入明确失败流程；
- 删除 `unfixable_grounded_short` 通过例外，单行和多行 bullet 使用相同 `0.667` 硬门槛；
- P4 浏览器校准前保持 fail-closed：`resume_layout_hard_gate_enabled=False` 时返回 `browser_verification_required`，不持久化、不进入 `resume_review`；
- variant 增加显式质量状态。旧数据和手工编辑结果默认为 `unverified`，只有 `passed` 才能 Accept；
- 每次成功生成只允许一个 resume variant；内部 bullet/事实备选和 beam 状态不形成第二、第三个 variant；
- Product Action 保持既有 Application Package 对外契约；Application Package 在内部通过嵌套的同一 resume subgraph 生成唯一简历；
- 冻结全部公开 HTTP、Product Action、interrupt 和 serializer 契约；内部质量字段不得出现在既有 API 响应中；
- 保留 P0 的 `traced_node`、`observation_span`、`bind_result` 和稳定 operation 名。

显式多页请求的解释是：多页本身不构成失败，但每页 overflow、尾行、事实和 coverage 门槛仍必须通过。默认请求绝不允许两页。

#### P1.2 控制流

```text
所有生成入口
  → resume_generation
      → layout_measure
          ├─ pass → fact_check → coverage_check → self_review → quality_gate
          ├─ underfilled → content_gap
          ├─ repairable + budget → layout_revision → layout_measure
          └─ budget exhausted / terminal violation → output_failure

quality_gate
  ├─ passed → persist_draft → resume_review
  └─ failed → output_failure
```

P1 删除 `persist_decision_candidate → output_for_decision` 这条“保存后让用户接受硬违规”的链路。

#### P1.3 逐文件实施方案

##### 1. 硬布局契约

| 文件 | 类型 | 具体改动 |
|---|---|---|
| `app/domain/resume/layout_models.py` | 修改 | 删除 `unfixable_grounded_short` 状态和例外语义；保留 `pass/too_short/awkward_wrap`。 |
| `app/domain/resume/layout_service.py` | 修改 | 所有 bullet 无条件执行同一 gate；删除 soft exception；确保 page limit、overflow、forced block 和 profile/font mismatch 都保留硬违规。保留 P0 measure span。 |
| `app/graphs/resume/nodes.py` | 修改 | 默认硬一页；显式多页才解除页数上限；反转 bullet-only 路由；修复预算耗尽后输出失败；quality gate 不再把硬违规映射为 `needs_user_decision`；persist/output 增加 `quality_status == passed` 防御断言；删除 LLM schema/prompt 中的 layout exception。 |
| `app/graphs/resume/state.py` | 修改 | 增加 terminal layout failure 和统一入口需要的 turn-scoped 状态；完整 metrics 仍不进入 state。 |

##### 2. 单一 Graph 入口

| 文件 | 类型 | 具体改动 |
|---|---|---|
| `app/graphs/resume/graph.py` | 修改 | 删除 decision-candidate 节点和边；只允许 passed 持久化。所有节点继续由统一 traced registry 注册。 |
| `app/graphs/application/graph.py` | 修改 | package plan/artifacts 后调用编译后的 `resume_generation` subgraph，不再复制 resume 节点和边。 |
| `app/graphs/main.py` | 修改 | 构建一次 resume subgraph并复用到普通生成和 Application Package。 |
| `app/graphs/resume/nodes.py` | 修改 | `context_assembly` 增加已组装标记，Application Package 进入嵌套 subgraph 时不重复读取 context。 |
| `app/api/routes/copilot.py` | 修改 | `generate_resume_from_jd` 继续设置 `target_subgraph=application_package` 以维持既有 interrupt/response 契约；内部 Application graph 复用 resume subgraph；trace 使用 `trigger=product_action`；删除从 interrupt payload 补存 variant 的重复持久化逻辑。 |

##### 3. 删除 Tool 旁路

| 文件 | 类型 | 具体改动 |
|---|---|---|
| `app/tools/actions/product_action_tools.py` | 修改 | 删除 `GenerateResumeFromJdTool` 类和注册。 |
| `app/tools/actions/capabilities.py` | 修改 | 删除直接 Markdown 生成与 `save_variant` 实现。 |
| `app/tools/actions/models.py` | 修改 | 删除只供旧 Tool 使用的 `GenerateResumeFromJdInput`。 |
| `app/tools/registry.py` | 不改 | 统一 registry 自动感知工具删除，不新增路由特殊分支。 |

##### 4. Variant 接受资格

| 文件 | 类型 | 具体改动 |
|---|---|---|
| `alembic/versions/0016_resume_variant_quality.py` | 新增 | 为 `resume_variants` 增加 `quality_status`、`quality_issues`、`quality_gate_version`；旧数据回填 `unverified`；增加状态 CHECK。 |
| `app/domain/resume/models.py` | 修改 | 增加仅供内部持久化使用的 `ResumeVariantQualityStatus`；Create 默认 `unverified`；不改变既有 API serializer。structured patch 的外部 `qualityStatus` 继续由独立 layout result 映射。 |
| `app/domain/resume/repository.py` | 修改 | Repository 契约携带质量字段。 |
| `app/infra/db/repositories/resume_repo.py` | 修改 | insert/read/update 质量字段；structured/canvas edit 创建的新版本自动降级为 `unverified`。 |
| `app/domain/resume/service.py` | 修改 | 增加 Accept 资格方法；未通过 variant 拒绝接受；canvas patch 不继承旧 passed。 |
| `app/tools/actions/capabilities.py` | 修改 | `accept_variant` 在创建 ResumeItem 前调用领域资格校验。 |
| `app/api/routes/product/resume.py` | 不改契约 | 不返回内部 quality status/issues/version；保持现有字段和值域。 |

#### P1.4 测试改动

| 文件 | 关键断言 |
|---|---|
| `tests/unit/test_graphs/test_resume_layout_flow.py` | 默认 `max_pages=1`；显式多页才放开；bullet-only 不再进 fact check；预算耗尽直接失败；underfill 进 content gap；两页/overflow/尾行/profile mismatch 不进 review。 |
| `tests/unit/test_domain/test_resume_layout.py` | 删除短 bullet soft exception 通过契约；同一 `0.667` 门槛覆盖单行和多行。 |
| `tests/unit/test_application_package_flow.py` | Application Package 复用 nested resume subgraph；不存在 decision candidate。 |
| `tests/unit/test_tools/test_registry.py` | registry 不再包含 `generate_resume_from_jd`。 |
| `tests/unit/test_natural_language_backend_flow.py`、`tests/unit/test_application_package_flow.py` | chat/Product Action/Application Package 复用同一质量链，并保持既有 interrupt contract。 |
| `tests/unit/test_resume_variant_quality.py` | 只有 passed variant 可 Accept；旧、手工编辑、needs_revision 和 failed 均被拒绝。 |
| `tests/integration/test_resume_variant_quality_repository.py` | migration、CHECK、JSONB issues、旧数据回填和 round-trip。 |
| `tests/unit/test_api_contracts.py` | Product Action schema、interrupt type、variant serializer 和 structured patch `qualityStatus` 与实施前一致；没有新增公开 route/字段。 |
| `tests/unit/test_workspace_snapshot.py`、`tests/unit/test_natural_language_backend_flow.py` | persist/review 和 Application Package 成功终态都只有一个 variant；多 variant 写入被拒绝。 |

#### P1.5 实施顺序

1. 先反转默认页数、bullet 路由和 quality gate 测试；
2. 删除 decision-candidate 控制流并给 persist/output 加防御断言；
3. 删除 Tool 旁路，保持 Product Action 对外 target/interrupt 契约并修正内部 delegation/trace；
4. 增加 `0016` 与 variant 质量字段，封住历史/手工 variant 的 Accept；
5. Application Package 改为复用 nested resume subgraph；
6. 运行 unit/integration、Ruff、mypy 和架构边界测试；
7. 把实际结果写入 P1 完成记录后再开始 P2。

#### P1.6 完成定义

- 默认生成全部使用硬一页；
- 任意硬布局违规都不能 persist、review 或 accept；
- registry 中不存在直接生成简历 Tool；
- Product Action 对外继续保持 Application Package 契约，内部不再复制或绕过 resume 质量链；
- 所有入口共享同一质量 subgraph；
- 成功终态只持久化并展示一个 resume variant；
- 旧/手工编辑 variant 默认不可接受；
- 公开 API/OpenAPI/Product Action/interrupt/serializer contract diff 为零；
- P0 tracing、run/variant 绑定和 layout observation 保持有效；
- 新增测试和现有回归通过；P1 变更文件 Ruff/mypy 通过；
- PostgreSQL 可用时完成 `0016` integration 验证；不可用时必须明确列为待验收，不能用 mock 冒充。

该阶段完成后，即使速度尚未优化，也必须先停止不合格结果流出。

#### P1.7 实施结果（2026-07-18）

**工程状态**：完成。根据用户补充约束，实施过程中已回收所有新增对外 contract，并将成功终态锁定为一个 resume variant。

已完成：

- 默认 `max_pages=1, requested_pages=1`；只有显式多页输入解除页数上限；
- 删除 `unfixable_grounded_short` soft exception；bullet-only 硬违规不再跳过修复/失败；
- 删除 `persist_decision_candidate` 链路；quality/persist/output 全部 fail-closed；
- Application Package 内部嵌套统一 resume subgraph；Product Action 继续保持原有 `application_package_review` 对外契约；
- 删除直接 Markdown 生成的内部 Tool 旁路；
- `0016` 增加内部 variant quality 状态，旧/手工编辑默认为 `unverified`，Accept 只允许 `passed`；
- persist 对 variant 数量增加硬断言：成功路径只能写入一条；review 继续只暴露既有单个 `resume` 对象；
- 删除曾新增的公开 DOM observation route 和 quality serializer 字段；structured patch 的 `qualityStatus=pass|needs_revision` 保持不变；
- API contract 测试明确断言内部 quality 字段不外泄、没有新增 observation route。

验证结果：

```text
P1 定向质量/单变体/契约回归：100 passed
P0–P3 最终 unit suite：307 passed in 8.98s
架构边界 + main graph + API/Application 契约：37 passed
P1–P3 变更文件 Ruff：通过
P1–P3 变更文件 mypy：通过
alembic heads：0016 (head)
```

未冒充完成的外部项：真实 PostgreSQL 环境中的 `0015/0016` migration、CHECK/FK/JSONB round-trip 仍待执行；当前仓库没有 integration test 文件，且本任务环境无法使用已被拒绝的 Docker 权限。

### P2：高质量、低延迟的确定性排版器

**预计**：2–3 天

#### P2.1 阶段边界与不变量

P2 只替换内部确定性测量与选择算法，不增加 LLM 调用，不改变 P1 的质量门，也不改变任何对外契约：

- 输入、输出仍是一份 structured resume，成功时只产生一个 resume variant；
- “候选”只表示内部 bullet 组合状态，不形成多份简历；
- page、overflow、bullet gate、事实和 coverage 规则不降级；
- 同输入、同 profile、同字体资产必须得到字节级稳定的选择结果；
- 继续复用 P0 span，新增 cache hit/miss、width probe、beam state 数等内部指标，但不进入 API。

#### P2.2 性能基线与算法决策

2026-07-18 在 P1 完成后的同机复测：

```text
13 passed in 93.13s
47.81s  test_layout_optimizer_selects_content_inside_target_band
25.83s  test_layout_optimizer_uses_bounded_tuning_then_reports_content_gap
11.25s  test_layout_paginates_by_blocks_and_enforces_single_page
```

逐字符增长 substring 并反复调用 FreeType 是主瓶颈。实施顺序固定为：

1. 换行使用二分查找定位当前行最远可容纳字符，再向前寻找合法断点；
2. 以 `(text, width, font family/size/weight/italic/line-height)` 缓存宽度和换行结果；基础 profile 与 tuning service 共享有界 cache；
3. bullet、item 与 block 的重复测量自然命中上述 cache，避免同一候选删减/调参反复调用 FreeType；
4. overfill 使用有界、稳定排序的 beam search 联合选择移除集合；保持每个 item 至少两条 bullet，禁止丢失已有 JD coverage；
5. section heading keep-with-next、item block 不拆分继续由统一 paginator 计算，不另建会漂移的近似分页器。

选择二分 + exact cached FreeType，而不是字符 advance 简单求和，是为了保留 kerning/字体行为和既有门槛结果。

#### P2.3 逐文件实施方案

| 文件 | 类型 | 具体改动 |
|---|---|---|
| `app/domain/resume/layout_service.py` | 修改 | 增加有界 width/wrap cache；`_wrap_inline_text` 改为二分定位 + 原有断行/标点规则；`with_tuning` 共享 cache；保持公开 domain 方法签名兼容。 |
| `app/domain/resume/layout_optimizer.py` | 修改 | 保留确定性 bullet 重组 DP；将顺序贪心删除改为有界 beam search；状态只保存内部移除索引、coverage 和评分；最终只返回一份 structure。 |
| `app/core/observability.py` | 按需修改 | allowlist 增加 cache/beam 聚合计数，不记录文本或候选 payload。 |
| `scripts/benchmark_resume_generation.py` | 不改 | 保持 P0 的生产 run 汇总职责；P2 本地算法基准由固定 pytest suite 和独立 30-run cold-cache 命令执行，避免与尚 pending 的生产端到端数据混为一谈。 |

#### P2.4 测试方案

| 文件 | 关键断言 |
|---|---|
| `tests/unit/test_domain/test_resume_layout.py` | 二分换行与旧规则在中英文、Markdown、标点和 gate 临界值上等价；cache 不改变 report；heading keep-with-next/item block 规则保持。 |
| `tests/unit/test_domain/test_resume_content_fit.py` | beam 选择稳定、保留唯一 JD coverage、每 item 至少两条 bullet、同输入重复运行 structure/report 完全一致。 |
| `tests/unit/test_workspace_snapshot.py`、`tests/unit/test_application_package_flow.py` | optimizer 内部多状态不会形成多个 persisted/review variant。 |
| `tests/unit/test_api_contracts.py` | P2 前后 OpenAPI/Product Action/interrupt/serializer 无 diff。 |

性能测试必须使用同一字体资产和相同用例；结果与 P1 基线并列记录。

#### P2.5 实施顺序

1. 记录 P1 后 cold baseline；
2. 实施二分换行和共享 cache，先跑所有 layout correctness tests；
3. 实施有界 beam selection 和 coverage/minimum-composition 约束；
4. 增加确定性、cache、beam 和契约回归；
5. 重跑 layout suite、全量 unit、Ruff、mypy、架构测试；
6. 写入 P2 实测结果，再开始 P3。

#### P2.6 完成定义

- 单次确定性布局优化 p95 `<= 300ms`；
- 现有布局测试集总耗时 `<= 3s`；
- 相同输入/profile 的 structure 和 report 完全确定；
- JD coverage、事实来源、item 最小组成和所有 P1 硬门不回退；
- 最终仍只有一个 resume variant；
- 公开契约 diff 为零；
- 新增测试与全量回归通过，P2 变更文件 Ruff/mypy 通过。

#### P2.7 实施结果（2026-07-18）

**工程状态**：完成，绝对性能目标达到。

已实施 exact FreeType width/wrap 有界共享 cache、二分换行定位、确定性 bullet 重组和 coverage-preserving bounded beam selection。显式多页请求不会被单页 beam 裁剪；默认请求仍是硬单页。内部搜索不创建额外 variant。

同机同字体结果：

```text
P1 后 cold layout 基线：13 passed in 93.13s
P2 correctness/performance suite：16 passed in 1.06s
最慢 beam determinism 用例：0.27s
最慢标准 optimizer 用例：0.17s
30 次 cold-cache optimizer：p50 119.630ms / p95 128.116ms / max 128.678ms
```

相对本次 P1 后 layout suite 基线下降约 `98.9%`，满足 suite `<=3s` 和 optimizer p95 `<=300ms`。新增测试保护 cache 前后测量一致、beam 确定性、唯一 JD coverage、每 item 至少两条 bullet、显式多页内容不被裁剪以及单 variant 不变量。

### P3：局部模型修复

**预计**：1 天

#### P3.1 阶段边界与调用预算

P3 只处理 P2 确定性重组/搜索后仍存在的 `bullet_too_short` 或 `bullet_awkward_wrap`。不再把整份 structured resume 发给模型重写：

- 常规请求：`1` 次完整生成，`0` 次局部修复；
- 困难请求：`1` 次完整生成，最多 `1` 次批量局部修复；
- page overflow、profile/font mismatch、事实错误和 coverage 回退不触发局部模型修复，直接按各自流程失败或由确定性逻辑处理；
- 一次调用覆盖全部失败 bullet，不允许逐 bullet 串行调用；
- 修复前后始终是同一个 resume variant，模型返回的文本备选只是瞬时内部数据。

公开 HTTP、Product Action、interrupt、serializer 和 `qualityStatus` 契约继续冻结。

#### P3.2 局部修复数据契约

每个 target 只包含：

- `bullet_id`、当前文本、实际行数/尾行比例/目标比例；
- 当前 `source_fact_ids` 与 `matched_jd_requirement_ids`；
- 同一 `source_experience_id` 的原始内容和 claims；
- 允许的数字、事实 ID 和语言；
- 指令：扩写、压缩、合并措辞，但不得新增事实、数字或 JD coverage 声明。

模型响应按 `bullet_id` 返回最多三个内部文本备选。响应不得包含整份 resume、item 标题、组织、日期或其它通过 bullet。

#### P3.3 后端确定性选优与写回

领域服务逐 target 执行：

1. 拒绝未知/重复 bullet ID；
2. 拒绝不属于对应 source experience 的 fact ID、未知数字和新增 JD requirement ID；
3. 用 P2 缓存测量每个文本备选；只保留通过 `0.667` gate 的结果；
4. 按“距离 target ratio、与原文长度差、稳定文本序”确定性选一条；
5. 只更新原 bullet 的 `text/source_fact_ids/matched_jd_requirement_ids`，其余 structure 不变；
6. 任一 target 没有合法通过项，则整批不写回，进入明确失败。

Graph 写回后必须重新经过 `layout_measure → fact_check → coverage_check → self_review → quality_gate`；不会直接持久化。

#### P3.4 逐文件实施方案

| 文件 | 类型 | 具体改动 |
|---|---|---|
| `app/domain/resume/repair_models.py` | 新增 | 定义批量 target/candidate/response Pydantic 模型；无 Graph/Provider 依赖。 |
| `app/domain/resume/repair_service.py` | 新增 | 校验来源、数字、coverage，调用 `ResumeLayoutService` 测量并确定性选优，原子返回一份 patched structure 或失败。 |
| `app/graphs/resume/nodes.py` | 修改 | `layout_route` 仅把残余 bullet width 问题送到 `layout_revision`；节点改为一次 batch local call，不再请求 `_LlmResumeStructure` 或发送完整 resume；写回后清空旧 layout report。 |
| `app/graphs/resume/state.py` | 修改 | 增加内部 `local_repair_call_count/status`；不进入对外 payload。 |
| `app/core/config.py` | 修改 | 增加 `max_resume_local_repair_calls=1` 的有界配置。 |

#### P3.5 测试方案

| 文件 | 关键断言 |
|---|---|
| `tests/unit/test_domain/test_resume_repair.py` | 多 target 一次选择；未知 bullet/fact/数字/coverage 拒绝；不通过 gate 拒绝；确定性选优；失败时 structure 不变。 |
| `tests/unit/test_graphs/test_resume_local_repair.py` | 一次 provider 调用覆盖全部失败 bullet；prompt 不含完整 resume/通过 bullet；写回仍只有一个 variant；预算耗尽失败；成功后回到完整质量链。 |
| `tests/unit/test_graphs/test_resume_layout_flow.py` | 非 bullet 硬违规不调用局部模型；局部修复失败不会 persist/review。 |
| `tests/unit/test_api_contracts.py` | P3 前后公开契约无 diff。 |

#### P3.6 实施顺序与完成定义

1. 先实现纯 domain schema/service 和恶意候选拒绝测试；
2. 替换 whole-resume `layout_revision_node`；
3. 收紧 route 和一次调用预算；
4. 验证修复后完整质量链、单 variant 与 contract freeze；
5. 跑 P0–P3 全量 unit、Ruff、mypy、架构边界和可用的 integration；
6. 把实际结果写入 P3 完成记录。

完成时必须满足：困难请求最多一次 batch local call；没有 whole-resume revision call；任何非法或仍不合格的备选均不写回；最终只显示/持久化一个通过全部门禁的 variant；公开契约 diff 为零。

#### P3.7 实施结果（2026-07-18）

**工程状态**：代码与确定性测试完成；真实模型成功率验收未通过，不能标记为正式完成。

已完成：

- 新增纯 domain `BulletRepairBatch` schema 与 `ResumeBulletRepairService`；
- 旧 whole-resume `layout_revision_node` 已替换为一次批量局部调用；prompt 只包含失败 bullet、对应 source experience 和允许的 facts，不包含整份 resume 或通过 bullet；
- 每个失败 bullet 最多三个内部文本备选；未知/重复 bullet、未知 fact、空 grounding、未知数字、新增/丢失 coverage、尾句句号和仍未通过 gate 的文本全部拒绝；
- 后端按尾行目标距离、原文长度差和稳定文本序确定性选一条；整批原子写回同一个 variant，其余备选不持久化；
- 非 bullet 硬违规不调用局部模型；`max_resume_local_repair_calls=1`；修复后仍沿原图重新执行 layout、fact、coverage、review 和 quality gate；
- 一次调用覆盖多个失败 bullet 的测试通过，且 provider 调用计数严格为一。

最终验证：

```text
P3 + 质量门 + API contract 定向回归：46 passed
最终 unit suite：307 passed in 8.98s
最终 layout suite：16 passed in 1.06s
架构/Graph/API contract：37 passed
变更范围 Ruff：通过
变更范围 mypy（17 个核心 source files）：通过
```

仓库级静态检查的既有债务未混入本次修改：全仓 mypy 仍有 29 个历史错误，集中在 artifact、user repo、SSE typing 和 resume edit typing；全仓 Ruff 仍有 3 个历史问题。P0–P3 所有变更文件自身检查通过。

### P0–P3 数据库迁移与真实后端实测（2026-07-18）

#### 数据安全与测试边界

- 用户提供的账号已通过真实 `POST /v1/auth/login` 验证，登录 HTTP 200；只读取了资源数量和 ID；
- 未把该账号的真实 JD、经历或简历发送给配置的外部模型服务；端到端生成使用隔离的 `codex-p0p3-*` 合成账号和完全合成的数据；
- 对外 API contract 没有为实测增加 endpoint 或字段；默认后端最终恢复在 `127.0.0.1:8000`，临时受控实例已关闭。

#### PostgreSQL 迁移结果

真实 Docker PostgreSQL 从 `0014` 顺序升级：

```text
0014 -> 0015  resume_generation_runs + resume_layout_observations
0015 -> 0016  resume_variants quality_status/quality_issues/quality_gate_version
alembic current = 0016
```

迁移后检查：

- 两张 P0 表真实存在；
- 三个 P1 字段真实存在且约束生效；
- 18 条历史 variant 回填为 `quality_status=unverified`；其中用户账号已有的 3 条 variant 也保持 `unverified`；
- 迁移前该用户观测 run 为 0，迁移和实测后可查询完整 run、node、embedding、database、layout、LLM 指标。

#### 实测发现并当场修复的问题

| 问题 | 修复前 | 修复后 |
|---|---|---|
| 本地 embedding 首次并发加载/推理 | context 的 evidence/guideline 分支同时调用 SentenceTransformer，在 macOS/PyTorch 触发 native `double free`，后端进程退出 | `LocalEmbeddingProvider` 使用进程内 `RLock` 串行化同一模型的 load+encode 临界区；真实冷启动及后续 4 次完整生成未再崩溃；增加并发回归测试 |
| P0 metrics JSONB | `finish_run` 先 `json.dumps`，又被 asyncpg JSON codec 编码，数据库 `jsonb_typeof(metrics)=string` | repository 直接传 Python object；新 run 的 `jsonb_typeof(metrics)=object`，SQL JSON operator 可直接统计 |
| P1 variant JSONB | 新 variant 的 structured/score/quality_issues 也存在重复编码风险 | 新写入直接交给 JSON codec；`quality_issues` 保持真实 JSON array |
| 无 `config` 参数节点的 trace | `package_plan`、`cot_planning`、`draft_generation` 及其 LLM 调用未获得 recorder；实测只有 5 个 node span、0 个 LLM span | wrapper 暴露真实运行时 `RunnableConfig` 签名；LangGraph 编译回归测试通过；新 run 记录 10 个 node span、3 个 LLM span |

#### 前后数据对比

| 指标 | 修复/迁移前 | 修复/迁移后真实结果 |
|---|---:|---:|
| Alembic 版本 | `0014` | `0016` |
| P0 观测表 | 0 张 | 2 张 |
| 历史 variant 质量状态 | 无持久化字段 | 18 条回填 `unverified` |
| 首次并发 embedding | 后端 native 崩溃 | 冷启动和 4 次完整生成无崩溃 |
| metrics 数据库类型 | JSONB 内部为 `string` | JSONB `object` |
| 完整 trace node 数 | 5（LLM 节点缺失） | 10 |
| 完整 trace LLM span 数 | 0 | 3 |
| 默认 80% 页面门槛 | 旧链路可保存未验证结果 | 2/2 合成 run 进入 `resume_content_gap`，0 个 variant 持久化 |
| P2 layout optimize | 旧 13 项布局测试约 93.13 秒 | 16 项 1.06 秒；真实 run 72–184ms，局部修复后重复优化 3–11ms |
| P3 局部调用预算 | 旧 whole-resume revision | 每个困难 run 恰好 1 次 `layout_revision`；45.226s / 70.164s |
| P3 实际修复成功 | 无有效基线 | 0/2；两批均被确定性校验原子拒绝，0 个不合格 variant 落库 |

真实端到端样例明细：

- 默认配置 run：179.720s、页面使用率 30.14%，正确进入 `resume_content_gap`；
- 后端 gate 开启 run：63.225s、页面使用率 42.25%，仍正确进入 `resume_content_gap`；
- 受控 30%/40% 密度阈值仅用于覆盖 P3：91.611s 和 206.472s；每次都运行一次局部 batch 修复，随后因仍存在短 bullet 进入 `output_failure`；
- 最新 P0 trace 正确统计 3 个逻辑 LLM 调用、5–6 个物理请求和 token；端到端主要瓶颈是结构化 LLM/协议 fallback，不是 P2 排版器。

#### 实测结论

- **P0：通过实测**。迁移、失败闭合、JSONB、节点/Provider 观测均已验证；正式 30-run 生产基线仍待采集。
- **P1：安全性通过实测**。页面密度或 bullet 门槛不满足时不持久化、不进入 review；单 variant 成功持久化路径因没有合格输出，尚未取得真实成功样本。
- **P2：通过实测**。确定性布局在真实链路为毫秒级，缓存命中后的重复优化进一步下降到 3–11ms。
- **P3：约束通过、效果未通过**。一次 batch、局部 prompt、完整复测和原子拒绝均符合设计，但同一合成样例连续两次修复成功率为 0%；在修复 prompt/候选策略并通过固定真实样例前，不得把 P3 标记为正式完成。

### P4：浏览器校准与端到端门禁

**预计**：1–2 天，需要前端配合

任务：

- 统一 preview、review、print、application package 的简历组件；
- 完成字体加载、DOM 尺寸和尾行测量；
- 校准后端 profile 与真实 DOM 的误差；
- 增加浏览器端到端截图和尺寸断言；
- 校准稳定后再启用 `resume_layout_hard_gate_enabled`。

### P5：LLM、RAG 与协议速度优化

**预计**：1–2 天

任务：

- 为 provider/model 缓存可用的 structured output 协议；
- 已知供应商直接使用已验证模式，避免每次重复探测；
- 将失败模式的重试与协议 fallback 分开计数并限制总预算；
- 复用 JD requirement embedding，避免 retrieval 和 evidence pack 重复编码；
- 缓存稳定的 guideline 查询结果；
- 按一页候选预算裁剪 prompt，只发送有机会入选的来源事实；
- 保持 context 数据库读取并行。

整体目标：

- 常规请求完整 LLM 调用次数为 `1`；
- 困难请求总 LLM 调用次数不超过 `2`；
- 相对 P0 基线，端到端 p50 至少下降 `40%`；
- 相对 P0 基线，端到端 p95 至少下降 `30%`；
- 不以降低事实质量、JD coverage 或字体可读性换取速度。

## 6. 测试计划

### 6.1 Domain 单元测试

- `0.666x` 失败、`0.667+` 通过；
- 中文、英文、混合技术栈和数字/百分号换行；
- 所有单行和多行 bullet 均执行同一尾行门槛；
- 不允许 `layout_exception` 绕过硬门槛；
- 一页、overflow、临界 block 和 section heading 分页；
- 同一候选池的最优组合稳定；
- facts 和 coverage 不因合并、拆分或删除而丢失。

### 6.2 Graph 流程测试

- 默认生成使用 `max_pages=1`；
- 只有显式多页请求允许多页；
- bullet-only 违规进入确定性或局部修复，不得直接进入 fact check；
- 达到修复上限仍失败时不得 persist/output review；
- 局部修复后必须重新经过 layout、fact、coverage 和 quality gate；
- 所有生成入口得到相同质量契约。

### 6.3 Provider 测试

- 已缓存 structured output 模式只发起一次网络调用；
- 模式失效时允许有限 fallback，并更新 capability cache；
- fallback 与 transport retry 共享明确的总调用上限；
- 记录模型调用次数和 token usage。

### 6.4 浏览器端到端测试

固定样例至少覆盖：

- 本次两页问题简历；
- 中文宋体；
- 英文 Times New Roman；
- 中英文混排和长技术名称；
- 恰好靠近 `66.7%` 的尾行；
- 恰好靠近一页底部的 section/item；
- preview、review、print 三种入口。

每个样例断言：

```text
rendered_page_count == 1
overflow_px <= tolerance
every_bullet_last_line_ratio >= 0.667
font_profile_hash matches
```

## 7. 最终验收标准

### 质量

- 固定回归集的浏览器真实一页通过率：`100%`；
- 所有 bullet 最后一行真实比例：`>= 0.667`；
- 不合格候选保存率：`0%`；
- 不合格候选展示为完成简历的比例：`0%`；
- 事实错误：`0`；
- 布局导致的已证实 JD coverage 回退：`0`；
- preview 与 print 的分页和换行结果一致。

### 性能

- 常规请求：一次完整 LLM 调用；
- 困难请求：最多一次完整调用加一次局部调用；
- 布局优化 p95：`<= 300ms`；
- 布局测试集：`<= 3s`；
- 端到端 p50 相对基线下降至少 `40%`；
- 端到端 p95 相对基线下降至少 `30%`。

### 可观测性

每次生成可追踪：

- context assembly 耗时；
- embedding 和数据库耗时；
- LLM 调用次数、协议模式、重试、token 和耗时；
- layout optimize 耗时与候选数；
- 后端估算与浏览器真实值的差异；
- 最终质量门结果和失败原因。

## 8. 实施顺序与发布策略

推荐顺序：

```text
P0 观测与复现
  → P1 质量硬门禁、移除旁路
  → P2 快速确定性排版器
  → P3 局部修复
  → P4 浏览器真实门禁
  → P5 LLM/RAG 速度收尾
```

发布分两步：

1. **质量保护发布**：完成 P1 后立即发布，宁可明确失败，也不输出两页或短尾行简历；
2. **质量与速度完整发布**：P2–P5 通过固定样例、浏览器端到端和性能门槛后启用。

任何阶段都不得通过降低字号到不可读范围、缩窄安全边距、编造经历或跳过事实检查来满足一页目标。
