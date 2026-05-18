# Coolto 库投前端 MVP 功能点说明

> 目标：基于当前 `cv-agent` 后端，构建一个类似 ChatGPT / Gemini 的聊天式求职 Copilot 前端。前端不是传统多页面简历工具，而是 **Chat-first Copilot + 右侧 Workspace + 左侧资产侧栏**。

本文用于交给前端开发 / 设计 / Codex 执行，重点是：**完美适配当前后端能力，完整发挥后端 AgentRuntime、Product API、File Import、Job、Export、Session/Workspace 的价值**。

---

## 1. 产品定位

Coolto 库投是一个聊天式简历与经历库 Copilot。

用户不应该像传统工具一样到处点表单，而应该像和 ChatGPT 聊天一样完成：

- 上传简历
- 解析经历
- 确认导入经历库
- 粘贴 JD
- 生成匹配 JD 的简历版本
- 查看证据和推荐理由
- 接受某个版本
- 生成简历草稿
- 导出 HTML / 未来 PDF

核心体验：

```text
用户自然表达需求
  ↓
前台 Agent 理解意图
  ↓
调用后端工具 / 任务 / 资产服务
  ↓
聊天区给自然回复
  ↓
右侧 Workspace 展示可操作结果
```

---

## 2. 推荐前端技术栈

考虑未来要覆盖：

- Web
- 微信小程序
- App
- EXE 桌面端

推荐：

```text
Vue 3 + TypeScript + uni-app 作为主前端
Tauri / Electron 作为桌面 EXE 包装层
后端继续独立部署为 API 服务
```

建议阶段：

```text
P12.0：先做 uni-app H5 / Web MVP
P12.1：适配微信小程序
P12.2：打包 App
P12.3：Tauri/Electron 包 H5 为 EXE
```

---

## 3. 总体布局

前端首页就是聊天页，不要先做传统 Dashboard。

### 3.1 桌面端布局

```text
┌───────────────────────────────────────────────────────────────┐
│ Top Bar: Logo / 当前用户 / 运行状态 / 设置                     │
├───────────────┬───────────────────────────────┬───────────────┤
│ Left Sidebar  │ Chat Main                     │ Workspace     │
│               │                               │ Panel         │
│ - 新聊天       │ - 消息流                       │               │
│ - 最近会话     │ - 上传入口                     │ - 导入候选     │
│ - 经历库       │ - 输入框                       │ - 生成版本     │
│ - JD 记录      │ - suggested prompts            │ - 简历草稿     │
│ - 历史简历     │ - next actions                 │ - 导出状态     │
│ - 文件/导出    │                               │               │
└───────────────┴───────────────────────────────┴───────────────┘
```

建议比例：

```text
Left Sidebar: 260px
Chat Main: flex 1
Workspace: 380px - 480px，可折叠
```

### 3.2 移动端 / 小程序布局

移动端不能三栏并排，应改成：

```text
主 Tab：Chat
辅助 Tab：Workspace
辅助 Tab：Assets
```

或：

```text
Chat 页面主视图
右侧 Workspace 改为底部抽屉 / 二级页
左侧 Sidebar 改为侧滑 drawer
```

---

## 4. 前端模块划分

建议目录：

```text
frontend/
  src/
    api/
      client.ts
      authApi.ts
      copilotApi.ts
      productApi.ts
      fileApi.ts
      jobApi.ts
      exportApi.ts
      dashboardApi.ts
    stores/
      authStore.ts
      sessionStore.ts
      chatStore.ts
      workspaceStore.ts
      assetStore.ts
      jobStore.ts
    pages/
      ChatHome.vue
      AuthDevLogin.vue
      Assets.vue
      ResumePreview.vue
    components/
      layout/
        AppShell.vue
        LeftSidebar.vue
        WorkspacePanel.vue
        TopBar.vue
      chat/
        ChatMessageList.vue
        ChatMessage.vue
        ChatInput.vue
        SuggestedPrompts.vue
        NextActions.vue
        UploadDropzone.vue
      workspace/
        ImportCandidatesPanel.vue
        VariantsPanel.vue
        ResumeDraftPanel.vue
        EvidencePanel.vue
        ExportPanel.vue
        JobProgressPanel.vue
      assets/
        ExperienceLibrary.vue
        JDLibrary.vue
        ResumeHistory.vue
        FileLibrary.vue
        ExportHistory.vue
```

---

## 5. 必须优先实现的 MVP 功能

### 5.1 Auth / 用户识别

目标：先支撑内测，不做正式 OAuth。

页面/功能：

- 开发登录 / 内测登录入口
- 自动检查 `/auth/me`
- 登录后保存 cookie/session
- 登出 `/auth/logout`
- 显示当前用户 email/displayName

使用 API：

```text
GET  /auth/me
POST /auth/dev-login
POST /auth/logout
GET  /auth/api-keys
POST /auth/api-keys
DELETE /auth/api-keys/:id
```

前端要求：

- 不要从前端传 `userId` 给业务接口。
- 业务接口只依赖 cookie/session 或 auth header。
- API key 创建后不展示明文，只展示 masked key。

---

### 5.2 ChatGPT 式聊天主页

这是主页面。

必须支持：

- 消息流
- 用户消息
- assistant 消息
- suggestedPrompts
- nextActions
- 文件上传入口
- sessionId 保持
- workspace 自动更新

使用 API：

```text
POST /copilot/chat
POST /copilot/actions
POST /copilot/chat/stream   # 可后续接入，MVP 可先不用 stream
GET  /copilot/sessions
GET  /copilot/sessions/:id
PATCH /copilot/sessions/:id
GET  /copilot/sidebar
```

`/copilot/chat` 返回后，前端必须处理：

```ts
{
  sessionId: string;
  turnId: string;
  assistantMessage: CopilotMessage;
  timeline: ProductTimelineItem[];
  workspace: CopilotWorkspace;
  nextActions?: ProductAction[];
  suggestedPrompts?: SuggestedPrompt[];
  raw?: Record<string, unknown>;
}
```

交互规则：

- `suggestedPrompts`：显示为快捷问题 chip，点击后作为新 message 发 `/copilot/chat`。
- `nextActions`：显示为操作按钮，点击后发 `/copilot/actions`。
- 不要把 suggestedPrompts 当 action。
- 不要把 nextActions 当普通 message。

---

### 5.3 左侧 Sidebar

左侧用于资产导航，不是传统页面主入口。

内容：

- 新聊天
- 最近会话
- 经历库
- JD 记录
- 历史简历
- 文件记录
- 导出记录

使用 API：

```text
GET /copilot/sidebar
GET /copilot/sessions
GET /product/dashboard
GET /product/experiences
GET /product/jds
GET /product/resumes
GET /files
GET /exports
```

点击最近会话：

```text
GET /copilot/sessions/:id
恢复 messages + workspace + sessionId
```

---

### 5.4 文件上传与解析

用户可以上传简历文件。

MVP 先稳定支持：

```text
txt
pdf/docx 可展示“解析能力受后端 parser 配置影响”
```

使用 API：

```text
POST /files/upload
POST /files/:id/parse
GET  /jobs/:id
GET  /files/:id/parsed-document
POST /product/imports/file
```

前端流程：

```text
选择文件
  ↓
POST /files/upload
  ↓
POST /files/:id/parse
  ↓
轮询 GET /jobs/:id
  ↓
解析完成
  ↓
POST /product/imports/file
  ↓
轮询 import job
  ↓
展示 candidates
```

UI：

- 上传卡片
- 文件状态：uploaded / parsing / parsed / failed
- job progress bar
- parser error 安全展示
- 不展示 raw stack

---

### 5.5 导入候选经历确认

解析简历后，后端会生成 candidates。

使用 API：

```text
GET  /product/imports/:id
POST /product/import-candidates/:id/accept
POST /product/import-candidates/:id/reject
GET  /product/experiences
```

UI：

- 候选经历卡片列表
- 每张卡片显示：标题、内容摘要、分类、置信度/来源
- 按钮：接受 / 忽略
- 接受后加入经历库
- 右侧 Workspace 自动切到 `experience_library` 或 `import_candidates`

---

### 5.6 经历库

经历库是产品的核心资产。

使用 API：

```text
GET  /product/experiences
POST /product/experiences
PATCH /product/experiences/:id
POST /product/experiences/:id/revisions
POST /product/experiences/:id/variants
```

MVP UI：

- 经历列表
- 经历详情
- 简单新增经历
- 简单编辑经历
- 显示 revision / variants 可后置

---

### 5.7 JD 输入与保存

用户可以粘贴 JD，也可以通过聊天发送 JD。

使用 API：

```text
POST /product/jds
GET  /product/jds
GET  /product/jds/:id
```

UI：

- JD 输入框
- targetRole 输入
- 保存按钮
- 最近 JD 列表
- 点击 JD 可进入生成流程

---

### 5.8 生成简历 variants

用户可以在聊天中说：

```text
根据这个 JD 生成适合投递的项目经历/简历版本
```

也可以从 JD 页面点击“生成”。

使用 API：

```text
POST /copilot/chat
POST /product/generations/from-jd
GET  /product/generations
GET  /product/generations/:id
POST /product/generations/:id/accept-variant
```

UI：

- variants 卡片
- 推荐版本标识
- 证据/风险摘要
- 操作按钮：接受、查看证据、为什么推荐、保守一点、再量化一点

优先通过 `/copilot/chat` 和 `/copilot/actions` 完成 Agent 交互。
`/product/generations/*` 用于资产页和兜底操作。

---

### 5.9 Resume 草稿与历史简历

接受 variant 后生成 resume / resume item。

使用 API：

```text
GET  /product/resumes
GET  /product/resumes/:id
POST /product/resumes
POST /product/resumes/:id/items
PATCH /product/resume-items/:id
POST /product/resumes/:id/reorder
```

MVP UI：

- 简历草稿预览
- section list
- item content
- 简单调整顺序
- 简单编辑 item
- 导出按钮

不要一开始做复杂富文本编辑器。

---

### 5.10 HTML 导出与下载

当前后端支持稳定 HTML export。PDF 暂时隐藏或显示“即将支持”。

使用 API：

```text
POST /exports/resumes/:resumeId
GET  /exports/:id
GET  /exports/:id/download
GET  /exports
```

前端流程：

```text
点击导出 HTML
  ↓
POST /exports/resumes/:resumeId { format: "html" }
  ↓
得到 export job
  ↓
轮询 GET /jobs/:id 或 GET /exports/:id
  ↓
completed
  ↓
GET /exports/:id/download
```

UI：

- 导出状态：pending / rendering / completed / failed
- 下载按钮
- PDF 按钮先隐藏或 disabled
- 如果用户点 PDF，提示：PDF 导出即将支持

---

## 6. Workspace 面板设计

Workspace 是后端能力发挥的核心。

根据 `workspace.activePanel` 切换：

```text
import_candidates
experience_library
jd_library
resume_history
resume_editor
variant_review
evidence_view
export_status
```

### 6.1 ImportCandidatesPanel

展示导入候选经历。

Actions：

- accept candidate
- reject candidate

### 6.2 VariantsPanel

展示生成的 variants。

Actions：

- accept
- prefer
- reject
- show_evidence
- explain_choice
- revise_more_conservative
- revise_more_quantified

### 6.3 ResumeDraftPanel

展示当前 resume。

Actions：

- export html
- edit item
- reorder item

### 6.4 ExportPanel

展示 export job 状态。

Actions：

- download
- retry export

---

## 7. Job 轮询策略

所有异步任务统一使用 job polling。

使用 API：

```text
GET /jobs/:id
```

轮询策略：

```text
pending/running: 每 1.5s 轮询
completed/failed/cancelled: 停止轮询
超过 2 分钟提示用户稍后查看
```

Job UI 通用字段：

```text
status
progress
progressMessage
errorMessage
createdAt
updatedAt
```

---

## 8. 错误处理规范

后端统一错误格式：

```ts
{
  ok: false,
  error: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
  },
  meta: {
    requestId: string;
    traceId: string;
    mode: string;
  }
}
```

前端处理：

- `401`：跳转登录 / 显示登录弹窗
- `403`：提示无权限
- `404`：资源不存在或无权访问
- `409 SESSION_LOCKED`：提示“当前会话正在处理上一条请求，请稍后”
- `409 IDEMPOTENCY_CONFLICT`：提示“重复请求参数不一致”
- `429`：提示“请求过于频繁，请稍后再试”
- parser/export failed：展示安全错误，不展示 stack

---

## 9. API Client 要求

必须统一封装 API，不允许页面里散落 fetch。

```ts
apiClient.request<T>(method, path, options)
```

必须自动处理：

- baseURL
- credentials/cookie
- auth header 适配
- JSON parse
- error envelope
- requestId
- Idempotency-Key
- upload body

写接口必须支持生成 Idempotency-Key：

```text
POST /copilot/chat
POST /copilot/actions
POST /product/*
POST /files/*
POST /exports/*
POST /jobs/:id/cancel
```

SSE stream 不支持 Idempotency-Key。

---

## 10. 多端适配注意事项

### 10.1 Web/H5

- 使用 cookie session
- 支持拖拽上传
- 支持三栏布局

### 10.2 微信小程序

- 不依赖浏览器 cookie 作为唯一方案
- 需要后续 bearer token / session token 适配
- 文件选择用 uni.chooseMessageFile / chooseFile 兼容封装
- 下载文件用小程序文件 API
- Workspace 改为底部抽屉或二级页

### 10.3 App

- 使用 uni-app App 文件选择能力
- 导出文件下载后调用系统分享/打开

### 10.4 EXE

- 推荐 Tauri/Electron 包 H5
- 文件上传可接本地文件路径，但仍要通过后端 upload API

---

## 11. 前端 MVP 验收标准

前端 MVP 必须能跑通：

```text
1. 用户进入页面并登录 / dev-login
2. 看到 ChatGPT 式聊天主页
3. 上传 txt 简历文件
4. 看到 parse job 进度
5. 解析完成后导入候选经历
6. 接受候选进入经历库
7. 粘贴或保存 JD
8. 生成简历 variants
9. 接受一个 variant 生成 resume
10. 导出 HTML
11. 下载 HTML 文件
12. 刷新页面后恢复 session / workspace
```

如果以上 12 步顺畅，前端 MVP 成立。

---

## 12. 暂不做的能力

本阶段不要做：

- OAuth / 密码登录
- 微信登录
- PDF 导出
- DOCX 导出
- 模板市场
- 复杂富文本编辑器
- 付费系统
- R2/S3 文件存储配置页
- 管理后台
- 知识图谱可视化

---

## 13. 设计风格要求

产品视觉方向：

```text
ChatGPT 式干净聊天界面
Notion 式资产管理
轻量 Workspace 面板
不要传统后台系统感
不要 AI 味很重的大渐变、大卡片、大发光
```

关键词：

```text
简洁
高级
低噪音
强留白
细边框
轻阴影
文本可读性优先
```

---

## 14. 最终目标

前端不是简单调用接口，而是要把后端能力组织成一个真实 Copilot 产品体验：

```text
用户只需要聊天和确认
系统负责理解、调用工具、维护经历库、生成版本、解释证据、导出简历
```

前端第一版要证明：

```text
Chat-first Copilot + Workspace 是成立的。
```
