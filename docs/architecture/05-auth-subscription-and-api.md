# 认证、订阅与 API

> 状态：Draft v0.1  
> 日期：2026-07-26

## 1. 正式认证流程

正式产品采用邮箱验证码免密码登录：

```text
输入邮箱
→ 请求验证码
→ 邮件服务发送验证码
→ 用户提交验证码
→ 服务端创建/查找用户
→ 注册 device
→ 设置 access_token Session Cookie
→ 返回 User、Device 和 Entitlement summary
```

### 请求验证码

```http
POST /v1/auth/email/challenges
```

输入：

- email；
- purpose：`login`；
- device metadata；
- 客户端 challenge ID。

安全要求：

- 邮箱规范化；
- 验证码只存哈希；
- 短有效期；
- 单 challenge 尝试次数上限；
- 邮箱、IP、设备多维限流；
- 响应不暴露邮箱是否已注册；
- 发送失败不能创建可验证 challenge。

### 验证并登录

```http
POST /v1/auth/email/verify
```

成功返回：

- 与现有 APP 兼容的 `Set-Cookie: access_token=...`；
- User；
- Device；
- Entitlement summary。

`access_token` 使用高熵 opaque Session Token，数据库只保存 hash。Token 由 APP 保存在系统
Keychain，Renderer 不接触 Token；Session 可按设备撤销并设置绝对过期时间。

### 登出

```http
POST /v1/auth/logout
DELETE /v1/devices/{deviceId}/sessions
```

支持当前设备登出和远程撤销设备。

## 2. 开发密码登录

```http
POST /v1/auth/login
```

只在 local/test 环境注册路由：

- 请求为 email + password；
- 密码使用 Argon2id；
- 开发账号由 seed/CLI 创建；
- staging 默认仍使用邮箱验证码；
- production 出现启用配置时进程拒绝启动；
- production 不注册密码处理逻辑；
- endpoint、envelope 和 `access_token` Cookie 与当前 APP 完全兼容。

正式用户表不需要长期密码字段。开发凭据建议独立表或独立测试数据库，避免形成隐形生产能力。

## 3. 订阅与权益

当前阶段不接支付，但先建立完整能力边界。

### Entitlement 查询

```http
GET /v1/users/me/entitlements
```

返回示例：

```json
{
  "plan": "development",
  "subscriptionStatus": "active",
  "features": {
    "resumeCloudLimit": 100,
    "experienceLimit": 200,
    "applicationTracking": true,
    "syncEnabled": true
  },
  "effectiveUntil": null
}
```

约束：

- APP 可以缓存权益，但服务端写入仍需校验；
- 业务代码依赖 feature code，不依赖支付供应商；
- 未接支付时使用 `development`、`internal` 等受控 plan；
- 未来支付 webhook 只改变 Subscription，再重新计算权益；
- Subscription event 必须幂等。

## 4. API 风格

- Base path：`/v1`；
- 已有 APP v1 访问与资产 endpoint、envelope 和字段名优先兼容；
- 响应顶层通常使用 camelCase，但现有 snake_case 请求和 Resume 内层字段必须保留；
- 时间统一 RFC 3339 UTC；
- ID 使用 UUID 字符串；
- 列表使用 cursor，不使用深 offset；
- 写入支持 `Idempotency-Key`；
- 更新携带 `expectedVersion`；
- Resume 可额外携带 `expectedContentHash`；
- 删除默认返回墓碑后的实体摘要；
- OpenAPI 是后端正式功能 API 的机器可读来源。

现有 APP 兼容参考见
[`07-app-contract-compatibility.md`](./07-app-contract-compatibility.md)。

## 5. 错误格式

```json
{
  "success": false,
  "error": {
    "code": "ENTITY_VERSION_CONFLICT",
    "message": "资源已在其他设备更新"
  },
  "request_id": "uuid"
}
```

错误码稳定，详细冲突信息可以作为向后兼容字段增加。后端 message 不能包含 SQL、堆栈、
Token 或隐私数据。

主要状态码：

- `400` 请求格式错误；
- `401` 会话无效；
- `403` 权属或权益禁止；
- `404` 资源不存在；
- `409` 版本、状态或幂等冲突；
- `422` 领域校验失败；
- `429` 限流；
- `503` 临时不可用。

## 6. 核心资源 API

### Profile

```text
GET   /v1/users/me
GET   /v1/users/me/profile
PUT   /v1/users/me/profile
```

### Experience

```text
GET    /v1/product/experiences
POST   /v1/product/experiences
GET    /v1/product/experiences/{id}
PUT    /v1/product/experiences/{id}
DELETE /v1/product/experiences/{id}
GET    /v1/product/experiences/{id}/revisions
```

### JD

```text
GET    /v1/product/jds
POST   /v1/product/jds
GET    /v1/product/jds/{id}
PUT    /v1/product/jds/{id}
DELETE /v1/product/jds/{id}
```

JD 和 requirements 的完整更新默认在同一 PUT 中原子完成。

### Resume

```text
GET    /v1/product/resumes
GET    /v1/product/resumes/{id}
POST   /v1/product/resumes/publish
PUT    /v1/product/resumes/{id}/publish
PATCH  /v1/product/resumes/{id}
DELETE /v1/product/resumes/{id}
```

- publish POST/PUT 必须提交完整 `structured`；
- PATCH 只修改 title、status 等元数据；
- DELETE 为同步软删除；
- App 本地 checkpoint 不属于这些 endpoint。

### Application

```text
GET    /v1/product/applications
POST   /v1/product/applications
GET    /v1/product/applications/{id}
PUT    /v1/product/applications/{id}
DELETE /v1/product/applications/{id}
POST   /v1/product/applications/{id}/transitions
GET    /v1/product/applications/{id}/status-events
```

### Interview、Note、Reminder

```text
GET/POST/PUT/DELETE /v1/product/applications/{id}/interviews
GET/POST/PUT/DELETE /v1/product/applications/{id}/notes
GET/POST/PUT/DELETE /v1/product/reminders
```

### Sync

```text
POST /v1/sync/push
GET  /v1/sync/pull
POST /v1/sync/bootstrap
```

`bootstrap` 用于新设备或 cursor 过期后的分页全量投影，不返回对话和 Resume checkpoint。

## 7. APP 兼容策略

新后端不迁移旧数据，并保证现有 APP 业务功能在替换后继续可用：

1. 当前 `CooltoApiClient` 对 Profile、Experience、JD 和 Resume 的调用优先直接复用；
2. 当前 success/error envelope 保持不变；
3. 当前 Normalizer 能复用则复用；新设计需要时允许同步修改；
4. 开发密码登录兼容当前 LoginScreen；
5. 正式 OTP 只新增登录步骤，成功后继续设置相同 `access_token` Cookie；
6. LocalSyncStore、Application 和 Interview 作为增量功能接入；
7. 不实现旧 Agent/LangGraph endpoint。

后端范围只包括认证/会话传输以及 Profile、Experience、JD、Resume、Application 等云端资产。LLM 调用、
Prompt、流式推理、Tool/Agent 事件和对话协议由 APP 自己负责，不进入本后端 OpenAPI。

这意味着替换后业务功能必须不变，但 OTP UI、双向同步和 Application 仍需要 APP 新增代码。参考矩阵见
[`07-app-contract-compatibility.md`](./07-app-contract-compatibility.md)。

## 8. 状态机

投递状态：

```text
applied
  ├─ screening
  ├─ rejected
  └─ no_response

screening
  ├─ interviewing
  ├─ rejected
  └─ no_response

interviewing
  ├─ interviewing
  ├─ offer
  ├─ rejected
  └─ no_response
```

- `offer`、`rejected`、`no_response` 为终态；
- 用户主动放弃使用 `rejected` + reason，或者后续评审是否增加 `withdrawn`；
- `applied → offer` 禁止；
- “下一轮”通过 InterviewRound 表达；
- 自动识别的记录先设 `pendingConfirmation=true`。
