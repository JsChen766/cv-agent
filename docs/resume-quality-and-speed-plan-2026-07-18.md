# 简历单页质量与生成速度优化计划

**状态**：待实施  
**日期**：2026-07-18  
**优先级**：质量硬门禁优先；在不增加整份简历 LLM 重试的前提下同步优化速度

## 1. 背景

实测生成结果存在以下问题：

1. 简历生成耗时过长；
2. 部分 bullet 的最后一行未达到可用行宽的 `66.7%`；
3. 默认生成结果可能在浏览器中排成两页。

本计划的核心目标不是继续堆叠整份简历的 LLM 修订轮次，而是采用：

```text
一次完整候选池生成
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

### 4.2 一次完整生成候选池

LLM 首次调用不直接决定最终页面内容，而是生成带来源信息的候选池：

- 每条 bullet 保留 `source_experience_id`；
- 每条 bullet 保留 `source_fact_ids`；
- 每条 bullet 保留 `matched_jd_requirement_ids`；
- 同一来源事实不得通过同义改写重复占位；
- 候选按 JD 价值、量化结果、责任与方法排序。

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
- 每条失败 bullet 返回 `2–3` 个有来源的等价候选；
- 后端重新测量并确定性选择；
- 禁止重新生成整份简历。

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

## 5. 实施阶段

### P0：建立观测基线与回归样例

**预计**：0.5–1 天

任务：

- 保存本次问题简历的 structured payload、layout report 和真实 DOM 指标；
- 为每个 resume graph node 记录 `duration_ms`；
- 记录 LLM model、structured output 模式、协议尝试次数、重试次数、输入/输出 token；
- 记录 embedding、数据库读取、布局测量和持久化耗时；
- 建立中英文、稀疏/密集、长数字/英文技术栈、临界换行等固定样例集。

交付物：

- 可复现本次截图问题的回归 fixture；
- 当前端到端 p50/p95；
- 各阶段耗时占比和 LLM 实际调用次数。

### P1：锁死质量门禁并移除旁路

**预计**：1 天

任务：

- 默认设置硬性一页约束；
- 显式多页请求才允许 `max_pages=None`；
- 两页、overflow、短尾行不得进入 `resume_review`；
- 移除直接 Markdown 生成旁路；
- 将所有入口调度到统一 subgraph；
- 修改现有测试，禁止 `bullet-only` 问题跳过修复；
- 不合格结果不得持久化为可接受 variant。

该阶段完成后，即使速度尚未优化，也必须先停止不合格结果流出。

### P2：高质量、低延迟的确定性排版器

**预计**：2–3 天

任务：

- 换行测量改为前缀宽度缓存、二分定位或等价的近线性算法；
- 对 `(text, style, width, language, profile_hash)` 缓存 bullet fit；
- 预计算 block 高度，候选变化时增量更新；
- 使用 DP/beam search 联合选择候选，而非逐条删除并全量重测；
- 将 item 的 `break-inside` 和 section heading keep-with-next 行为纳入搜索；
- 在搜索内部执行确定性 bullet 重组。

性能目标：

- 单次确定性布局优化 p95 `<= 300ms`；
- 现有布局测试集总耗时从约 `25s` 降至 `3s` 以内；
- 优化器结果在同输入、同 profile 下完全确定。

### P3：局部模型修复

**预计**：1 天

任务：

- 定义失败 bullet 的局部修复 schema；
- 一次批量修复所有失败 bullet；
- 后端从多个候选中确定性选优；
- 局部修复后重新执行 layout、fact、coverage 和质量门；
- 达到调用上限仍失败时明确结束，不输出坏候选。

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
