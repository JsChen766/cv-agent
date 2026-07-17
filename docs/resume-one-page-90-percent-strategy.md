# 简历单页 90% 占用与中英文字体策略

**状态**：已实施  
**日期**：2026-07-17

## 目标

默认单页简历必须同时满足：

1. A4 portrait，保留现有 `9mm` 四边边距；
2. 不超过一页；
3. 内容使用高度不低于 A4 正文区域的 `90%`；
4. 中文简历使用宋体（`SimSun`）；
5. 英文简历使用 Times New Roman；
6. 不降低现有事实校验、JD coverage、bullet 换行、自审、编辑、预览和打印能力。

正文区域高度为：

```text
297mm - 9mm - 9mm = 279mm
```

因此默认最低内容使用高度为：

```text
279mm × 90% = 251.1mm
```

## 后端策略

### 布局约束

`LayoutConstraint` 新增：

```python
minimum_page_usage_ratio: float = 0.90
```

当简历只有一页但使用率低于 90% 时，`ResumeLayoutService` 产生硬性违规：

```text
code = page_underfilled
status = needs_revision
```

报告同时返回：

- `minimum_page_usage_ratio`；
- `underfill_mm`；
- 原有的 `page_count`、`overflow_mm`、`usage_ratio` 和 bullet reports。

### 欠填修订

欠填继续复用现有：

```text
layout_measure → layout_revision → layout_measure
```

`layout_revision` 按以下顺序补充：

1. 尚未使用、JD 匹配度高且有来源的事实；
2. 有独立价值的工作或项目 bullet；
3. 来源中已有的职责范围、方法、技术、业务场景和结果；
4. 有来源的课程、荣誉、技能分组或项目细节。

禁止：

- 添加 summary；
- 添加空泛套话；
- 重复相同事实占空间；
- 从 JD 推断候选人拥有某项经历；
- 修改来源中的日期、组织、技术、数字或责任级别。

如果达到修订上限仍不足 90%，沿用现有 `needs_user_decision`，不能伪造通过。

### 原有质量门保持不变

新增 90% 下限后仍继续执行：

- 单页上限和 overflow 检查；
- bullet 最后一行比例检查；
- 固定布局 profile/hash；
- 字体测量检查；
- fact check；
- grounded JD coverage 防回退；
- self-review；
- 中间 draft 不提前发送；
- 最终候选持久化和审核流程。

## 字体契约

布局 profile 升级为：

```text
resume-template-v2
```

字体按整份简历的 `language` 选择：

| 语言 | 字体 |
|---|---|
| `zh-*` | SimSun / 宋体 |
| 其他语言 | Times New Roman |

后端 Pillow 测量和前端 CSS 使用相同的字体选择逻辑。

旧版 `resume-template-v1` 和 Noto Sans CJK 字体继续保留为历史简历兼容预览路径，不修改旧结构化数据。

Windows 默认读取：

```text
C:\Windows\Fonts\simsun.ttc
C:\Windows\Fonts\times.ttf
```

其他部署环境可以通过以下环境变量指定合法字体文件：

```text
CV_RESUME_CHINESE_FONT_PATH
CV_RESUME_ENGLISH_FONT_PATH
```

## 前端策略

`ResumeSampleTemplate.vue`：

- 新版中文简历设置 `font-family: "SimSun"`；
- 新版英文简历设置 `font-family: "Times New Roman"`；
- 旧版简历继续使用项目内固定 Noto 字体；
- compact/mobile 仍只缩放整个 A4 canvas，不改变内部字号和换行；
- 打印仍使用同一模板和 `@page { size: A4 portrait; margin: 0; }`；
- 模板读取真实内容容器高度并计算 `data-page-usage`；
- 实际使用率低于 90% 或超过一页时，在预览中显示布局提示；
- 字体不可用时继续禁止将预览视为当前模板的可打印结果。

## 验收

已覆盖：

- 低于 90% 时产生 `page_underfilled`；
- 达到 90% 且未溢出时通过布局门；
- 超过一页时仍产生 `page_limit_exceeded`；
- 中文和英文分别使用宋体与 Times New Roman 测量；
- profile v2 前后端 hash 一致；
- v1 Noto 历史兼容路径保留；
- 前端真实内容使用率可读取；
- 前端 compact、summary 过滤、统一预览入口和 A4 打印规则保持。
