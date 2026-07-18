# 简历 HTML/打印模板前端接入契约

> 前端开发与设计的完整实施计划、任务拆分和验收标准见
> [`frontend-resume-layout-and-template-handoff-2026-07-18.md`](./frontend-resume-layout-and-template-handoff-2026-07-18.md)。

后端已提供两个版本化模板：

- `resume-standard` / `resume-template-v2`
- `resume-sparse` / `resume-sparse-v1`

前端唯一允许使用的尺寸、字体、字号、间距、分页规则和密度区间位于
[`contracts/resume-layout-templates-v1.json`](../contracts/resume-layout-templates-v1.json)。不要在组件内复制另一套常量。

## 渲染职责

后端负责选择 `layout_template_id`、生成内容、使用同一 manifest 做快速估算，并返回
`layout_profile_version` 和 `layout_profile_hash`。前端负责 HTML/CSS 预览、打印和真实 DOM
测量；浏览器结果是分页与换行的最终事实来源。

推荐只维护一个结构组件，通过模板 token 改变视觉密度：

```html
<article
  class="resume-page"
  data-template-id="resume-sparse"
  data-profile-version="resume-sparse-v1"
  data-profile-hash="..."
>
  <header class="resume-header">...</header>
  <section class="resume-section">...</section>
</article>
```

```css
@page {
  size: A4 portrait;
  margin: 0;
}

.resume-page {
  box-sizing: border-box;
  width: 210mm;
  min-height: 297mm;
  padding: var(--padding-top) var(--padding-right)
    var(--padding-bottom) var(--padding-left);
}

.resume-item {
  break-inside: avoid;
}

.resume-section-heading {
  break-after: avoid;
}
```

CSS variables必须从 manifest 当前模板生成。字体加载完成前不得测量：

```ts
await document.fonts.ready;
```

## 真实 DOM 验收

预览、review、application package 和 print 必须复用同一个组件与 CSS。测量时上报：

- `templateId`、`profileVersion`、`profileHash`；
- `fontsReady` 和实际字体集合；
- `pageCount`、`usedHeightPx`、`availableHeightPx`、`overflowPx`；
- 每条 bullet 的 `bulletId`、行数、尾行宽度和可用行宽。

前端必须拒绝未知模板、profile/hash 不匹配和字体未完成加载的结果。只有 DOM 一页、无
overflow 且全部 bullet 尾行比例通过后，才允许展示为完成候选或进入打印。

## 发布顺序

1. 前端实现 manifest loader 和统一 HTML renderer；
2. 用固定中英文样例校准 preview/print；
3. 确认 `resume-sparse-v1` profile hash 一致；
4. 后端开启 `RESUME_SPARSE_TEMPLATE_ENABLED=true`；
5. P4 DOM 门禁通过后再开启 `RESUME_LAYOUT_HARD_GATE_ENABLED=true`。

模板契约同步检查：

```powershell
.\.venv\Scripts\python.exe scripts\export_resume_layout_templates.py --check
```
