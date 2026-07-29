# API v1 设计说明

> 状态：Review Draft v0.1
> 日期：2026-07-26
> 机器可读契约：[`api/openapi/openapi.yaml`](../../api/openapi/openapi.yaml)

## 1. 范围

正式 API 覆盖：

- 邮箱验证码、开发密码登录、Session 和设备撤销；
- Profile、Subscription Entitlement；
- Experience、JD、Resume 完整 CRUD；
- Application、状态事件、Interview、Note、Reminder；
- Push、Pull、Bootstrap 双向同步。

LLM、Agent、Prompt、Conversation、Proposal、MatchReport、浏览器填表过程、Resume checkpoint 和
Material 不属于本 API。

## 2. 两条写入入口

在线 CRUD 与离线 Sync Push 共用同一组 Application Service 和 Domain 规则：

```text
Direct CRUD ─┐
             ├─ Use Case / Transaction / Repository
Sync Push  ──┘
```

- Direct CRUD 供在线页面和单资源操作使用；
- Sync Push 承载 APP Local Outbox 的离线命令；
- 两者都校验用户所有权、Entitlement、`entityVersion`、幂等和状态机；
- Sync Handler 不直接写表，也不复制一套业务规则；
- Direct CRUD 成功同样写 `sync_changes`，供其他设备 Pull。

## 3. 兼容策略

- 保留 `/v1`、`access_token` Cookie 和 success/error envelope；
- 现有 Experience/JD 创建请求继续接受 snake_case；
- Resume `structured` 及内部质量资产保持 snake_case；
- 响应业务字段使用 camelCase；
- JD 的 `requirementMapId/sourceThreadId` 和 Experience 的 `factBankStatus` 仅作为 APP 过渡兼容
  字段，由 DTO 派生固定/null 值，不进入数据库；
- Experience 日期保留 APP 的 `YYYY-MM`/`YYYY-MM-DD` 精度，`endDate` 可为 `present`；
- Resume publish 的 `proposalId/sourceFingerprint/evidenceBindings/observation` 作为兼容输入接收，
  不建立 Agent 或 Observation 云端表；
- 新增 `entityVersion` 后，APP Adapter/类型必须接线，写入不允许退回无条件覆盖。

## 4. 并发与幂等

- Create 使用 `Idempotency-Key`；Resume publish 暂兼容 body 内同名字段，离线实体可由 APP 提供 UUIDv7；
- Update body 必须提供 `expectedVersion`；
- Delete query 必须提供 `expectedVersion`；
- Resume Replace 至少提供稳定的 `expectedContentHash`；已持久化云端版本的客户端可同时提供
  `expectedEntityVersion`。当前 APP 使用 content hash，避免幂等重试时临时读取版本导致请求 hash 漂移；
- Application status 只能通过 transition command 修改；
- Sync 单项使用稳定 `operationId`，批次使用 `Idempotency-Key`；
- 版本冲突返回 `409 ENTITY_VERSION_CONFLICT`，不自动 last-write-wins。

## 5. 删除和归档

- 普通 DELETE 只写 `deletedAt` 并递增 `entityVersion`；
- 墓碑保留到账号物理清除；
- `archived` 是可恢复业务状态，不是删除；
- JD/Resume 删除后 Application 继续显示快照；
- 状态事件不可普通删除。

JD 入参优先使用 `v2_importance/v2_category` 作为数据库规范值；兼容字段按
`must_have↔high`、`preferred↔medium`、`optional↔low` 映射，无 v2 category 时非法旧类别归入
`other`。Resume 未提供质量摘要时返回零分和空数组，不触发后端 LLM。

## 6. Application 规则

- 用户确认投递完成后才创建普通 Application；
- 新正式投递由 APP 选择 JD 与实际 Resume，并提交当前本地 Resume 投影的
  `resumeContentHashSnapshot`；该字段不包含正文，也不提供版本回退能力；
- 普通 PUT 保留该指纹；只有 `resumeId` 显式变化时才接收并刷新新指纹；
- 浏览器/邮件自动识别可创建 `pendingConfirmation=true` 的记录；
- `offer/rejected/no_response` 为终态；
- 通用 PUT 不接受 `status`；
- transition 与 status event 在一个事务提交；
- Reminder 只同步状态，Electron 负责触发本地系统通知。

## 7. 分页与性能

- 资源列表和 Pull 使用 opaque cursor；
- 资源列表默认 100、最大 500；
- Sync Push 每批最多 100 个 operation；
- Pull/Bootstrap 每页最多 500；
- Resume 列表不返回 `structured` 大文档；
- 看板按 status + updatedAt 的 keyset 索引读取；
- API 不为普通 CRUD 引入 Redis 缓存。

## 8. APP 联调状态

- APP 的 Experience/JD 现有 Create 请求已补充稳定 `Idempotency-Key`，无业务操作 ID
  的兼容调用使用随机 UUID；
- APP 的 Experience/JD/Resume Normalizer 与共享类型已接收 `entityVersion/deletedAt`，
  Resume metadata PATCH 会先读取当前版本再提交 `expectedVersion`；
- Resume Replace 沿用 APP 已持久化的 `expectedContentHash`，并由后端拒绝无任何并发保护的替换；
- LocalSyncStore、Outbox 和 Sync Worker 内核已接入；Resume 以及 Experience/JD 的现有
  创建/查询调用面已切换。Experience/JD 后续编辑/删除入口、Application 和统一冲突 UI
  仍需按 App roadmap 逐模块接入；
- OTP、Application Tracker、Interview 与 Reminder Adapter 尚未接入；本轮按用户要求不新增
  APP 当前不存在的 Tracker API/UI。

## 9. Phase 2 已实现参考切片

- `/sync/pull` 强制使用 HMAC 签名、用户绑定且有时效的 cursor；
- `/sync/bootstrap` 在首屏捕获 `sync_changes` 高水位，结束后返回可直接 Pull 的 cursor；
- `/sync/push` 按 operation 独立事务执行，Profile 写入、`sync_changes` 和
  `sync_operations` 原子提交；
- `user_profile/update` 是首个端到端参考实现，其他 entity/action 在其所属 Phase
  注册前逐项返回 `validation_failed`；
- `GET /users/me` 增加当前 Session 的 `deviceId`，APP 用它恢复对应同步 Worker。
