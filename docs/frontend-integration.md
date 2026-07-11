# 前端接入文档（cv-agent 后端）

> 目标读者：负责简历助手前端（对话、简历预览、Artifact 预览、经历库）的工程师。
> 版本：与后端 `app.main:app` v0.1.0 对齐（实测通过日期：2026-07-11）。
> 本文中所有请求/响应示例均来自真实调用，未做手工整理。

---

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| **Thread** | 一整段对话的容器；同一 Thread 内 LangGraph checkpointer 会保存 state、消息历史。 |
| **Turn** | 一次「用户消息 → 助手响应」；后端为每次请求生成新的 `turnId`。 |
| **Subgraph** | 后端 6 大业务链路之一：`experience_import` / `jd` / `resume_generation` / `artifact` / `open_ended`。由 Router 决定走哪个。 |
| **Interrupt** | LangGraph 的 `interrupt()` 机制。执行到需要用户确认的节点时挂起，前端收到 SSE `agent.interrupt` 事件后弹审核 UI，然后调 `/threads/{id}/resume` 恢复执行。 |
| **Variant** | 简历的一个候选版本（LLM 生成的一份完整 Markdown）。 |
| **Resume Item** | 简历的一个可编辑条目（用户点「采纳变体」后，Variant 会被写入 `resume_items`）。 |
| **Artifact** | Cover Letter / 自我介绍 / 匹配报告 / 面试准备 / LinkedIn Summary 等衍生文档。 |
| **`clientState`** | 前端每次请求都要携带的上下文：当前激活的 JD / Resume / Artifact / 上传文件等。 |

---

## 1. Base URL、认证、错误码

### 1.1 Base URL

- 开发：`http://localhost:8000`
- 所有业务路由都在 `/v1` 前缀下（`/v1/health`、`/v1/copilot/...`、`/v1/threads/...`、`/v1/product/...`、`/v1/files/...`）。

### 1.2 认证

后端在 `deps.py` 里读取：

1. `Authorization: Bearer <jwt>` header，或
2. `access_token` HTTP-only Cookie。

任一存在即视为已登录。当且仅当 `ENVIRONMENT=development` 且 `DEV_AUTO_AUTH=true` 且**未携带任何凭证**时，会自动以 `DEV_USER_ID` 登录（用于本地联调）。

生产环境获取 token 的接口：`POST /v1/auth/login`（现有 `app/api/routes/auth.py`，前端已有的登录流程沿用即可）。

### 1.3 统一响应壳

**成功**：

```json
{ "success": true, "data": { ... }, "request_id": "uuid" }
```

**失败**：

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "..." }, "request_id": "uuid" }
```

常见 `error.code`：`VALIDATION_ERROR` / `NOT_FOUND` / `UNAUTHORIZED` / `FORBIDDEN` / `CONFLICT` / `EXTERNAL_SERVICE_ERROR`。前端应以 `success` 布尔为主，`error.code` 用于分支处理。

---

## 2. 全部端点速查表（前端会用到的部分）

| 分类 | 方法 & 路径 | 用途 |
|---|---|---|
| 健康 | `GET /v1/health` | 探活 |
| **对话** | `POST /v1/copilot/chat` | 非流式对话 |
| **对话** | `POST /v1/copilot/chat/stream` | SSE 流式对话（**主入口**） |
| **动作** | `POST /v1/copilot/actions` | 确定性产品动作（按钮触发） |
| **中断** | `POST /v1/threads/{id}/resume` | 用户确认审核后恢复执行 |
| **中断** | `POST /v1/threads/{id}/discard` | 用户放弃审核 |
| 侧栏 | `GET /v1/copilot/sidebar` | 首屏侧栏摘要 |
| Thread | `GET /v1/threads?limit=&cursor=` | 列表 |
| Thread | `GET /v1/threads/{id}` | 详情 + 历史消息 |
| Thread | `PATCH /v1/threads/{id}` | 改标题/状态 |
| 文件 | `POST /v1/files/upload` (multipart) | 上传（`file`：pdf/docx/txt/md，10MB 上限）|
| 文件 | `POST /v1/files/{fileId}/parse` | 手动触发解析（对话流会自动懒解析，此接口用于**预览**） |
| 经历库 | `GET/POST/PATCH/DELETE /v1/product/experiences[/{id}]` | 经历 CRUD |
| 经历库 | `POST /v1/product/experiences/{id}/revisions` | 加一版历史 |
| JD | `GET/POST/GET/DELETE /v1/product/jds[/{id}]` | JD CRUD |
| 简历 | `GET/POST/GET/PATCH /v1/product/resumes[/{id}]` | 简历 CRUD |
| 简历 | `POST /v1/product/resumes/{id}/items` | 加条目 |
| 简历 | `PATCH/DELETE /v1/product/resume-items/{id}` | 改/删条目 |
| 简历 | `POST /v1/product/resumes/{id}/reorder` | 重排 |
| Artifact | `GET/GET/PATCH/DELETE /v1/product/artifacts[/{id}]` | Artifact CRUD |

> 除对话/动作以外，其余都是普通 RESTful，前端按现有 CRUD 惯例调用即可。本文详细展开的是**对话链路**（§3–§6），这是唯一有状态、有幻觉风险、有 SSE 的部分。

---

## 3. Thread 生命周期与 `clientState`

### 3.1 状态管理原则

前端只需要在内存里维护 4 个字段：

```ts
type UiState = {
  activeThreadId: string | null;       // 从后端响应 data.threadId 覆盖
  activeJdId: string | null;
  activeResumeId: string | null;
  activeArtifactId: string | null;
  activeExperienceIds: string[];
  // 只在"当前上传的这份文件正待处理"时非空，处理完成后清空
  pendingUpload: { fileId: string; originalName: string; mimeType: string } | null;
};
```

**规则**：

1. 每次调 `/copilot/chat*` 或 `/copilot/actions`，把上面这些字段拼进请求的 `clientState`（下节 §3.2）。
2. 从响应 `data.workspace` 里读回 `jd_id / resume_id / artifact_id / experience_ids`，回填到 UI 状态。
3. `activeThreadId` 首次为空，后端会自动新建；此后**必须**把响应里的 `threadId` 保存下来，后续消息都带上它。

### 3.2 `clientState` 字段说明

后端 `ClientState` 是 `extra="ignore"`，多余字段会被静默丢弃。字段清单（所有字段可选）：

```json
{
  "locale": "zh-CN",
  "activeJdId": "jd-...",
  "activeResumeId": "resume-...",
  "activeArtifactId": "artifact-...",
  "activeExperienceIds": ["exp-...", "..."],
  "activeThreadId": "thread-...",
  "activeFileId": "file-...",
  "uploadedFileId": "file-...",
  "resumeFileId": "file-...",
  "fileId": "file-...",
  "resumeUpload": {
    "fileId": "file-...",
    "originalName": "陈剑升-香港城市大学.pdf",
    "mimeType": "application/pdf"
  },
  "intentSource": "chat_input",
  "sourceComponent": "sidebar_upload_button"
}
```

上传文件的 `fileId` 有 6 个字段可以填，后端会依次查找 `resumeUpload.fileId → resumeUpload.id → resumeFileId → uploadedFileId → activeFileId → fileId`，前端推荐**统一用 `resumeUpload`**，语义最清晰。

### 3.3 服务端会把 `clientState` 变成什么

后端把 `clientState` 组装成两个东西：

1. **`workspace`**（`jd_id / resume_id / artifact_id / experience_ids / file_id`）—— 塞进 LangGraph state 供各子图读取。
2. **`extracted_params.raw_text`** —— 如果检测到 `resumeUpload.fileId`，后端会自动拉 `uploaded_files` 表 → 惰性解析 PDF/DOCX → 把纯文本塞进 state。**前端不需要**先手动调 `/files/{id}/parse`。

### 3.4 同 Thread 自由切换意图

后端现在支持在同一 Thread 内自由切换意图，无需每次新建对话：

- 每轮发送新消息时，后端会自动清理上一轮的路由状态和任何挂起的 interrupt
- 即使上一轮在等待简历审核、JD 保存确认等 interrupt，新消息也会被正确路由
- 意图不清晰时，AI 会以 assistant 消息形式反问，引导用户明确意图
- 前端**不再需要**在"上传→导入"完成后强制清空 `activeThreadId`

> 侧栏点击不同 Thread 时仍然需要切 `activeThreadId`（这是正常的 UI 行为）。

---

## 4. 主入口：`POST /v1/copilot/chat/stream`（SSE）

### 4.1 请求

```http
POST /v1/copilot/chat/stream
Content-Type: application/json
Accept: text/event-stream

{
  "threadId": "thread-xxx" | null,     // 首次为 null，后续必须传
  "message": "帮我把这份简历里的经历导入到经历库",
  "clientState": {
    "locale": "zh-CN",
    "resumeUpload": {
      "fileId": "file-xxx",
      "originalName": "简历.pdf",
      "mimeType": "application/pdf"
    }
  }
}
```

前端**必须**用 `fetch` + `ReadableStream` 消费 SSE，不能用 `EventSource`（因为 `EventSource` 只支持 GET）。

### 4.2 响应：SSE 事件流

每一条事件都是这样两行：

```
event: <name>
data: <json>

```

事件按时间顺序依次到达，遇到 `agent.interrupt` 或 `agent.completed` 或 `agent.failed` 表示本次 turn 结束。

### 4.3 事件类型详解

#### 4.3.1 `agent.activity.updated`（进程条 UI）

```json
{
  "event": "agent.activity.updated",
  "thread_id": "thread-xxx",
  "turn_id": "turn-xxx",
  "sequence": 3,
  "timestamp": "2026-07-11T05:52:22.657074+00:00",
  "agent_role": "experience_orchestrator",
  "agent_label": "经历编排员",
  "status": "running",
  "action": "正在解析经历内容"
}
```

- **前端用途**：进程条/流程步骤 UI。
- `agent_role` 取值：`frontdesk` / `experience_orchestrator` / `jd_analyst` / `resume_writer` / `resume_reviewer`。
- `status`：`running` / `waiting_user` / `completed` / `failed`。
- `sequence` 全局单调递增，可用来去重和排序。
- **建议 UI**：显示 `agent_label + action` 作为当前正在做的事情；`status=completed` 时把该步骤标为已完成。

#### 4.3.2 `agent.route.completed`

```json
{
  "event": "agent.route.completed",
  "target": "experience_import",
  "intent_description": "Import experience candidates from the uploaded resume file.",
  "confidence": 0.98
}
```

- **前端用途**：可选，用于开发调试或"AI 正在做什么"的提示。
- ⚠️ 会在一次 turn 里**重复触发多次**（子图和主图都会发），前端应去重（用 `target + confidence` 或直接取最后一条）。

#### 4.3.3 `agent.thinking`

```json
{ "event": "agent.thinking", "text": "Found 7 experience(s) to import. Please review before saving." }
```

- **前端用途**：灰色思考气泡；或直接吞掉不显示（可选）。

#### 4.3.4 `content.diff.started` / `content.diff.delta` / `content.diff.completed`（简历预览）

```json
{ "event": "content.diff.started", "resume_id": "resume-xxx", "section": "all" }
{ "event": "content.diff.delta", "operations": [{"op":"insert","text":"# 个人简历\n\n..."}] }
{ "event": "content.diff.completed", "resume_id": "resume-xxx", "total_insertions": 480, "total_deletions": 0 }
```

- **前端用途**：简历预览面板的实时刷新。

> 持久化规则：`content.diff.*` 只用于当前生成过程的即时展示。收到后续
> `resume_review` 后，后端会创建一条 role 为 `assistant` 的历史消息，并将完整画布
> 快照放在 `message.metadata.presentation`。重新进入 Thread 时，必须以这条消息的
> `createdAt` 顺序渲染画布，不能依赖 SSE 重放或全局 workspace。
- 当前后端实现是"整段一次性 insert"，不是真的 token 级 diff；`operations` 里目前只有一个 `insert` op。前端把 `text` 作为完整 Markdown 渲染即可。
- 未来会拆成真正的增量 op，前端应实现成"按顺序 apply 一串 op"的形式（支持 `insert` / `delete` / `equal`）。

#### 4.3.5 `artifact.started` / `artifact.delta` / `artifact.completed`（Artifact 画布预览）

> **默认不再发送。** 后端维护一个画布白名单 `_CANVAS_ARTIFACT_TYPES`（当前为空集）。只有列入白名单的 artifact 类型才会走画布事件流；其余类型（`cover_letter` / `self_intro` / `match_report` / `interview_prep` / `linkedin_summary`）的完整 Markdown 直接写入 `assistantMessage`，在聊天气泡里渲染，**不发这三个事件**。
>
> 如果未来某类型被加入白名单，事件格式不变：

```json
{ "event": "artifact.started", "artifact_type": "match_report", "title": "JD Match Report" }
{ "event": "artifact.delta", "content": "好的，以下是根据JD要求..." }
{ "event": "artifact.completed", "artifact_id": "artifact-xxx", "title": "JD Match Report", "word_count": 812 }
```

- 画布类型：收到 `delta` 时替换 canvas，收到 `completed` 后可拉 `GET /v1/product/artifacts/{artifact_id}` 拿定稿版本。
- **非画布类型**（当前所有 5 种）：`assistantMessage` 即为完整 Markdown，直接在聊天流中渲染即可；无需监听这三个事件。

#### 4.3.6 `agent.interrupt`（**核心**：弹审核 UI）

有三种 `type`：

**（a）`experience_import` — 经历导入审核**

```json
{
  "event": "agent.interrupt",
  "interrupt_type": "experience_import",
  "data": {
    "event": "agent.interrupt",
    "interrupt_id": "e22ed824-...",
    "type": "experience_import",
    "message": "I've extracted 7 experience(s) from your input. Please review...",
    "variants": [],
    "candidates": [
      {
        "title": "AI算法工程师（数据处理、大模型备案）",
        "organization": "江西新华云教育科技有限公司",
        "start_date": "2024-04",
        "end_date": "2024-07",
        "content": "• 数据清洗与预处理：处理30万+条语料库...",
        "category": "work"
      },
      { "...": "..." }
    ],
    "action_options": [
      {"id":"confirm","label":"Confirm","description":"Save selected candidates"},
      {"id":"discard","label":"Discard","description":"Do not save candidates"}
    ]
  }
}
```

前端应：
1. 弹一个多选表单，展示 `data.candidates`，允许用户勾选、编辑每个字段；
2. 用户点确认 → 调 `POST /v1/threads/{threadId}/resume`（见 §5）；
3. 用户点放弃 → 调 `POST /v1/threads/{threadId}/discard`。

**（b）`resume_review` — 简历变体审核**

```json
{
  "event": "agent.interrupt",
  "interrupt_type": "resume_review",
  "data": {
    "type": "resume_review",
    "variants": [
      {
        "id": "variant-xxx",
        "resume_id": "resume-xxx",
        "jd_id": "jd-xxx",
        "title": "AI Generated Variant",
        "content": "# 个人简历\n\n## Summary\n...",
        "score": { "overall": 0, "relevance": 0, "clarity": 0, "evidence_strength": 0, "quantified_impact": 0 },
        "evidence_summary": [],
        "risk_summary": [],
        "missing_info": []
      }
    ]
  }
}
```

前端应：
1. 把 `variants[*].content` 渲染到简历预览面板；
2. 提供三个动作（`accept` / `revise` / `discard`）；
3. `data.canvas_message_id` 是该画布所在历史消息的 ID；前端应保存它。
4. **注意**：`resume_review` 的 `accept` 不用调 `/threads/{id}/resume`，而是调 `POST /v1/copilot/actions {type: "accept_variant", payload: {variantId, canvasMessageId}}`（见 §6.3）。resume 子图的中断只做"预览+等待"，最终落库是通过 action 完成的。

**（c）`jd_save` — JD 保存确认**

当用户在对话中粘贴一份 JD，后端解析完成后会发送此中断，等待用户确认是否入库。

```json
{
  "event": "agent.interrupt",
  "interrupt_id": "c3f9a123-...",
  "type": "jd_save",
  "message": "检测到一条 JD，是否加入匹配记录？",
  "candidate": {
    "title": "Senior Backend Engineer",
    "company": "Acme Corp",
    "target_role": "后端工程师",
    "raw_text": "We are looking for...",
    "requirements": [
      { "id": "r-1", "text": "5+ years Python", "category": "must_have", "importance": "high" },
      { "id": "r-2", "text": "Microservices experience", "category": "skill", "importance": "medium" }
    ]
  },
  "action_options": [
    { "id": "confirm", "label": "加入", "description": "保存到 JD 匹配记录" },
    { "id": "discard", "label": "忽略", "description": "不保存" }
  ]
}
```

前端处理步骤：
1. 弹确认卡片，展示 `candidate` 的 title / company / requirements，允许用户编辑字段；
2. 用户点「加入」→ 调 `POST /v1/threads/{threadId}/resume`，body：
   ```json
   {
     "turnId": "<当前 turnId>",
     "confirmedData": {
       "confirmed": true,
       "candidate": { "title": "...", "company": "...", "requirements": [...] }
     }
   }
   ```
   `candidate` 可以只带用户修改过的字段，后端会做 merge；
3. 用户点「忽略」→ 调 `POST /v1/threads/{threadId}/resume`，body：
   ```json
   { "turnId": "<当前 turnId>", "confirmedData": { "confirmed": false } }
   ```
   或调 `POST /v1/threads/{threadId}/discard`。
4. 保存成功后 `workspace.jd_id` 会在后续 `agent.completed` 里携带；可用此 id 以及 `sourceThreadId`（JD 列表接口返回）跳回对应聊天历史。

#### 4.3.7 `agent.completed`（**收尾**）

```json
{
  "event": "agent.completed",
  "threadId": "thread-xxx",
  "turnId": "turn-xxx",
  "response": {
    "threadId": "thread-xxx",
    "turnId": "turn-xxx",
    "assistantMessage": {
      "id": "msg-xxx",
      "role": "assistant",
      "content": "Saved JD '数据分析师' with 7 requirement(s).",
      "createdAt": "2026-07-11T05:54:43.239453+00:00"
    },
    "workspace": { "jd_id": "jd-xxx" },
    "nextActions": [],
    "suggestedPrompts": [],
    "interrupt": null
  }
}
```

- **前端用途**：把 `response.assistantMessage.content` 作为最终助手消息渲染；把 `response.workspace` merge 到 UI state。
- ⚠️ 会重复出现：子图完成会发一次（`response` 字段为 `null` 或不完整），主图完成再发一次（`response` 字段完整）。**前端只处理最后一条 `response.threadId` 非空的**，前面的当噪音丢掉。

#### 4.3.8 `agent.failed`

```json
{ "event": "agent.failed", "error": { "code": "GRAPH_ERROR", "message": "LLM call failed: 429 ..." } }
```

- **前端用途**：Toast + 允许重试。
- 常见 message：`LLM call failed` / `Structured LLM call failed` / `File not found` / `Graph execution failed`。

### 4.4 参考实现（TypeScript）

```ts
async function chatStream(
  threadId: string | null,
  message: string,
  clientState: ClientState,
  handlers: {
    onActivity?: (e: ActivityEvent) => void;
    onContentDiff?: (e: DiffEvent) => void;
    onArtifact?: (e: ArtifactEvent) => void;
    onInterrupt?: (e: InterruptEvent) => void;
    onCompleted?: (resp: CompletedResponse) => void;
    onFailed?: (err: FailedEvent) => void;
  }
): Promise<void> {
  const res = await fetch("/v1/copilot/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    credentials: "include",
    body: JSON.stringify({ threadId, message, clientState }),
  });
  if (!res.ok || !res.body) throw new Error(`chat/stream ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // 按 "\n\n" 分割事件块
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = block.split("\n").find(l => l.startsWith("data:"));
      if (!dataLine) continue;
      const payload = JSON.parse(dataLine.slice(5).trim());
      switch (payload.event) {
        case "agent.activity.updated": handlers.onActivity?.(payload); break;
        case "content.diff.started":
        case "content.diff.delta":
        case "content.diff.completed": handlers.onContentDiff?.(payload); break;
        case "artifact.started":
        case "artifact.delta":
        case "artifact.completed": handlers.onArtifact?.(payload); break;
        case "agent.interrupt": handlers.onInterrupt?.(payload); break;
        case "agent.completed":
          // 只处理带完整 response 的那一条
          if (payload.response?.assistantMessage) handlers.onCompleted?.(payload.response);
          break;
        case "agent.failed": handlers.onFailed?.(payload); break;
      }
    }
  }
}
```

### 4.5 非流式变体 `POST /v1/copilot/chat`

同 body、同响应壳，但**一次性**返回：

```json
{
  "success": true,
  "data": {
    "threadId": "thread-xxx",
    "turnId": "turn-xxx",
    "assistantMessage": { "id":"msg-xxx", "role":"assistant", "content":"...", "createdAt":"..." },
    "workspace": { "jd_id":"jd-xxx" },
    "nextActions": [],
    "suggestedPrompts": [],
    "interrupt": null | { "type":"...", "candidates":[...], "variants":[...] }
  },
  "request_id": "..."
}
```

用途：**极少数**不需要流式效果的场景（如后台任务）。**推荐所有对话都走 stream 版本**，因为耗时可能 20–50s，非流式会让用户干等。

---

## 5. Interrupt 恢复：`/threads/{id}/resume` 与 `/discard`

### 5.1 `POST /v1/threads/{threadId}/resume`

**用途**：`experience_import` 的用户确认。

**请求**：

```json
{
  "turnId": "turn-xxx",               // 必须是 interrupt 所在的那个 turn 的 id
  "confirmedData": {
    "confirmed_candidates": [
      {
        "title": "...",
        "organization": "...",
        "start_date": "2024-04",
        "end_date": "2024-07",
        "content": "...",
        "category": "work"
      }
    ]
  }
}
```

**响应**（同 chat 非流式）：

```json
{
  "success": true,
  "data": {
    "threadId": "thread-xxx",
    "turnId": "turn-xxx",
    "assistantMessage": { "content": "Saved 7 experience(s) to your profile." },
    "workspace": {
      "experience_ids": ["exp-xxx", "exp-xxx", "..."]
    },
    "interrupt": null
  }
}
```

前端拿到 `experience_ids` 后应刷新经历库列表。

### 5.2 `POST /v1/threads/{threadId}/discard`

```json
{ "turnId": "turn-xxx", "reason": "user-cancelled" }
```

用于放弃 `experience_import` 审核。

### 5.3 简历审核（`resume_review`）**不走** resume 端点

`resume_review` 类型的 interrupt 只是"预览 + 等待"，用户的三个动作分别对应：

| 用户点击 | 前端调用 |
|---|---|
| **Accept** | `POST /v1/copilot/actions {type:"accept_variant", payload:{variantId, canvasMessageId}}` |
| **Revise** | `POST /v1/copilot/actions {type:"generate_resume_from_jd", payload:{jdId}, clientState:{activeResumeId}}` 重新跑一遍，或用 `optimize_resume_item`（先 accept 再改） |
| **Discard** | 什么都不用调；直接开新 Thread 或让用户重新描述需求 |

原因：目前 resume 子图的 interrupt 之后**没有再连回 draft_generation 节点**，所以 `resume` 端点对 resume_review 无效。

### 5.4 保存编辑后的简历画布

用户直接编辑画布后，前端必须先保存，不能只更新本地状态：

```http
PATCH /v1/threads/{threadId}/messages/{canvasMessageId}/resume-canvas
Content-Type: application/json

{
  "selectedVariantId": "variant-xxx",
  "content": "# 编辑后的简历 Markdown",
  "title": "可选的新标题"
}
```

该接口会同时更新 resume variant、已采纳时对应的 resume item，以及历史消息内的
`content_snapshot`；因此刷新或重新进入历史会话时显示的仍是编辑后的版本。

---

## 6. 确定性动作：`POST /v1/copilot/actions`

按钮触发的产品动作请走这个端点，**不要**走 `/chat`。它是同步的（无 SSE），响应格式和 `/chat` 非流式一致。

### 6.1 请求外壳

```json
{
  "threadId": "thread-xxx" | null,     // 可选；不传后端会自动新建
  "action": { "type": "<one_of>", "payload": { ... } },
  "clientState": { ... }
}
```

### 6.2 全部 `type` 一览

| type | payload | 用途 | 交互后果 |
|---|---|---|---|
| `optimize_resume_item` | `{resumeItemId, instruction?}` | 优化单条简历条目 | 覆盖写 `resume_items.content_snapshot`；返回 `data.workspace.resume_item_id` |
| `rewrite_experience` | `{experienceId, instruction?}` | 重写单条经历 | 新增 `experience_revisions` 记录，返回 `data.revisionId`（**不覆盖**原经历） |
| `generate_resume_from_jd` | `{jdId}` | 从 JD 生成简历 | 走 resume 子图，返回时**带 interrupt**（`type:resume_review`）；前端渲染 variant 预览 |
| `accept_variant` | `{variantId, canvasMessageId?}` | 采纳一个 variant | 把 variant 内容作为一个 `resume_item` 追加到简历，并更新对应历史画布状态 |
| `show_evidence` | `{variantId}` | 拉证据链 | 返回该 variant 引用的经历证据 |
| `generate_artifact` | `{artifactType, instruction?}` | 生成 Artifact | 落库到 `artifacts`；`artifactType` ∈ `cover_letter` \| `self_intro` \| `match_report` \| `interview_prep` \| `linkedin_summary` \| `other` |
| `export_resume` | `{resumeId}` | 导出简历 | 返回一份可打印的 payload；PDF 由前端浏览器 print-to-PDF |

### 6.3 三个最常用示例

**（a）生成简历（返回 interrupt）**

```json
POST /v1/copilot/actions
{
  "action": { "type": "generate_resume_from_jd", "payload": { "jdId": "jd-xxx" } },
  "clientState": { "locale":"zh-CN", "activeJdId":"jd-xxx" }
}
```

响应关键字段：

```json
{
  "data": {
    "threadId": "thread-xxx",
    "workspace": { "jd_id":"jd-xxx", "resume_id":"resume-xxx" },
    "interrupt": {
      "type": "resume_review",
      "variants": [ { "id":"variant-xxx", "content":"# 个人简历\n\n...", "score":{...} } ]
    }
  }
}
```

前端：把 `variants[0].content` 渲染到简历预览面板，弹出 Accept/Revise/Discard 三个按钮。

**（b）采纳 variant**

```json
POST /v1/copilot/actions
{
  "action": { "type": "accept_variant", "payload": { "variantId": "variant-xxx", "canvasMessageId": "msg-xxx" } }
}
```

响应：

```json
{
  "data": {
    "workspace": {
      "resume_id": "resume-xxx",
      "variant_id": "variant-xxx",
      "resume_item_id": "item-xxx"    // ← 新建的条目 id，前端保存起来
    }
  }
}
```

**（c）优化单条条目（手术刀改动）**

```json
POST /v1/copilot/actions
{
  "action": {
    "type": "optimize_resume_item",
    "payload": {
      "resumeItemId": "item-xxx",
      "instruction": "删掉编造的3年经验和A/B实验经验，改成真实的应届生视角"
    }
  }
}
```

响应回来后，前端调 `GET /v1/product/resumes/{resumeId}` 刷新预览，或直接拿响应里的 `workspace.resume_item_id` 单独拉 `GET /v1/product/resumes/{id}`（目前没有单条 item 的 GET，需要 resume 全量拉）。

### 6.4 已知坑：优化 item 会覆写整段

`optimize_resume_item` 目前用 LLM `chat()` 直接输出一段替换整个 `content_snapshot`。如果用户的 instruction 只提到 Summary，LLM 可能只返回 Summary 段，其他 section 会丢。

**前端对策**（后端修好前）：
- 优化前，把当前 `content_snapshot` **原封不动**拼进 instruction 前缀："请只修改 Summary 部分，其他 section 保持不变。当前完整内容如下：\n\n<原文>"；
- 或者按 Section 拆成多个 `resume_items` 后再改（后端未来会加 splitter）。

---

## 7. 文件上传：`/files/upload` 与 `/files/{id}/parse`

### 7.1 上传

```http
POST /v1/files/upload
Content-Type: multipart/form-data

file: <binary>
```

- 支持类型：`application/pdf` / `application/vnd.openxmlformats-officedocument.wordprocessingml.document` / `text/plain` / `text/markdown`。
- 大小上限：10 MB。
- 响应：

```json
{
  "success": true,
  "data": {
    "fileId": "file-xxx",
    "filename": "简历.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 213950
  }
}
```

### 7.2 预览解析文本（可选）

```
POST /v1/files/{fileId}/parse   →  { "fileId", "parsedText", "charCount" }
```

**前端不需要主动调**这个接口。对话流会自动懒解析 —— 用户在 chat 里带上 `clientState.resumeUpload.fileId` 后，后端第一次读会解析并缓存。

**主动调的场景**：前端想在弹出对话框前先预览文本内容给用户确认。

### 7.3 完整"上传→解析→导入"典型流

```ts
// 1. 上传
const upResp = await fetch("/v1/files/upload", { method:"POST", body: formData });
const { fileId, filename, mimeType } = (await upResp.json()).data;

// 2. 直接进入对话（不用手动 parse）
await chatStream(activeThreadId, "帮我把这份简历里的经历导入到经历库", {
  locale: "zh-CN",
  resumeUpload: { fileId, originalName: filename, mimeType }
}, {
  onInterrupt: async (evt) => {
    if (evt.data.type === "experience_import") {
      // 3. 弹审核 UI
      const confirmed = await showReviewDialog(evt.data.candidates);
      // 4. 恢复
      await fetch(`/v1/threads/${activeThreadId}/resume`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          turnId: currentTurnId,
          confirmedData: { confirmed_candidates: confirmed }
        })
      });
    }
  },
  onCompleted: (resp) => {
    // 5. 刷新经历库
    refreshExperiences(resp.workspace.experience_ids);
  }
});
```

---

## 8. Router 行为速查（前端可预测系统会怎么走）

Router 的启发式规则（后端 `router.py`）：

| 用户消息包含 | 走向 |
|---|---|
| `clientState.resumeUpload.fileId` 非空（且未消费）| `experience_import` |
| "保存/导入/添加" + "JD/岗位/职位" | `jd` |
| "保存/导入/添加" + "经历/项目/实习" | `experience_import` |
| "自我介绍" / "cover letter" / "求职信" / "匹配报告" / "面试准备" / "linkedin" | `artifact`（对应 `artifact_type`） |
| "简历" + "生成/写/优化/改" | `resume_generation` |
| 其余 | LLM Router 判定（0.6 confidence 以下 → `open_ended`） |

**前端可利用的信息**：

- 想强制走某条链路 → 让消息文本命中上表关键词；
- 想避免"改简历"被吞到全量重生成（本次实测的问题）→ **用按钮走 `/actions`**，不用对话；
- 上传文件后 Router 恒定命中 `experience_import`，不用担心走岔。

---

## 9. 上下文/记忆的边界

**后端会记的**：
- Thread 内所有消息（`thread_messages` 表）；
- LangGraph checkpointer 保存的 state（`extracted_params`、`workspace`、`assembled_experiences` 等）；
- 用户偏好（PreferenceBank，长期）；
- Guideline RAG 与 Evidence RAG（用户经历向量库）。

**前端不需要做的**：
- ✗ 手动拼历史消息 / prompt / system message；
- ✗ 手动查 RAG 或选相关经历；
- ✗ 传 `activeExperienceIds`（除非你想显式限定用哪几条）。

**前端需要做的**：
- ✓ 维护 `activeThreadId` 并回传；
- ✓ 维护 `activeJdId / activeResumeId / activeArtifactId` 回传（决定 workspace）；
- ✓ 上传文件后传 `resumeUpload.fileId`。

---

## 10. 预览面板刷新策略

### 10.1 简历预览

监听事件顺序：`content.diff.started` → 多个 `content.diff.delta` → `content.diff.completed`。

策略：
1. 收到 `content.diff.started`：清空 canvas，显示 loading；
2. 收到 `content.diff.delta`：按 `operations` 顺序 apply（当前只有整段 insert，直接把 `text` 设为 canvas 内容即可）；
3. 收到 `content.diff.completed`：结束 loading；
4. 收到 `agent.interrupt(type=resume_review)`：把 `data.variants[i].content` 作为可切换的候选版本；
5. 用户 Accept 后调 `POST /v1/copilot/actions {type:accept_variant}` → 收到 `workspace.resume_item_id` → 调 `GET /v1/product/resumes/{resume_id}` 拿定稿。

**历史重放（必做）**：加载 `GET /v1/threads/{threadId}` 后，按 `messages` 数组顺序渲染。
若某条消息满足 `message.metadata.presentation.type === "resume_canvas"`，在该消息位置渲染
画布，初始内容使用 `presentation.content_snapshot`，候选版本使用
`presentation.variants`。`status` 可为 `reviewing`、`edited` 或 `accepted`；不要用
`workspace.resume_id` 推断画布的位置或内容。

### 10.2 Artifact 预览（文本类走聊天渲染）

当前所有 Artifact 类型（`cover_letter` / `self_intro` / `match_report` / `interview_prep` / `linkedin_summary`）默认**不走画布事件**，完整 Markdown 直接出现在 `assistantMessage` 里，像普通消息一样在聊天流中渲染。

- **聊天渲染（默认）**：正常展示 `assistantMessage`，无需特殊处理；重进 thread 时历史消息里也能看到原文。
- **画布渲染（白名单，当前为空）**：仅当后端将该类型加入 `_CANVAS_ARTIFACT_TYPES` 时才发送 `artifact.started` → `artifact.delta` → `artifact.completed`，策略不变：
  1. `artifact.started`：新建 tab；
  2. `artifact.delta`：渲染到 Markdown 预览；
  3. `artifact.completed`：拉 `GET /v1/product/artifacts/{id}` 拿定稿版本。

### 10.3 经历库

只在两个时机刷新：
- `agent.completed` 且 `workspace.experience_ids` 非空 → 刷新经历库列表；
- 前端主动调 CRUD 后 → 局部更新。

### 10.4 进程面板（右侧"AI 正在做什么"）

监听 `agent.activity.updated`，按 `sequence` 排序，展示 `agent_label` + `action` + `status`。同 `sequence` 后到的覆盖先到的（用 `sequence` 做 key）。

---

## 11. 已知问题与前端应对（截止 2026-07-11）

| # | 问题 | 状态 |
|---|---|---|
| 1 | 同一 Thread 跨意图会被旧的 interrupt / extracted_params 卡住 | ✅ 已修复：每轮自动清挂起态；意图模糊时 AI 反问 |
| 2 | 对话说"改简历"会全量重生成，不做手术刀 | UI 上把"改简历"做成条目级按钮 → 调 `optimize_resume_item`；不要引导用户在对话里说 |
| 3 | 简历生成有编造（3 年经验、A/B 经验、日期漂移、丢经历）| Accept 前提示用户"AI 生成内容可能有幻觉，请仔细核对"；提供并列显示"原始经历 vs. AI 输出"的对照视图 |
| 4 | `agent.completed` / `agent.route.completed` 重复触发 | 前端去重：只处理**含完整 `response`** 的 `agent.completed`；`route.completed` 只看最后一条 |
| 5 | `accept_variant` 把整份 Markdown 塞成单个 `resume_item`，后续 `optimize_resume_item` 有覆写风险 | 参见 §6.4：在 instruction 前缀里附上原文并强调保留其他 section |
| 6 | 首次运行 `dev-user` 不在 users 表会 500 | 只影响本地联调；后端已知，等修 |
| 7 | 生成简历耗时 20–50s（DeepSeek reasoning 模型）| 前端务必用 stream 版本；显示 activity 事件当进度条，避免用户干等 |

---

## 12. 状态机（重点流程）

```
                    ┌────────────────────────────────────┐
                    │  上传简历 → 导入经历（对话流）        │
                    └────────────────────────────────────┘
POST /files/upload → 拿到 fileId
    │
    ▼
POST /copilot/chat/stream  { message, clientState:{ resumeUpload:{fileId} } }
    │
    ├─ SSE: activity.updated (frontdesk 正在理解)
    ├─ SSE: route.completed (target=experience_import)
    ├─ SSE: activity.updated (experience_orchestrator 正在解析)
    ├─ SSE: thinking (Found N experience(s))
    └─ SSE: agent.interrupt (type=experience_import, candidates:[...])
                                                          │
              前端弹审核 UI, 用户勾选/编辑                    │
                                                          ▼
POST /threads/{threadId}/resume { turnId, confirmedData:{ confirmed_candidates } }
    │
    └─ 200 OK: workspace.experience_ids = [...]  ← 落库完成
```

```
                    ┌────────────────────────────────────┐
                    │  从 JD 生成简历（按钮触发）           │
                    └────────────────────────────────────┘
POST /copilot/actions { type:generate_resume_from_jd, payload:{jdId} }
    │
    └─ 200 OK: interrupt.type=resume_review, variants:[{id, content, score}]

前端把 variants[0].content 渲染到简历预览面板, 弹 Accept/Revise/Discard
    │
    ├─ Accept  → POST /copilot/actions { type:accept_variant, payload:{variantId, canvasMessageId} }
    │             → resume_item_id (落库到 resume_items)
    │
    ├─ Revise  → 新 Thread + POST /copilot/actions { type:generate_resume_from_jd, ... }
    │             或改用 optimize_resume_item
    │
    └─ Discard → 什么都不调
```

---

## 13. 联调 Checklist

前端联调建议按顺序验证：

1. ☐ `GET /v1/health` 通
2. ☐ `POST /v1/files/upload` 拿到 `fileId`
3. ☐ `POST /v1/files/{id}/parse` 拿到 `parsedText`（可选）
4. ☐ `POST /v1/copilot/chat/stream` 消费 SSE、收到 `agent.interrupt`
5. ☐ `POST /v1/threads/{id}/resume` 完成经历导入
6. ☐ `POST /v1/copilot/chat/stream` 发 JD（**必须新 Thread**）→ 拿到 `jd_id`
7. ☐ `POST /v1/copilot/chat/stream` 发"帮我根据 JD 挑选经历" → 生成 Artifact
8. ☐ `POST /v1/copilot/actions {type:generate_resume_from_jd}` → 拿到 variant
9. ☐ `POST /v1/copilot/actions {type:accept_variant}` → 拿到 `resume_item_id`
10. ☐ `POST /v1/copilot/actions {type:optimize_resume_item}` → 条目更新
11. ☐ `GET /v1/copilot/sidebar` → 侧栏最近记录

---

## 14. FAQ

**Q1：为什么 `agent.completed` 收到好几次？**
主图和每个子图都会发。前端只处理 `response.assistantMessage.content` 非空的那一条（通常是**最后一条**）。

**Q2：`activeExperienceIds` 传不传？**
不传：后端会用 RAG 自动挑相关经历（推荐）。传：显式限定这几条经历参与（用于"只用某几段经历生成"的场景）。

**Q3：为什么"改一下简历的 Summary"没生效？**
Router 把这句路由到 `resume_generation` 后，把整份重新生成了，且用户的具体订正没被透传（后端 bug 3）。**用条目级按钮触发 `optimize_resume_item`**。

**Q4：`turnId` 从哪儿来？**
- `chat` / `chat/stream` 响应的 `data.turnId`；
- SSE 里的 `agent.activity.updated.turn_id`；
- SSE 里的 `agent.completed.turnId`。
都是同一个值，取任一都行。

**Q5：如果 SSE 中途断了怎么办？**
后端不支持断点续传。前端把已收到的部分渲染出来，让用户重发即可；LangGraph checkpointer 会保留 state，同 threadId 重发不会重复扣钱（幂等靠 `turnId` + 消息内容判断，但目前后端未做严格幂等，建议前端拦一下重复点击）。

**Q6：非 SSE 的 `/chat` 什么时候用？**
只在你有明确理由（例如 SSR、单元测试、Server Action 环境不方便消费流）时。默认全走 stream。

**Q7：能不能在同一个 Thread 里做完 "导入经历 → 分析 JD → 生成简历"？**
理论上应该可以，但当前后端有 §11.1 的 bug。**推荐**每个大动作开新 Thread，UI 上呈现为"每个任务一个对话"。修好后再合并。

---

## 15. 附录：完整 TypeScript 类型定义（可直接拷贝）

```ts
// ── ClientState ────────────────────────────────────────────
export interface ClientState {
  locale?: string;
  activeJdId?: string | null;
  activeResumeId?: string | null;
  activeArtifactId?: string | null;
  activeExperienceIds?: string[];
  activeThreadId?: string | null;
  resumeUpload?: {
    fileId: string;
    originalName?: string;
    fileName?: string;
    mimeType?: string;
  } | null;
  // 兼容字段（择一使用；推荐 resumeUpload）
  uploadedFileId?: string | null;
  resumeFileId?: string | null;
  activeFileId?: string | null;
  fileId?: string | null;
  intentSource?: string;
  sourceComponent?: string;
}

// ── GET /threads/{id} ─────────────────────────────────────
export interface ThreadDetailResponse {
  thread: {
    id: string;
    title: string | null;
    status: string;
    createdAt: string;   // ISO 8601
    updatedAt: string;
  };
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    metadata: Record<string, unknown>;
    turnId: string | null;
    createdAt: string;
  }>;
  workspace: {
    jd_id?: string;
    artifact_id?: string;
    artifact_type?: string;
    artifact_title?: string;
  };
  interrupt: InterruptPayload | null;  // non-null if thread is suspended at an interrupt
}

export interface ResumeCanvasPresentation {
  type: "resume_canvas";
  schema_version: 1;
  resume_id?: string;
  variant_ids: string[];
  variants: Array<{ id: string; title?: string; content: string; score?: Record<string, number> }>;
  selected_variant_id: string;
  content_snapshot: string;
  status: "reviewing" | "edited" | "accepted";
  resume_item_id?: string;
}

// 对 ThreadDetailResponse.messages[i].metadata：
// metadata.presentation 可为 ResumeCanvasPresentation；存在时在该 message 的位置渲染画布。

// ── /copilot/chat & chat/stream ────────────────────────────
export interface ChatRequest {
  threadId?: string | null;
  message: string;
  clientState?: ClientState;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  content: string;
  createdAt: string;
}

export interface Workspace {
  jd_id?: string;
  resume_id?: string;
  artifact_id?: string;
  experience_ids?: string[];
  file_id?: string;
  uploaded_file_id?: string;
  resume_file_id?: string;
  variant_id?: string;
  resume_item_id?: string;
  experience_id?: string;
}

export interface JdRequirementPayload {
  id: string;
  text: string;
  category: string;
  importance: "high" | "medium" | "low";
}

export interface JdCandidatePayload {
  title: string;
  company?: string | null;
  target_role?: string | null;
  raw_text: string;
  requirements: JdRequirementPayload[];
}

export interface InterruptPayload {
  interrupt_id?: string;
  type: "experience_import" | "resume_review" | "confirm_action" | "jd_save";
  message?: string;
  /** resume_review */
  variants?: Array<{
    id: string;
    title?: string;
    content?: string;
    score?: Record<string, number>;
    resume_id?: string;
    jd_id?: string;
  }>;
  /** experience_import */
  candidates?: Array<{
    title: string;
    organization?: string;
    start_date?: string | null;
    end_date?: string | null;
    content: string;
    category: "work" | "project" | "education" | "volunteer" | "other";
    role?: string | null;
    tags?: string[];
  }>;
  /** jd_save */
  candidate?: JdCandidatePayload;
  action_options?: Array<{ id: string; label: string; description: string }>;
}

export interface ChatResponse {
  threadId: string;
  turnId: string;
  assistantMessage: AssistantMessage;
  workspace: Workspace;
  nextActions: Array<Record<string, unknown>>;
  suggestedPrompts: string[];
  interrupt: InterruptPayload | null;
}

// ── SSE events ────────────────────────────────────────────
export type SSEEvent =
  | { event: "agent.activity.updated"; thread_id?: string; turn_id?: string;
      sequence: number; timestamp: string;
      agent_role: "frontdesk" | "experience_orchestrator" | "jd_analyst" | "resume_writer" | "resume_reviewer";
      agent_label: string; status: "running" | "waiting_user" | "completed" | "failed"; action: string; }
  | { event: "agent.route.completed"; target: string; intent_description: string; confidence: number }
  | { event: "agent.thinking"; text: string }
  | { event: "content.diff.started"; resume_id: string; section: string }
  | { event: "content.diff.delta"; operations: Array<{ op: "insert" | "delete" | "equal"; text: string }> }
  | { event: "content.diff.completed"; resume_id: string; total_insertions: number; total_deletions: number }
  | { event: "artifact.started"; artifact_type: string; title: string }
  | { event: "artifact.delta"; content: string }
  | { event: "artifact.completed"; artifact_id: string; title: string; word_count: number }
  | { event: "agent.interrupt"; interrupt_type: string; data: InterruptPayload }
  | { event: "agent.completed"; threadId?: string; turnId?: string; response?: ChatResponse }
  | { event: "agent.failed"; error: { code: string; message: string } };

// ── /copilot/actions ──────────────────────────────────────
export type ActionType =
  | "optimize_resume_item"
  | "rewrite_experience"
  | "generate_resume_from_jd"
  | "accept_variant"
  | "show_evidence"
  | "generate_artifact"
  | "export_resume";

export interface ActionRequest {
  threadId?: string | null;
  action:
    | { type: "optimize_resume_item"; payload: { resumeItemId: string; instruction?: string } }
    | { type: "rewrite_experience"; payload: { experienceId: string; instruction?: string } }
    | { type: "generate_resume_from_jd"; payload: { jdId: string } }
    | { type: "accept_variant"; payload: { variantId: string; canvasMessageId?: string } }
    | { type: "show_evidence"; payload: { variantId: string } }
    | { type: "generate_artifact"; payload: { artifactType: string; instruction?: string } }
    | { type: "export_resume"; payload: { resumeId: string } };
  clientState?: ClientState;
}

// ── /threads/{id}/resume ──────────────────────────────────
export interface ResumeRequest {
  turnId: string;
  confirmedData?:
    /** experience_import */
    | { confirmed_candidates?: Array<InterruptPayload["candidates"][0]> }
    /** jd_save */
    | { confirmed: boolean; candidate?: Partial<JdCandidatePayload> }
    | Record<string, unknown>;
}
```

---

## 16. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-07-11 | 首版；基于当日实测（DeepSeek-V4-Flash）撰写；含 §11 已知问题清单 |
| 2026-07-11 | JD 保存新增 `jd_save` interrupt（§4.3.6c）；Artifact 默认走聊天渲染、不发 `artifact.*` 事件（§4.3.5 / §10.2）；JD 接口加 `sourceThreadId` 字段；TS 类型更新（§15）|
