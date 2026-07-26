# 本地与云端同步设计

> 状态：Draft v0.1  
> 日期：2026-07-26

## 1. 目标

- APP 离线时可以查看和编辑同步域数据；
- 恢复网络后自动增量同步；
- 多设备写入不静默覆盖；
- 重试不重复创建数据；
- 删除能传播到离线设备；
- 兼容现有本地 Conversation 和 ResumeDraft；
- 同步失败不损坏本地工作数据。

## 2. 本地存储分层

```text
Existing Local Stores
├─ ConversationStore
├─ ResumeDraftStore
├─ SelectedFileRegistry
└─ Browser Session

New LocalSyncStore
├─ synced_entities
├─ local_outbox
├─ sync_state
├─ sync_conflicts
└─ sync_failures
```

建议使用 SQLite，并评估 SQLCipher 或“系统安全存储中的主密钥 + 字段加密”。现有加密文件不迁移。

## 3. 本地写入

所有可同步业务写入在一个本地事务完成：

1. 校验本地业务规则；
2. 更新本地实体；
3. 增加本地 `local_version`；
4. 写入 Outbox command；
5. 立即更新 UI；
6. 后台 Sync Worker 尝试上传。

Outbox 至少包含：

- `operation_id`；
- `entity_type`；
- `entity_id`；
- `operation`；
- `base_entity_version`；
- `payload`；
- `created_at`；
- `attempt_count`；
- `next_attempt_at`。

## 4. Push

```http
POST /v1/sync/push
Idempotency-Key: <batch-id>
```

请求按操作批次提交：

```json
{
  "deviceId": "uuid",
  "operations": [
    {
      "operationId": "uuid",
      "entityType": "application",
      "entityId": "uuid",
      "action": "upsert",
      "expectedVersion": 4,
      "payload": {}
    }
  ]
}
```

服务端逐项返回：

- `applied`：写入成功；
- `already_applied`：幂等重试；
- `conflict`：服务端版本已变化；
- `validation_failed`：业务校验失败；
- `forbidden`：权属或权益不允许；
- `retryable_error`：可安全重试。

批次响应必须精确到单项，避免一个错误让全部操作失去结果。

## 5. Pull

```http
GET /v1/sync/pull?cursor=<opaque-cursor>&limit=500
```

响应：

```json
{
  "changes": [],
  "nextCursor": "opaque",
  "hasMore": false,
  "serverTime": "2026-07-26T00:00:00Z"
}
```

规则：

- Cursor 对 APP 不透明；
- Pull 按服务端 `change_seq` 排序；
- 每页在本地事务中应用；
- 成功提交本地事务后才更新 cursor；
- 删除以 tombstone 返回；
- Cursor 不依赖客户端时钟；
- 过期 cursor 返回“需要全量重建同步投影”，不影响本地对话和草稿。

## 6. 同步循环

```text
登录/恢复会话
→ 注册或恢复 device
→ Push 本地 Outbox
→ Pull 云端 changes
→ 处理冲突
→ 保存 cursor
→ 网络恢复、定时器或用户刷新时再次执行
```

同一设备只允许一个 Sync Worker 持有同步锁。

## 7. 冲突策略

### Resume

Resume 使用强冲突保护：

- 本地 `cloudLink.contentHash`；
- 云端 `contentHash`；
- 云端 `entityVersion`；
- 本地 `syncedRevision`。

本地与云端都修改时，生成冲突记录并提供：

1. 重读云端；
2. 另存为新 Resume；
3. 用户明确确认后覆盖云端。

禁止自动 last-write-wins。

### Application

- 元数据更新使用 `expectedVersion`；
- 状态变更使用独立 transition command；
- 冲突时拉取服务端最新值；
- 非重叠字段可以在本地生成合并预览；
- 状态、面试时间和删除等关键字段必须由用户确认。

### Experience 与 JD

- 普通字段更新使用乐观锁；
- Experience 当前 revision 变化时不自动合并正文；
- Requirement ID 发生变更时，旧 MatchReport 在 APP 侧标记过期；
- 删除与更新冲突时默认保留云端墓碑，并提示用户另存。

### Notes

笔记使用独立记录，新增通常无冲突；同一笔记编辑仍使用版本号。

## 8. 状态流转命令

投递状态不能通过通用 PATCH 任意改写：

```http
POST /v1/product/applications/{id}/transitions
```

请求包含：

- `toStatus`
- `expectedVersion`
- `occurredAt`
- `reason`
- `operationId`

服务端在事务内：

1. 锁定当前 Application；
2. 校验用户权属；
3. 校验当前状态和目标状态；
4. 更新 Application；
5. 创建 status event；
6. 创建 sync change；
7. 保存 operation 幂等结果。

## 9. 删除与回收

- APP 删除先产生本地 tombstone 和 Outbox；
- 服务端确认后返回新的 entityVersion；
- 其他设备通过 Pull 收到 delete；
- 墓碑保留时间需覆盖最大离线周期；
- 可选 Resume 派生文件对象延迟清理；
- 恢复归档不是删除恢复，使用普通状态更新；
- 账号注销使用单独 job 处理所有用户数据。

## 10. 重试策略

- 网络错误和 5xx：指数退避并加随机抖动；
- 401：尝试刷新会话一次；
- 409：停止自动重试，进入冲突；
- 422：停止重试，展示字段错误；
- 429：遵守 `Retry-After`；
- 相同 `operationId` 永不生成第二次业务写入。

## 11. Resume 与现有本地草稿接线

`ResumeDraftCloudLink` 保留：

```ts
interface ResumeDraftCloudLink {
  resumeId: string
  contentHash: string
  syncedAt: string
  syncedRevision: number
}
```

建议新增 `entityVersion`，但不删除现有字段：

```ts
entityVersion: number
```

流程：

- Cloud-only Resume：下载后创建本地 ResumeDraft；
- Local-only Draft：用户确认保存后创建 Cloud Resume；
- Local changes：生成 Replace Outbox；
- Cloud changes：更新本地投影，由用户选择是否重建工作头；
- Conflict：沿用现有三路冲突 UI。

## 12. 验收场景

- 离线创建投递记录，联网后只创建一次；
- Push 成功但响应丢失，重试返回 `already_applied`；
- 两台设备同时编辑 Resume，后写设备收到冲突；
- 一台设备删除 JD，另一台离线后恢复能收到墓碑；
- 500 条增量变更分页拉取不丢失、不重复；
- APP 在应用一页 Pull 时崩溃，重启后可安全重放；
- 过期 cursor 只重建同步投影，不删除对话和 checkpoint；
- 投递非法状态跳转被服务端拒绝。
