# 现有 APP 访问与资产兼容参考

> 状态：Migration Reference v0.2  
> 日期：2026-07-26  
> 来源：`cv-agent-app/src/api/` 与当前共享类型

机器可读入口：[`api/openapi/openapi.yaml`](../../api/openapi/openapi.yaml)  
迁移样本与来源哈希：[`contracts/app-v1/README.md`](../../contracts/app-v1/README.md)

## 1. 兼容性结论

新后端的替换目标是现有 APP 业务功能不变。默认优先提供 v1 兼容层，以降低 APP 改动：

- 当前资源 endpoint 优先不改路径；
- 当前请求、响应和 envelope 能低成本兼容时继续兼容；
- Resume `structured` 不转换；
- 当前 Normalizer 和 `CooltoApiClient` 优先直接复用。

如果字段、错误模型或同步语义需要调整，可以同步修改 APP Adapter、Normalizer 和类型。禁止为了
追求字节级兼容，把 Agent 时代的冗余设计复制进新后端。

兼容参考包括：

- 认证、会话和 User/Profile 访问面；
- Experience、JD、Resume 等云端资产；
- 访问这些资产所依赖的 envelope、错误和分页语义。

明确不纳入新后端：

- LLM Provider 或模型调用；
- Agent、LangGraph、Prompt、Tool 和流式事件；
- 对话、Proposal、Resume Workspace 和 checkpoint 协议；
- APP 内部生成、匹配、改写和渲染流程。

但“整个 APP 完全零修改即可获得新后端所有能力”不成立，原因是：

1. 正式登录从密码改为邮箱验证码，登录 UI 必须新增验证码步骤；
2. 双向同步需要新增 LocalSyncStore、Outbox 和 Sync Worker；
3. Application、Interview 等是现有 APP 尚未实现的新资源。

因此兼容性分为：

| 层级 | 目标 |
| --- | --- |
| 已有业务 API | 优先 drop-in；必要时同步修改 APP Adapter |
| 已有本地存储 | 完全保留，不迁移、不破坏 |
| 开发密码登录 | 兼容当前 LoginScreen 和 Transport |
| 正式 OTP 登录 | 增量修改登录 UI，登录后的 Transport 保持兼容 |
| 双向同步与新模块 | 增量开发，不属于旧 contract |
| LLM/Agent 调用 | APP 自行负责，不属于本后端 contract |

## 2. 通用 HTTP Envelope

现有 APP 当前读取的成功响应为：

```json
{
  "success": true,
  "data": {},
  "request_id": "optional-string"
}
```

现有 APP 当前读取的错误响应为：

```json
{
  "success": false,
  "error": {
    "code": "stable_error_code",
    "message": "human-readable message"
  },
  "request_id": "optional-string"
}
```

首版优先保留该 envelope。若正式 API 需要调整，必须同时更新 APP Transport，不能只改服务端。

## 3. 会话兼容

当前 APP 的行为：

1. `POST /v1/auth/login`；
2. 从 `Set-Cookie` 提取 `access_token`；
3. 把 token 存入系统 Keychain；
4. 后续请求发送 `Cookie: access_token=<token>`；
5. `GET /v1/users/me` 恢复用户；
6. `POST /v1/auth/logout` 撤销会话。

新后端必须兼容该传输方式：

- `access_token` 可以是高熵 opaque session token，不要求是 JWT；
- 数据库只保存 token hash；
- 所有受保护 endpoint 接受 `access_token` Cookie；
- Cookie token 字符集必须满足当前 APP 的安全校验；
- 正式 OTP verify 成功后也设置同名 Cookie；
- 开发环境 `/v1/auth/login` 接收现有 `{email,password}`；
- production 不注册密码登录逻辑。

开发登录 `data` 至少返回 `{userId,email}`；`GET /v1/users/me` 至少返回 `{id,email}`。

正式 OTP 只改变取得 Cookie 之前的 UI 流程，登录后的 API Transport 可以继续使用。

## 4. 优先兼容 endpoint

### Auth 与 User

```text
POST /v1/auth/login                 # 仅 local/test，现有密码登录
POST /v1/auth/logout
GET  /v1/users/me
GET  /v1/users/me/profile
```

新增但不破坏旧路径：

```text
POST /v1/auth/email/challenges
POST /v1/auth/email/verify
GET  /v1/users/me/entitlements
```

### Experience

```text
GET  /v1/product/experiences
POST /v1/product/experiences
GET  /v1/product/experiences/{experienceId}
```

新增 CRUD 继续使用同一资源前缀：

```text
PUT    /v1/product/experiences/{experienceId}
DELETE /v1/product/experiences/{experienceId}
GET    /v1/product/experiences/{experienceId}/revisions
```

### JD

```text
GET  /v1/product/jds
POST /v1/product/jds
GET  /v1/product/jds/{jdId}
```

新增：

```text
PUT    /v1/product/jds/{jdId}
DELETE /v1/product/jds/{jdId}
```

### Resume

```text
GET   /v1/product/resumes?limit=100
GET   /v1/product/resumes/{resumeId}
POST  /v1/product/resumes/publish
PUT   /v1/product/resumes/{resumeId}/publish
PATCH /v1/product/resumes/{resumeId}
```

新增同步软删除：

```text
DELETE /v1/product/resumes/{resumeId}
```

不重新引入 variant、activeVariantId 或云端版本列表。

## 5. 字段命名参考

现有 v1 并非“全部 camelCase”。以下内容用于评估 Adapter 复用成本，不限制新业务模型设计。

### 响应

- User、Profile、Experience、JD、Resume 顶层使用当前 camelCase；
- 列表使用 `{items,nextCursor}`；
- Resume `structured` 内部继续使用 snake_case；
- Resume `evidenceSummary` 和 `riskSummary` 内部保留当前 snake_case；
- 允许增加 `entityVersion` 等可选字段；
- 不把 null 字段静默改为缺失字段，除非当前 Normalizer 明确允许。

### Experience 创建请求

当前 Adapter 发送：

```json
{
  "category": "work",
  "title": "title",
  "content": "content",
  "organization": null,
  "role": null,
  "location": null,
  "start_date": null,
  "end_date": null,
  "tags": []
}
```

### JD 创建请求

当前 Adapter 发送：

```json
{
  "title": "title",
  "raw_text": "raw",
  "company": null,
  "target_role": null,
  "requirements": [
    {
      "text": "requirement",
      "category": "technology",
      "importance": "high",
      "keywords": [],
      "v2_importance": "must_have",
      "v2_category": "technology"
    }
  ]
}
```

### Resume Publish 请求

当前 APP 的 Resume Publish 使用以下 camelCase 外层字段：

- `idempotencyKey`
- `proposalId`
- `title`
- `targetRole`
- `jdId`
- `sourceFingerprint`
- `structured`
- `evidenceBindings`
- `observation`
- `expectedContentHash`

其中 `structured`、evidence 和 observation 内部字段保持现有 contract。

## 6. 当前 Resume Normalizer 所需字段

若不修改当前 `normalizeResume`，列表项需要：

- `id`
- `title`
- `targetRole`
- `jdId`
- `contentHash`
- `schemaVersion`
- `qualityStatus`
- `status`
- `createdAt`
- `updatedAt`

若不修改当前详情 Normalizer，还需要：

- `structured`
- `content`
- `score`
- `evidenceSummary`
- `riskSummary`
- `missingInfo`
- `qualityIssues`
- `qualityGateVersion`

Publish 结果另外包含：

- `created`
- `pageUsageRatio`

## 7. 分页兼容

- Experience 支持 `q`、`category`、重复 `tags`、`limit`、`cursor`；
- JD 支持 `limit`、`cursor`；
- Resume 当前 APP 使用 `limit=100`；
- 响应 cursor 对 APP 不透明；
- 排序必须稳定；
- 新增同步 cursor 不改变资源列表 cursor。

## 8. 迁移对照与功能联调

现有 fixtures 用于回答“当前 APP 会发送和读取什么”，不是永久 contract test 门禁。替换时至少
完成功能联调：

1. 登录、恢复和登出；
2. Experience 创建、列表和详情；
3. JD 创建、列表和详情；
4. Resume 创建/保存、列表、详情、重命名和归档；
5. 401、409、422 能被 APP 正确呈现；
6. 新增 Application 与 Sync 后，原有 APP 功能仍可使用。

如果联调需要修改 APP Adapter，修改结果应和 OpenAPI 在同一阶段确认。

### 2026-07-26 提取记录

- 已从 APP Transport、resource adapters、runtime Normalizers、共享 Resume 类型和现有测试提取；
- 已生成认证、Profile、Experience、JD、Resume 和 error 共 21 个 payload fixtures；
- 已生成 1 个 JSON 来源清单和 1 个可由 `sha256sum` 直接检查的来源清单；
- 已记录 17 个上游源文件的 SHA-256，便于发现 APP contract 漂移；
- 已生成模块化 OpenAPI 3.1，并通过 Redocly 2.31.6 recommended lint；
- 当前样本覆盖 APP 已使用的 endpoint；OTP、Application 和 Sync 仍需正式设计；
- 不再计划建设跨仓库自动 contract runner，改用业务主流程联调。

## 9. 版本策略

- `/v1` 的访问与资产 API 优先作为现有 APP 兼容面；
- 新 CRUD 和 Sync 可以在 `/v1` 增量增加；
- 开发阶段可以同步修改 APP Adapter 和 `/v1`；
- 产品发布后需要统一命名或删除字段时，使用 `/v2`；
- 不为追求“整洁”同时维护两套含义相同的 v1 endpoint；
- 新后端不实现旧 LLM/Agent/LangGraph endpoint；这些能力和契约由 APP 自己管理。
