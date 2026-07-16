# 简历版面与生成质量改造规划

**状态**：审核后已修订，待实施

**修订日期**：2026-07-16

**适用范围**：后端 `/Users/apple/cv-agent` + 前端 `/Users/apple/cv_agent_frontend`

## 1. 目标与范围边界

本次改造的目标是提升最终简历的内容质量、事实可靠性和 A4 版面稳定性，让后端在返回结果前完成有限次数的生成、测量、改写和质量检查。

### 1.1 前端允许改动的范围

前端只能修改现有简历预览相关代码：

- `src/components/ResumeSampleTemplate.vue`；
- `src/pages/index/index.vue` 中的简历预览分支、预览容器样式和打印样式；
- 简历预览直接使用的类型声明、固定字体资源和预览测试；
- 将聊天简历预览、生成结果审阅预览、简历工作区预览、旧简历只读预览和打印统一到同一个模板组件。

前端禁止修改：

- 登录、注册、导航和普通聊天逻辑；
- 简历编辑器的业务能力和交互流程；
- 经历库、JD、Artifact 等非简历预览功能；
- 让前端参与后端每一轮测量或改写。

旧结构化数据和旧 Markdown 简历仍需支持只读预览，但必须通过统一模板的兼容入口渲染，不再维护另一套独立 `.a4-canvas` 简历模板。

### 1.2 后端允许改动的范围

后端只修改简历生成相关内容：

- `domain/resume` 中的模板契约、版面模型、测量服务和生成质量规则；
- `graphs/resume` 中的生成、版面修订、事实检查、覆盖检查、自审和质量门；
- 为简历版面测量提供字体指标实现所必需的 `infra` 和依赖注入代码；
- 简历生成相关配置、测试和固定测试样例。

不修改 open-ended agent、Artifact 生成链路或 Router 核心逻辑；不为本次改造新增通用 Tool，也不扩展 Tool Registry scope。

## 2. 已确认的产品规则

1. 最终纸张使用 **A4 portrait：210mm × 297mm**。
2. `summary` section 不生成、不持久化、不渲染，也不参与事实检查、覆盖检查或版面计算。
3. 用户未指定页数时，默认最多一张 A4。
4. 用户明确要求两页或多页时，取消单页上限，但仍需保证自然分页和内容密度。
5. 实习/工作经历和项目经历中的 bullet：
   - 单行 bullet 以正文可用宽度的 `2/3` 为质量目标；
   - 多行 bullet 的最后一行必须达到正文可用宽度的 `2/3`；
   - 必须自然结尾，禁止字符截断或省略号式硬裁剪。
6. 不得为了版面补充无来源事实、空泛套话或夸大表述。
7. 版面修订不得破坏事实一致性和已有的、可被证据支持的 JD 覆盖。
8. 后端闭环完成生成和修订，前端只渲染最终候选及用户明确决策所需的预览。

### 2.1 无法满足 bullet 长度时的处理规则

当 bullet 未达到长度目标但来源中没有更多事实时，按以下顺序处理：

1. 在不改变事实的前提下调整表达，使内容落在更自然的行数；
2. 如果是低价值或重复 bullet，则删除；
3. 如果是必须保留的关键事实，则记录 `unfixable_grounded_short`；
4. 单行 bullet 的该状态可以作为带原因的软例外；
5. 多行 bullet 最后一行仍不达标时不得静默通过，应继续修订或进入 `needs_user_decision`。

## 3. 当前架构事实

前端结构化简历模板位于：

- `/Users/apple/cv_agent_frontend/src/components/ResumeSampleTemplate.vue`；
- `/Users/apple/cv_agent_frontend/src/pages/index/index.vue`。

当前存在以下需要统一的问题：

- `ResumeSampleTemplate` 使用 Letter 尺寸，打印规则也是 Letter；
- `index.vue` 中仍存在多处独立 `.a4-canvas` 或 Markdown 简历预览；
- 模板使用系统字体回退，中文和英文在不同设备上的字宽不稳定；
- `compact` 和移动端样式会改变字号、padding 和内容宽度，预览结果不再等价于打印模板；
- 前端会过滤 summary，但后端生成 prompt 仍明确要求生成 summary；
- resume graph 直接执行节点，并不存在通过 Tool Registry 调用工具的独立 `resume_writer` agent；
- draft 生成后当前会立即推送内容 diff，不符合“内部修订完成后一次性返回最终候选”的目标；
- self-review 达到轮数上限时当前可能直接视为通过，需要改成显式质量状态。

## 4. 固定模板契约 `ResumeLayoutProfile`

后端新增：

- `app/domain/resume/layout_profile.py`；
- `app/domain/resume/layout_models.py`；
- `app/domain/resume/layout_ports.py`；
- `app/domain/resume/layout_service.py`。

### 4.1 Profile 内容

`ResumeLayoutProfile` 至少包含：

- `version`，首版使用 `resume-template-v1`；
- `profile_hash`；
- A4 页面宽度、高度和方向；
- 上下左右 padding；
- 正文宽度和高度；
- 固定字体 family、字体文件标识和字体文件 checksum；
- 正文、姓名、联系方式、section heading、item heading、日期行的字号、字重和行高；
- section、item、raw text 和 bullet 的上下间距；
- bullet marker 宽度、缩进和 gap；
- block 分页规则；
- `summary_rendered = false`；
- 允许的富文本范围。

### 4.2 字体和文本契约

不能继续依赖 `Times New Roman` 等系统字体回退作为精确测量基础。实施时需要选择一套支持中英文、数字和常见标点的固定字体，并同时：

- 作为前端简历预览专用字体资源加载；
- 作为后端字形宽度计算的同版本字体资源；
- 将字体 checksum 纳入 `profile_hash`；
- 在字体加载完成后再认为预览可打印。

结构化简历字段采用以下内容规则：

- bullet、title、organization、role、location 和 date 为纯文本；
- `raw_text` 只允许明确约定的安全行内格式；
- 不允许任意 HTML；
- 前端兼容旧 Markdown 时先进行安全转换，再进入统一模板；
- 后端测量只处理契约允许的格式，不能按简单字符数估算。

### 4.3 版本传递与不匹配处理

后端在最终 `ResumeStructure` 顶层注入：

```json
{
  "layout_profile_version": "resume-template-v1",
  "layout_profile_hash": "..."
}
```

版本和 hash 由后端代码注入，不由 LLM 生成。现有 `structured` JSON 字段可以保存这些信息，不需要数据库迁移。

前端预览组件必须声明自己支持的 profile version/hash：

- 完全匹配时正常渲染和打印；
- 旧版本数据使用兼容渲染，但不能声称通过当前版面质量门；
- 未知版本不得静默套用当前模板，应在现有预览/风险区域给出兼容提示；
- 修改字体、字号、边距、行高、DOM 结构或分页规则时必须升级 version 或 hash，并重新运行校准测试。

## 5. 后端版面测量架构

### 5.1 分层与依赖方向

Domain 层负责纯业务规则：

- `ResumeLayoutService`；
- `LayoutConstraint`；
- `LayoutReport`；
- `PageReport`；
- `SectionLayoutReport`；
- `BulletFitReport`；
- `LayoutViolation`；
- `TextMetricsPort` Protocol。

Domain 不 import FastAPI、LangGraph、数据库、浏览器或具体字体库。

Infra 层实现 `TextMetricsPort`，建议新增：

- `app/infra/layout/font_metrics.py`；
- `app/infra/layout/__init__.py`。

具体实现使用固定字体的真实 glyph advance、字重和换行规则计算宽度。Graph 通过依赖注入获得 `ResumeLayoutService`，不得直接 import `infra`。

本次不新增 `measure_resume_layout` 或 `measure_bullet_fit` Tool。resume graph 直接调用 domain service，避免引入没有实际调用方的 Tool scope 机制，也避免把测量工具暴露给 open-ended agent。

### 5.2 文本换行

测量必须处理：

- 中文、英文、数字、空格和中英文混排；
- 常见中英文标点的禁则和换行机会；
- 字重差异、字距和 kerning；
- bullet marker、缩进和 gap；
- title/date 两列布局；
- 允许的行内格式；
- 显式换行。

不能使用 `len(text)`、固定“中文算 2 个字符”等粗略规则。

### 5.3 `measure_bullet_fit`

对每条 experience/project bullet 返回：

- `line_count`；
- 每一行的实际宽度；
- `last_line_width`；
- `last_line_ratio`；
- `target_ratio = 0.667`；
- `gate_ratio`；
- `status = pass | too_short | awkward_wrap | unfixable_grounded_short`；
- `recommendation = shorten | expand_from_source | rephrase | remove | none`。

后端估算存在不可完全消除的浏览器误差，因此首版校准后采用保守 gate；建议从 `0.70` 开始，通过真实 DOM 样例决定是否调整，但产品展示和验收目标仍为实际渲染 `>= 0.667`。

### 5.4 `measure_resume_layout`

整份简历按真实 block 顺序计算：

1. header；
2. section heading；
3. item heading/date；
4. raw text；
5. bullets；
6. block margin、border 和 page break。

返回：

- 内容区宽度和每页可用高度；
- 每个 block 的起止位置和高度；
- 每页实际使用高度和使用率；
- `page_count`；
- overflow 高度；
- 被迫跨页的 block；
- 所有 bullet fit 报告；
- 所有 layout violation；
- `status = pass | needs_revision | needs_user_decision | profile_mismatch`。

分页不能通过 `ceil(total_height / page_height)` 简化计算。需要逐 block 放置，并与前端的 `break-inside`、`orphans`、`widows` 和标题跟随规则保持一致。

## 6. 后端生成结构改造

修改 `app/graphs/resume/nodes.py` 中的生成 schema、prompt 和结构规范化：

- `_LlmResumeStructure` 不再允许 `summary` section；
- `_DRAFT_SYSTEM_PROMPT` 不再要求 summary；
- 生成阶段以默认页数约束分配经历和 bullet 数量，不再先无上限生成 5～6 条再完全依赖后处理；
- `_assign_structure_ids` 或后续 normalization 再次移除非法 summary；
- normalization 后注入 `layout_profile_version/hash`；
- 只有通过最终质量门的结构才生成用户可见 Markdown 和内容 diff；
- fact check、coverage check 和持久化只接收已经移除 summary 的结构。

前端继续过滤 summary，仅作为旧数据兼容和防御性保护。

## 7. Resume Graph 改造

### 7.1 推荐图结构

```text
context_assembly
  → cot_planning
  → draft_generation
  → layout_measure
      ├─ needs_revision → layout_revision → layout_measure
      ├─ needs_user_decision → fact_check
      └─ pass → fact_check
                  → coverage_check
                  → self_review
                      ├─ needs_revision → revision → draft_generation
                      └─ pass → quality_gate
                                  ├─ passed → persist_draft → output
                                  ├─ needs_user_decision
                                  │    → persist_decision_candidate
                                  │    → output_for_decision
                                  └─ failed → output_failure
```

任何经过 `revision → draft_generation` 产生的新结构都必须重新经过 `layout_measure`、fact check 和 coverage check。

### 7.2 节点职责

- `draft_generation`：生成结构化初稿，不发送用户可见的简历正文；
- `layout_measure`：确定性调用 `ResumeLayoutService`；
- `layout_revision`：只根据结构化 layout report 和来源事实改写必要部分；
- `fact_check`：检查布局修订后的最终事实；
- `coverage_check`：检查有证据支持的 JD requirement 是否因删减产生新缺口；
- `self_review`：检查表达、重复、清晰度和其他内容硬问题；
- `quality_gate`：汇总所有确定性和 LLM 检查结果；
- `persist_draft`：仅在 `passed` 时作为正常候选持久化；
- `persist_decision_candidate`：将仍有可接受版面例外的候选标记为临时决策候选并持久化，使现有 review/accept 流程可以继续使用；
- `output_for_decision`：复用现有 resume review interrupt，不新增前端业务流程；
- `output_failure`：事实错误等不可接受问题达到上限后停止生成，不持久化为可接受候选。

### 7.3 State 字段

在 `ResumeGenerationState` 中新增：

- `layout_constraint`；
- `layout_profile_version`；
- `layout_profile_hash`；
- `layout_report`；
- `layout_revision_iteration`；
- `layout_status`；
- `quality_status = passed | needs_user_decision | failed`；
- `quality_issues`；
- `coverage_before_layout`；
- `generation_call_count`。

现有 `review_iteration` 继续只统计 self-review 修订轮数，不能与 layout 修订轮数混用。

### 7.4 循环上限与失败语义

- layout revision 最多 3 轮；
- self-review revision 最多 3 轮；
- 一次请求的生成/修订 LLM 调用需要设置总上限，建议首版为 7；
- 达到上限不能自动改成 `pass`；
- 仍有页面溢出、多行 bullet 硬违规或需要用户决定的 coverage 取舍时，设置 `quality_status = needs_user_decision`；
- 仍有事实错误、来源不一致或其他不可接受的真实性问题时，设置 `quality_status = failed`，不得向用户提供“接受当前错误候选”的路径；
- `needs_user_decision` 复用现有 `resume_review` 的接受、修改、放弃操作，并在 message、risk summary 和 preview 中明确列出未解决问题；
- 用户明确接受多页或当前候选后，属于显式决策，不能被记录为系统静默通过。

临时决策候选需要在 `structured` metadata 和 `risk_summary` 中记录未解决的 layout/coverage 问题；不要求新增数据库字段。事实失败候选不进入该路径。

### 7.5 SSE 输出时序

内部循环期间只发送简短 thinking/progress 事件，例如：

- 正在组织简历内容；
- 正在检查 A4 版面；
- 正在压缩低信息密度内容；
- 正在核对事实和岗位覆盖。

中间 draft 不发送 `content_diff` 或可编辑 structured snapshot。只有质量门通过或进入明确的用户决策节点时，才一次性发送当前候选，避免前端短暂展示会被内部循环替换的内容。

## 8. 自然改写与删减策略

### 8.1 Bullet 过长或出现尴尬换行

按以下顺序处理：

1. 删除重复主语；
2. 删除空泛形容词和重复背景；
3. 合并同义表达；
4. 调整从句顺序；
5. 保留“动作 + 对象 + 方法/技术 + 结果/指标”；
6. 尝试将短尾行收回上一行，而不是截断末尾。

禁止：

- 从句子中间硬截断；
- 删除会改变事实含义的数字、技术名、组织名或限定词；
- 将“参与”升级为“主导”；
- 添加来源中不存在的事实。

### 8.2 Bullet 过短

只能从来源经历中按以下顺序补充：

1. 负责范围；
2. 方法或技术；
3. 业务对象或场景；
4. 已有结果、规模或指标。

没有可验证内容时，不使用套话填充，按第 2.1 节的软例外、删除或用户决策规则处理。

### 8.3 单页溢出

按以下顺序处理：

1. 压缩重复或低信息密度文本；
2. 合并同一经历中语义重叠的 bullet；
3. 删除低 JD 匹配度且无量化结果的 bullet；
4. 减少低匹配度项目的 bullet 数；
5. 删除最低相关度的项目或工作条目；
6. 保留高匹配度和高证据强度内容；
7. 有来源时，尽量至少保留一条工作/实习经历和一条项目经历；
8. 无法自然放入一页时进入 `needs_user_decision`，不得静默溢出。

教育经历是否全部保留需要遵守现有业务规则；如果完整教育背景导致单页不可满足，应进入用户决策，而不是偷偷删除。

## 9. Coverage 和事实质量门

### 9.1 Coverage 基线

当前 `matched_jd_requirement_ids` 是生成结果中的自声明标签，不能单独作为质量真值。需要结合：

- matching plan；
- evidence pack；
- source experience id；
- 初稿中已覆盖且具有证据的 requirement。

`coverage_before_layout` 记录布局删减前“已覆盖且有证据支持”的 requirement IDs。布局修订后必须保证这些 requirement 不产生新缺口；对于来源本身无法支持的 JD 要求，只记录 risk，不要求模型编造内容来覆盖。

### 9.2 最终质量门

默认单页模式通过条件：

- profile version/hash 匹配；
- `summary` 不存在；
- `page_count <= 1`；
- 无页面 overflow；
- 多行 experience/project bullet 的实际最后一行比例达到 `0.667`；
- 单行短 bullet 已达标，或存在明确、可解释的 `unfixable_grounded_short` 软例外；
- fact check 无硬错误；
- 布局删减未造成新的、可被证据支持的 coverage gap；
- self-review 无其他硬性问题。

多页模式通过条件：

- 不限制 `page_count`；
- 页面分割自然，没有孤立 section heading 或异常 item 拆分；
- 继续执行 bullet、事实、coverage 和 self-review 质量门；
- 不为填充页面添加无依据内容。

## 10. 前端预览改造

### 10.1 `ResumeSampleTemplate.vue`

- 固定内部画布为 `210mm × 297mm`，使用 A4 padding；
- 加载固定简历字体，移除影响字宽的系统 fallback；
- 所有 preview mode 使用同一套字号、宽度、padding、line-height 和 DOM；
- `compact` 只能缩放整个固定画布，不能改变内部字号、间距或换行；
- 移动端通过外层容器缩放或滚动查看，不改内部排版参数；
- 增加与后端一致的 block page-break 规则；
- summary 继续只作为旧数据防御性过滤；
- 旧 Markdown 通过安全兼容转换后进入同一模板；
- 字体未加载完成前不触发打印。

### 10.2 `index.vue` 中允许修改的预览位置

只修改以下简历预览相关分支：

- 简历工作区右侧 PDF 预览；
- 聊天中的 resume canvas 预览；
- `resume_review` / `application_package_review` 的简历预览；
- 旧简历详情弹窗中的只读预览；
- `@media print` 中的 A4 页面和统一模板规则；
- 与上述预览直接相关的 `.a4-canvas` 重复样式清理。

不修改这些区域周围的编辑、保存、聊天发送、审批或导航逻辑。

### 10.3 打印规则

打印必须使用：

```css
@page {
  size: A4 portrait;
  margin: 0;
}
```

打印时只保留统一 `ResumeSampleTemplate`，页面宽度固定为 `210mm`，禁止浏览器自动缩放到 Letter。多页时按模板 block 规则自然分页。

## 11. 测试与校准计划

### 11.1 后端单元测试

新增：

- `tests/unit/domain/test_resume_layout.py`；
- `tests/unit/domain/test_resume_layout_profile.py`；
- `tests/unit/infra/test_resume_font_metrics.py`；
- `tests/unit/test_graphs/test_resume_layout_flow.py`。

覆盖：

- A4 尺寸、padding 和内容区计算；
- profile version/hash；
- 固定字体 checksum；
- 中文、英文、数字、中英文混排和常见标点；
- 普通、粗体和允许的行内格式；
- 一行、两行、多行 bullet；
- `0.667` 目标和保守 gate；
- title/date 双列宽度；
- section/item 分页；
- 单页 overflow 和多页模式；
- summary 在生成、测量、检查和输出中均不存在；
- layout revision 最大轮数；
- 达到轮数上限不会伪造 pass；
- layout 修订后重新 fact check；
- layout 修订前后 coverage 比较；
- 只有最终候选发送 content diff；
- `needs_user_decision` 复用现有 interrupt 契约；
- 决策候选以临时状态持久化并携带明确风险；
- 事实错误达到上限后进入 `failed`，且不产生可接受候选。

不再新增 Tool scope 测试，因为本方案不新增版面测量 Tool。

### 11.2 前端自动化测试

前端不能只做人工回归，需要增加只针对简历预览的自动化测试：

- 模板内部尺寸为 A4；
- 打印 `@page` 为 A4 portrait；
- 所有简历预览入口使用同一组件；
- compact/mobile 不改变内部换行；
- 字体加载成功且 checksum/version 匹配；
- summary 不渲染；
- 旧 Markdown 和旧结构化数据仍能预览；
- 单页 fixture 无 overflow；
- 多页 fixture 的 section/item 分页符合规则；
- 浏览器实际 bullet 行数和最后一行比例可被读取并断言。

### 11.3 跨端校准样例

至少准备 30 份固定 fixture，覆盖：

- 中文、英文和中英文混合简历；
- 短姓名、长姓名和多种联系方式；
- 不同数量的教育、工作和项目；
- 短 bullet、临界 bullet、长 bullet；
- 一页临界高度和多页内容；
- 粗体、链接等允许格式；
- 常见数字、百分比、技术名和标点组合。

后端对 fixture 生成 `LayoutReport`，前端在固定浏览器中读取真实 DOM 指标。首版验收标准：

- page count 判断全部一致；
- bullet 行数全部一致；
- 最后一行比例绝对误差不超过 `0.03`；
- 单页样例没有浏览器实际 overflow；
- 没有 summary；
- 事实和 coverage 测试无回归。

如果达不到上述误差范围，不能把后端估算作为硬质量门；必须先调整字体、profile 或测量实现。

## 12. 实施顺序

建议按以下顺序拆分提交：

1. **前端预览模板基线**：A4、固定字体、统一内部布局、打印规则和 preview-only 自动化测试；
2. **模板契约**：确定 `ResumeLayoutProfile`、version/hash、字体 checksum 和跨端 fixtures；
3. **后端测量能力**：Domain models/service/port + Infra font metrics + 依赖注入；
4. **生成结构清理**：后端移除 summary、注入 profile metadata、按页数约束生成初稿；
5. **Graph 版面循环**：`layout_measure`、`layout_revision`、独立计数和 SSE 输出时序；
6. **最终质量门**：fact、coverage、self-review、`needs_user_decision` 和禁止伪 pass；
7. **前端预览统一**：将剩余旧简历预览入口迁移到统一模板，保留旧数据兼容；
8. **跨端校准与真实样例回归**：达到误差标准后再启用硬质量门。

## 13. 完成定义

只有同时满足以下条件，本改造才视为完成：

- 前端所有简历预览和打印使用同一固定 A4 模板；
- 前端改动未超出简历预览、打印和必要的预览契约范围；
- 后端改动未扩散到 open-ended、Artifact 或无关业务链路；
- summary 不再进入新生成简历的任何阶段；
- 默认单页候选在固定浏览器中实际不溢出；
- 多页候选自然分页；
- bullet 规则有确定性报告和明确例外语义；
- 版面修订后事实与证据 coverage 不退化；
- 达到循环上限时不会伪造通过；
- 事实错误不会进入可接受候选或被用户显式接受的例外路径；
- 中间 draft 不会作为最终内容提前发送；
- 跨端校准达到既定误差标准；
- ruff、mypy、pytest 和前端 preview-only 测试全部通过。

本规划仅定义实施方案，当前尚未修改前后端业务代码。
