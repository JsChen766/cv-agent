# FE-4 浏览器排版硬门禁实现与实测记录

日期：2026-07-18

## 交付范围

FE-4 把 FE-3 的浏览器 DOM 测量接入后端质量闭环。候选只有在当前模板、当前 profile、字体、页数、溢出、页面密度和全部 bullet 尾行均通过服务端复核后，才能从 `unverified` 迁移为 `passed`，并进入最终 review/accept。

闭环为：

1. 后端完成事实检查和确定性纸面测量，将候选以 `unverified` 暂存。
2. Graph 发出 `resume_layout_verification` interrupt，携带唯一 `interrupt_id`、候选结构和测量 surface。
3. 前端用 `ResumeDocument` 等待字体并测量真实 DOM，自动提交原始像素 observation。
4. 后端重新计算比例并校验 template/profile、字体、bullet ID 集合、单页、溢出、密度和尾行比例。
5. 通过则候选变为 `passed`；仅 bullet 尾行失败则进入受限修复；其他失败关闭候选。
6. refresh/retry 使用 `thread_id + turn_id + interrupt_id` 幂等恢复，避免同一 turn 中连续 interrupt 串线。

## 服务端判定

浏览器只提交原始值，不提交可信的 pass/fail：

- `used_height_px / available_height_px` 由后端重算；
- bullet 尾行比例由 `last_line_width_px / available_line_width_px` 重算；
- bullet ID 必须与候选结构精确一致，不能缺失、重复或额外注入；
- profile 必须与候选及当前模板 manifest 同时匹配；
- 可见中英文内容所需字体必须在 `loaded_font_families` 中；
- 单页硬门禁容许最多 `1px` 的浏览器舍入误差；
- 密度区间和 bullet gate 取自共享 manifest，不在前后端复制常量。

质量状态迁移：

```text
unverified -> passed
unverified -> needs_revision -> unverified（修复后重新测量）
unverified / needs_revision -> failed
```

## 真实 Chrome 实测

实测使用本地 Docker API、真实 PostgreSQL、当前前端开发构建和 Chrome 插件控制的真实浏览器。测试账号密码只在浏览器登录时使用，没有写入代码、fixture、日志或本文档。

### 前置门禁样本

一次真实账号生成在浏览器门禁前被确定性布局检查拦截：2 页、约 `48.765mm` 溢出，并包含 `page_limit_exceeded`、`page_overfilled` 和多个 bullet 换行违规。该样本没有产生浏览器 observation，符合“先过服务端纸面门禁，再做浏览器实测”的顺序。

### FE-4 校准样本

为隔离外部模型延迟，测试账号内新增了命名为 `FE4 Browser Calibration` 的校准候选。它复用账号已有事实内容，只运行确定性布局优化，不调用 LLM，也不修改原简历。

| 指标 | 后端估算 | Chrome 实测 |
|---|---:|---:|
| 模板 | `resume-sparse` | `resume-sparse` |
| profile | 匹配 | 匹配 |
| 页数 | 1 | 1 |
| 页面使用率 | 0.8158 | 0.7677 |
| 溢出 | 0 | 0px |
| 字体 | manifest | SimSun、Times New Roman 均已加载 |
| bullet | 估算通过 | 7 条中 6 条尾行未达 0.667 |

Chrome 环境为 `1600×831` viewport、`devicePixelRatio=2`，A4 页面节点为 `794×1123px`，可用高度 `1017px`，实际使用高度约 `780.73px`。

后端接收真实像素 observation 后返回 `needs_revision`，持久化 6 个 `bullet_tail` 违规；候选没有升级为 `passed`。工作区打印入口同步显示“版面校验通过后才能打印”并带禁用态，证明 review/print 门禁未被绕过。

这组结果也说明 FE-4 的必要性：后端字体度量估算可通过，但真实 Chrome 的字体 shaping 和换行仍可能让 bullet 尾行失败。

### 固定 Chrome 回归矩阵

真实 Chrome 自动化还覆盖了：

- standard 模板最小、目标、最大密度样本；
- underfill 与 overflow 阻断样本；
- sparse 中英文样本；
- bullet 尾行通过和失败边界；
- screen/preview/print surface；
- 浏览器 `printToPDF` 单页结果。

已记录的关键固定样本包括 standard `0.8325 / 0.8907 / 0.9488`，underfill `0.7162` 被阻断，overflow `1.0652` 且约 `69px` 被阻断，sparse 中英文均约 `0.7001`，打印 PDF 为 1 页。

## 外部模型实测说明

真实生成链路也使用了账号数据和独立合成账号。一次合成账号运行进入 `resume_content_gap`，证明内容不足 interrupt 可恢复；后续一次运行在外部 DeepSeek 首次规划调用处超过 5 分钟未返回。API 健康检查、数据库和 checkpoint 均正常，且没有进入 FE-4 observation 阶段。因此该超时记录为提供商/网络实测限制，不作为 FE-4 失败。

## 自动化验证

- 后端 unit suite：`320 passed`；
- FE-4 domain 与 Graph 定向测试：10 项通过；
- 前端 contract/DOM 测试：27 项通过；
- 前端 TypeScript 类型检查通过；
- H5 production build 通过；
- 后端/前端模板 manifest 一致性检查通过；
- Chrome DOM、字体、preview、print、PDF 回归通过。

## 运维开关

Docker Compose 支持以下环境变量：

- `RESUME_LAYOUT_HARD_GATE_ENABLED=true`：启用 FE-4 浏览器硬门禁；
- `RESUME_SPARSE_TEMPLATE_ENABLED=true`：允许 sparse 模板参与密度选择。

生产启用前应先执行 Alembic `0017_resume_browser_layout_gate`，再同时部署后端与前端，避免旧前端无法消费 `resume_layout_verification` interrupt。
