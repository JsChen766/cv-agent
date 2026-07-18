# 前端简历模板、预览与打印改造 Handoff

**日期**：2026-07-18  
**面向团队**：前端开发、前端设计、前后端联调、QA  
**状态**：待前端评审与排期；后端兼容代码已完成，生产开关尚未开启

## 1. 目标

本次前端改造用于配合后端已经完成的简历质量与速度优化，使系统能够：

1. 使用同一套 HTML 结构完成简历预览、审核、application package 和浏览器打印；
2. 支持标准版和内容较少时使用的稀疏版简历；
3. 保证前后端使用同一份 A4、字体、字号、间距和分页契约；
4. 在字体加载完成后测量浏览器真实页数、overflow、页面使用率和 bullet 尾行宽度；
5. 保持事实内容与视觉模板分离，不通过虚构、重复或无意义内容填满页面；
6. 为后端后续开启稀疏模板和浏览器硬门禁提供可靠前置条件。

本轮不是单纯增加一个新皮肤，而是建立简历从结构化数据到 HTML、预览、测量和打印的统一渲染链路。

## 2. 后端当前状态

后端已经完成：

- 标准模板 `resume-standard / resume-template-v2`；
- 稀疏模板 `resume-sparse / resume-sparse-v1`；
- 模板 registry、profile version 和 profile hash；
- A4 后端快速测量与确定性模板选择；
- 按经历并行生成的受控实验路径；
- P3 bullet 局部修复诊断；
- 前后端共享模板 manifest。

以下后端开关当前默认关闭：

```env
RESUME_PARALLEL_GENERATION_ENABLED=false
RESUME_SPARSE_TEMPLATE_ENABLED=false
RESUME_LAYOUT_HARD_GATE_ENABLED=false
```

前端不需要感知并行生成过程。无论后端是整份生成还是按经历并行生成，前端都只接收和渲染一份最终简历。

稀疏模板开关必须在前端完成 `resume-sparse-v1` 渲染、打印和测量后才能开启。浏览器硬门禁必须在真实 DOM 校准通过后才能开启。

## 3. 核心架构决策

### 3.1 单一结构化渲染器

前端只维护一个简历 DOM 结构，不为标准版和稀疏版复制两套 JSX/Vue 模板。两套模板通过 manifest 转换出的 design tokens 和 CSS variables 表达。

```text
resume.structured
  → 校验 template/profile/hash
  → 读取模板 manifest
  → ResumeDocument
      ├─ ResumeHeader
      ├─ ResumeSection
      ├─ ResumeItem
      └─ ResumeBullet
  → 同一 DOM 用于 preview / review / application package / print
```

### 3.2 内容与表现分离

- `resume.structured` 是内容和稳定 ID 的事实来源；
- manifest 是尺寸、字体和排版 token 的事实来源；
- HTML/CSS 是浏览器 renderer；
- Markdown `content` 只作为旧数据或异常情况下的兼容预览，不作为新版打印主路径；
- 浏览器 DOM 是实际分页和换行的最终事实来源。

### 3.3 不让后端解析 HTML

后端不读取前端 HTML/CSS，也不负责生成 PDF。后端使用同一 manifest 和字体做快速估算；前端使用 HTML/CSS 做真实渲染并通过浏览器 print-to-PDF 导出。

### 3.4 第一版不提供手动模板选择器

标准版或稀疏版由后端根据可验证内容量确定。第一版前端不增加“选择模板”入口，以免用户选择与后端测量 profile 不一致。未来如需手动切换，必须重新走 layout 测量，而不是只在本地换 CSS。

## 4. 权威模板契约

权威 manifest：

[`contracts/resume-layout-templates-v1.json`](../contracts/resume-layout-templates-v1.json)

现有后端同步检查：

```powershell
.\.venv\Scripts\python.exe scripts\export_resume_layout_templates.py --check
```

如果前后端是两个仓库，前端应把 manifest 作为生成型 contract 资产同步到前端仓库，并在 CI 中检查：

- `schema_version`；
- `template_id`；
- `profile_version`；
- `profile_hash`；
- manifest 内容是否与后端源文件一致。

前端组件中不得另写一套独立字号、间距或 A4 尺寸常量。设计稿标注值也应以 manifest 为基线。

## 5. 数据契约

### 5.1 简历结构

`resume.structured` 内部字段保持后端 snake_case：

```ts
export type ResumeTemplateId = "resume-standard" | "resume-sparse";

export interface ResumeLayoutTuning {
  body_font_scale: number;
  body_line_height: number;
  section_gap_scale: number;
  item_gap_scale: number;
  bullet_gap_scale: number;
}

export interface ResumeStructured {
  language: string;
  contact?: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    location?: string | null;
  } | null;
  sections: ResumeSection[];
  layout_template_id: ResumeTemplateId;
  layout_profile_version: string;
  layout_profile_hash: string;
  layout_tuning?: ResumeLayoutTuning;
  layout_usage_ratio?: number;
  layout_target_band?: {
    minimum: number;
    target: number;
    maximum: number;
  };
}

export interface ResumeSection {
  id: string;
  type: "education" | "experience" | "project" | "skills" | "other";
  heading: string;
  items: ResumeItem[];
}

export interface ResumeItem {
  id: string;
  title?: string | null;
  organization?: string | null;
  role?: string | null;
  location?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  source_experience_id?: string | null;
  raw_text?: string | null;
  bullets: ResumeBullet[];
}

export interface ResumeBullet {
  id: string;
  text: string;
  source_fact_ids?: string[];
  matched_jd_requirement_ids?: string[];
}
```

前端必须把 section、item、bullet 的后端 ID 渲染到 DOM `data-*` 属性中，尤其不能在前端重新生成 bullet ID。

### 5.2 单份简历而非多变体

当前成功终态只显示一份简历。`resume_review` 和 `application_package_review` 应优先读取单个 `resume` 字段；历史文档和旧响应中的 `variants` 属于兼容字段，不应继续设计多卡片、多候选切换 UI。

旧版本 [`frontend-integration.md`](./frontend-integration.md) 中部分 `variants[]` 示例已经过时，本次实现以实际接口 payload、单个 `resume` 和 `resume.structured` 为准。旧历史数据缺少 `structured` 时才回退到 Markdown `content`。

### 5.3 `resume_content_gap`

当真实经历内容不足时，后端可能返回：

```ts
interface ResumeContentGapInterrupt {
  type: "resume_content_gap";
  current_usage_ratio: number;
  target_usage_ratio: number;
  missing_height_mm: number;
  approximate_missing_lines: number;
  suggestions: Array<{
    experience_id: string;
    title: string;
    jd_match_score: number;
    questions: string[];
  }>;
}
```

设计上应把它表现为“需要补充真实经历”，不能表现为系统错误，也不能让用户通过降低字号或生成虚构内容绕过。

## 6. 前端组件与模块建议

具体目录名由前端仓库约定决定，建议职责如下：

```text
resume/
├── contracts/
│   ├── resume-layout-templates-v1.json
│   └── resume-types.ts
├── template/
│   ├── loadResumeTemplate.ts
│   ├── resumeTemplateTokens.ts
│   └── validateResumeProfile.ts
├── renderer/
│   ├── ResumeDocument.tsx
│   ├── ResumeHeader.tsx
│   ├── ResumeSection.tsx
│   ├── ResumeItem.tsx
│   └── ResumeBullet.tsx
├── measurement/
│   ├── measureResumeDom.ts
│   ├── measureBulletLastLine.ts
│   └── useResumeLayoutVerification.ts
├── print/
│   ├── ResumePrintPortal.tsx
│   └── resume-print.css
└── tests/
```

职责要求：

- `loadResumeTemplate`：按 `layout_template_id` 查找 manifest；
- `validateResumeProfile`：校验 template/version/hash；
- `resumeTemplateTokens`：将 manifest 和 `layout_tuning` 转换为 CSS variables；
- `ResumeDocument`：唯一结构化 renderer；
- `measureResumeDom`：只读 DOM，不修改内容；
- `ResumePrintPortal`：复用同一个 `ResumeDocument`，不能重新拼装另一份 HTML。

## 7. 设计规范

### 7.1 共同原则

- A4 纵向、单栏、ATS 友好；
- 不使用复杂双栏、图表、技能进度条或仅靠图标表达的信息；
- 所有文本保持可选择和可复制；
- section heading 与首个 item 保持在一起；
- item 默认 `break-inside: avoid`；
- 联系方式不能只用图标，图标存在时必须同时保留文本；
- 不新增 summary/profile/about 等无来源内容；
- 不通过缩小到不可读字号满足一页目标。

### 7.2 标准版 `resume-standard`

适用于经历和事实足够、页面信息密度正常的用户。

设计方向：紧凑、专业、信息优先。当前关键值：

- 内容宽度：`192mm`；
- 内容高度：`279mm`；
- 正文字号：`9.75pt`；
- 姓名字号：`17pt`；
- section heading：`11.5pt`；
- 页面目标密度：`80%–95%`，目标 `88%`。

### 7.3 稀疏版 `resume-sparse`

适用于用户真实经历较少，但内容已经完整且不应继续补写或虚构的情况。

设计方向：更舒展、更强层级、适度增加真实内容的视觉占用。当前关键值：

- 内容宽度：`182mm`；
- 内容高度：`269mm`；
- 正文字号：`11.25pt`；
- 姓名字号：`21pt`；
- section heading：`13.5pt`；
- 更大的 header、section、item 和 bullet 间距；
- 页面目标密度：`52%–90%`，目标 `68%`。

允许设计师增强：

- section 分隔线；
- 联系方式的间距与分组；
- 技能文本的标签式排布，但打印后必须仍可读、可复制且 ATS 友好；
- 日期、组织、职位之间更清晰的层级；
- 合理留白。

不允许通过以下方式“填满”页面：

- 重复 bullet；
- 无来源的个人总结；
- 虚构技能、数字或职责；
- 大面积无信息装饰；
- 降低可读性或干扰 ATS 的图形布局。

设计稿应同时覆盖：中文标准版、英文标准版、中文稀疏版、英文稀疏版。

## 8. CSS 与字体实现

### 8.1 CSS variables

所有变量从 manifest 当前模板生成，并叠加后端返回的 `layout_tuning`：

```css
.resume-page {
  --page-width: 210mm;
  --page-height: 297mm;
  --padding-top: 9mm;
  --padding-right: 9mm;
  --padding-bottom: 9mm;
  --padding-left: 9mm;
  --body-font-size: 9.75pt;
  --body-line-height: 1.18;

  box-sizing: border-box;
  width: var(--page-width);
  min-height: var(--page-height);
  padding: var(--padding-top) var(--padding-right)
    var(--padding-bottom) var(--padding-left);
  font-size: var(--body-font-size);
  line-height: var(--body-line-height);
}
```

不要使用 `transform: scale()` 缩放整页。它会导致 DOM 测量、预览和打印结果失真。

### 8.2 字体

manifest 当前要求：

- 中文：`SimSun`；
- 英文：`Times New Roman`。

前端必须提供明确的 `@font-face` 或受控字体资产加载策略，并在测量前：

```ts
await document.fonts.ready;
```

如果目标字体未加载，禁止使用 fallback font 的测量结果冒充通过。UI 应显示字体或模板加载失败，并允许重试。

### 8.3 分页和打印

```css
@page {
  size: A4 portrait;
  margin: 0;
}

@media print {
  body {
    margin: 0;
  }

  .resume-page {
    width: 210mm;
    min-height: 297mm;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }

  .resume-item {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .resume-section-heading {
    break-after: avoid;
    page-break-after: avoid;
  }
}
```

打印时必须隐藏应用导航、按钮、测量提示和编辑控件。浏览器打印缩放保持 `100%`，默认页边距关闭。

## 9. 真实 DOM 测量

### 9.1 测量时机

仅在以下条件同时满足时执行：

1. `resume.structured` 已完整到达；
2. manifest 已加载；
3. template/version/hash 校验通过；
4. `document.fonts.ready` 已完成；
5. renderer 已完成至少两个 `requestAnimationFrame`；
6. 测量容器具有与打印一致的 A4 宽度和 CSS。

编辑、窗口变化或字体重新加载后，需要使旧结果失效并防抖重新测量。

### 9.2 隐藏测量容器

测量容器不能使用 `display: none`，否则没有有效布局尺寸。建议放在视口外：

```css
.resume-measurement-root {
  position: fixed;
  left: -100000px;
  top: 0;
  visibility: hidden;
  pointer-events: none;
}
```

`visibility: hidden` 仍保留布局；不要使用会影响字号或宽度的缩放。

### 9.3 页面使用率和 overflow

以 `.resume-page` 的实际内容区域为准：

```text
availableHeightPx = page content box height
usedHeightPx      = 最后一个有效内容 block 底部 - content box 顶部
overflowPx        = max(0, scrollHeight - clientHeight)
pageUsageRatio    = usedHeightPx / availableHeightPx
pageCount         = max(1, ceil((scrollHeight - tolerance) / clientHeight))
```

浏览器小数像素 tolerance 建议先使用 `1px`，最终值由固定样例校准。不能用后端返回的 `layout_usage_ratio` 替代真实 DOM 测量。

### 9.4 bullet 尾行宽度

每条 bullet DOM 建议：

```html
<li class="resume-bullet" data-bullet-id="bul-...">
  <span aria-hidden="true" class="resume-bullet-marker">•</span>
  <span class="resume-bullet-text">...</span>
</li>
```

可用行宽取 `.resume-bullet-text` 的 content width，不包含 marker、indent 和 gap。

测量包含 inline markup 的文字时，使用 `Range.getClientRects()` 获取片段矩形；按 `top` 在约 `1px` 容差内分组为视觉行。最后一行宽度为该行所有矩形的 `max(right) - min(left)`，不能只取最后一个 inline span 的宽度。

```text
lastLineRatio = lastLineWidthPx / availableLineWidthPx
pass          = lastLineRatio >= 0.667
```

空 bullet、重复 bullet ID、非有限尺寸或 `availableLineWidthPx <= 0` 都视为测量失败。

### 9.5 测量结果模型

前端先实现以下内部模型，即使第一阶段尚未提交后端：

```ts
interface BrowserLayoutObservation {
  run_id?: string | null;
  surface: "preview" | "review" | "print" | "application_package";
  measurement_version: "browser-layout-observation-v1";
  profile_version: string;
  profile_hash: string;
  fonts_ready: boolean;
  loaded_font_families: string[];
  page_count: number;
  overflow_px: number;
  used_height_px: number;
  available_height_px: number;
  viewport: {
    width_px: number;
    height_px: number;
    device_pixel_ratio: number;
  };
  page_metrics: Array<Record<string, unknown>>;
  bullets: Array<{
    bullet_id: string;
    line_count: number;
    last_line_width_px: number;
    available_line_width_px: number;
  }>;
  client_build: string;
  observed_at: string;
  idempotency_key: string;
}
```

当前后端没有为本轮新增公开 DOM observation endpoint。前端第一阶段应完成测量与本地诊断，但不得自行猜测接口地址。提交、重试和恢复协议需要前后端单独评审后再接入。

## 10. 页面状态与交互

前端建议使用以下状态机：

```text
loading_template
  → rendering
  → waiting_fonts
  → measuring
      ├─ verified
      ├─ profile_mismatch
      ├─ font_unavailable
      └─ layout_failed
```

UI 行为：

- `loading_template/rendering/waiting_fonts/measuring`：显示轻量进度，不显示“生成完成”；
- `verified`：允许正式预览和打印；
- `profile_mismatch`：提示刷新或升级客户端，不使用默认模板静默兜底；
- `font_unavailable`：提示字体加载失败并提供重试；
- `layout_failed`：显示具体原因，例如 overflow、多页或失败 bullet 数；
- `resume_content_gap`：展示补充真实经历表单和后端 suggestions；
- 稀疏模板本身不是错误，不显示“内容质量低”等负面文案。

在后端浏览器硬门禁尚未启用期间，可把测量失败作为诊断状态，但打印按钮应至少阻止明显的多页、overflow、字体未加载和 profile mismatch。

## 11. 编辑与重新测量

如果前端支持直接编辑结构化简历：

- 编辑必须保留 section/item/bullet ID；
- 内容改变后立即使 `verified` 状态失效；
- 保存成功后再基于服务端返回的最新 structured snapshot 重新渲染；
- 不在前端自行改变 `layout_template_id/profile/hash`；
- 不在前端自行删除 bullet 来满足一页；
- print 使用的必须是最新已保存且重新测量的结构。

## 12. 测试计划

### 12.1 单元测试

- manifest loader 能加载两套模板；
- 未知 template/version/hash 明确失败；
- manifest token 到 CSS variables 映射正确；
- `layout_tuning` 在允许字段上正确叠加；
- bullet 行分组和尾行宽度计算覆盖单行、多行和多个 inline span；
- 重复 bullet ID、空尺寸和非有限值失败；
- observation idempotency key 稳定且不会碰撞不同内容版本。

### 12.2 组件测试

- `ResumeDocument` 对所有 section 类型正确渲染；
- 缺少可选 contact/item 字段时不产生空占位；
- preview、review、application package 和 print 使用同一 renderer；
- 稀疏版只改变表现，不改变 section/item/bullet 数据；
- Markdown fallback 只用于没有 structured 的历史数据。

### 12.3 浏览器 E2E

至少覆盖：

- 中文标准密集；
- 中文稀疏；
- 英文标准密集；
- 英文稀疏；
- 中英混合技术词；
- 长数字、百分比、URL；
- 尾行刚好通过和刚好失败；
- section heading 临界分页；
- item `break-inside` 临界情况；
- 字体加载失败；
- profile/hash mismatch；
- preview 与 print PDF 对比。

每个成功样例断言：

```text
pageCount == 1
overflowPx <= tolerance
all bullet lastLineRatio >= 0.667
profileVersion/profileHash match manifest
fontsReady == true
preview and print pagination match
```

后端已有回归样例目录：

[`tests/fixtures/resume_regression`](../tests/fixtures/resume_regression)

前端可复用其中脱敏的 structured fixture，但 DOM expected 值必须由前端真实字体和浏览器重新采集，不能照抄后端 Pillow 估算值。

## 13. 设计交付物

前端设计需要交付：

1. 标准版中英文设计稿；
2. 稀疏版中英文设计稿；
3. header、section、item、bullet、skills 的组件规范；
4. loading、measuring、verified、mismatch、font failure、layout failure 状态；
5. `resume_content_gap` 补充经历交互；
6. 预览、编辑、review 和打印前状态；
7. A4 真实尺寸与打印稿检查，不只提供普通网页宽度设计稿。

设计稿不得覆盖 manifest 中影响测量的 token。如设计希望调整字号、边距或间距，应先修改共享 profile、重新生成 hash，再由前后端同步升级。

## 14. 前端开发交付物

前端开发需要交付：

1. manifest 同步与类型定义；
2. profile/hash 校验器；
3. 单一结构化 `ResumeDocument` renderer；
4. standard/sparse token 和 CSS variables；
5. 统一 preview/print 组件；
6. 字体加载与失败处理；
7. DOM page/overflow/usage/bullet 测量；
8. 测量状态和错误 UI；
9. `resume_content_gap` 前端处理；
10. 单元、组件、Playwright 和打印回归测试；
11. 一份前后端校准报告，记录浏览器、字体、样例和误差。

## 15. 实施阶段与发布顺序

### 阶段 FE-0：盘点与冻结

- 找出当前所有 resume preview、review、application package 和 print renderer；
- 确认哪些入口仍只渲染 Markdown；
- 确认当前字体资产和 print CSS；
- 冻结旧组件，避免改造期间继续增加分支。

实施状态（2026-07-18）：**已完成**。

- 前端基线：`cv_agent_frontend` 的 `chy_temp@652b0d4`；
- 已确认 5 个 `ResumeSampleTemplate` 调用入口和 1 个 SSE Markdown 简历旁路；
- application package 与普通 ResumeCanvas 共用同一个聊天画布入口，并通过 surface context 区分；
- A4、字体和 print 当前分别由 `ResumeSampleTemplate.vue` 与页面级 print CSS 共同持有；
- 前端已增加 surface 标记、legacy renderer 冻结标识和机器化冻结测试；
- 完整盘点见前端仓库 `docs/fe0-resume-renderer-inventory-2026-07-18.md`；
- FE-1 合并前继续保持 `RESUME_SPARSE_TEMPLATE_ENABLED=false` 和
  `RESUME_LAYOUT_HARD_GATE_ENABLED=false`。

### 阶段 FE-1：统一标准模板

- 接入 manifest；
- 建立 TypeScript 类型和 profile 校验；
- 以 `ResumeDocument` 替换重复 renderer；
- standard preview 与 print 先达到一致；
- 历史 Markdown fallback 保持可用。

### 阶段 FE-2：稀疏模板

- 实现 `resume-sparse-v1` tokens 和设计；
- 完成中英文、preview 和 print 测试；
- 确认 hash `5335cd4ad831203f9c86e4507be3c1d09b57bb7da646b44a560d439a36a659a3`；
- 前端发布后通知后端开启 `RESUME_SPARSE_TEMPLATE_ENABLED=true`。

### 阶段 FE-3：真实 DOM 测量

- 等待字体；
- 实现隐藏测量容器；
- 实现 page/overflow/usage/bullet 测量；
- 在 UI 中展示诊断状态；
- 生成固定样例校准报告。

### 阶段 FE-4：前后端闭环

- 单独评审 DOM observation 提交/恢复接口；
- 接入后端 observation 存储；
- 验证失败后的局部修复或失败闭合；
- 固定回归集通过后开启 `RESUME_LAYOUT_HARD_GATE_ENABLED=true`。

并行生成开关与前端模板改造独立。真实 provider A/B 通过后，后端可以单独开启 `RESUME_PARALLEL_GENERATION_ENABLED=true`，前端无需额外改动。

## 16. 验收标准

### 前端设计验收

- 两套模板均有中英文完整稿；
- 稀疏版可读、专业、ATS 友好；
- 没有用虚假内容或纯装饰填充页面；
- 所有布局 token 与 manifest 一致；
- 状态与错误交互完整。

### 前端开发验收

- 所有新简历以 structured renderer 为主；
- standard/sparse 使用同一 DOM 结构；
- preview、review、application package 和 print 复用同一 renderer；
- 字体未加载、profile/hash 不一致时不会误判通过；
- 固定样例真实 DOM 一页通过率 `100%`；
- 所有 bullet 尾行真实比例 `>= 0.667`；
- 无 overflow；
- preview 与 print 分页、换行一致；
- 编辑后旧测量结果正确失效；
- 旧 Markdown 历史数据仍能预览；
- 自动化测试和校准报告齐全。

### 联调验收

- 前后端 template/profile/hash 完全一致；
- `resume-sparse-v1` 开关开启后不出现未知模板；
- DOM 指标结构满足 `browser-layout-observation-v1`；
- 不合格结果不会作为完成简历打印；
- `resume_content_gap` 能引导补充真实事实；
- 开关关闭时可安全回退到 standard renderer。

## 17. 明确不在本轮范围内

- 前端自己调用 LLM；
- 前端按 bullet 并行生成；
- 前端重新分配 JD coverage 或 source fact IDs；
- 前端自行删减内容以适配一页；
- 后端生成 PDF；
- 多模板商城或自由拖拽模板编辑器；
- 用户无约束地手动切换 template/profile；
- 未评审的新公开 HTTP endpoint。

## 18. 开始开发前需要确认

前端团队开始实施前，应确认：

1. 前端仓库位置及其自身 `AGENTS.md`；
2. 当前实际使用的 preview/review/print 组件路径；
3. 字体资产是否允许随前端发布；
4. manifest 在双仓库中的同步方式；
5. `resume_review` 实际 payload 是否已经使用单个 `resume`；
6. DOM observation 后续使用现有事件通道还是版本化内部接口；
7. 支持的浏览器及 Chromium 基线版本；
8. 打印 PDF 是否要求 Chrome/Edge 之外的兼容性。

这些确认不会改变本文件中的模板和质量原则，只影响具体前端目录、构建方式和联调接口。
