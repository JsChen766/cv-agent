# Sync 与幂等 Schema

> 状态：Approved Design v1.0

## `sync_changes`

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `change_seq` | `bigint generated always as identity` | PK，全局递增 cursor 位置 |
| `user_id` | `uuid` | FK users，CASCADE |
| `entity_type` | `text` | 允许的同步实体类型 |
| `entity_id` | `uuid` | NOT NULL |
| `entity_version` | `bigint` | NOT NULL，>= 1 |
| `operation` | `text` | `upsert/delete` |
| `changed_at` | `timestamptz` | NOT NULL |

允许的 `entity_type`：

- `user_profile`
- `experience`
- `job_description`
- `resume`
- `application`
- `application_status_event`
- `interview_round`
- `application_note`
- `reminder`

索引和约束：

- `UNIQUE (user_id, entity_type, entity_id, entity_version)`；
- `(user_id, change_seq)`，Pull 主索引；
- `(changed_at)`，后续 retention job 使用。

该表不复制业务 payload。Pull 先取一页 change keys，再按 entity type 批量 hydrate 当前实体。
同一实体一页内出现多个版本时，响应只需返回最高版本，但 `nextCursor` 必须推进到本页最大 seq。

## `sync_operations`

保存 APP Outbox 单项操作的幂等结果：

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `user_id` | `uuid` | NOT NULL |
| `operation_id` | `uuid` | APP 生成的稳定 ID |
| `device_id` | `uuid` | 同用户 Device |
| `entity_type` | `text` | NOT NULL |
| `entity_id` | `uuid` | NOT NULL |
| `action` | `text` | `create/update/delete/transition` |
| `request_hash` | `text` | 64 位 SHA-256 |
| `result_status` | `text` | `applied/conflict/validation_failed/forbidden` |
| `applied_version` | `bigint` | nullable |
| `result_metadata` | `jsonb` | NOT NULL，只存错误码或资源引用 |
| `created_at` | `timestamptz` | NOT NULL |
| `expires_at` | `timestamptz` | NOT NULL |

主键：`(user_id, operation_id)`。

同 operation ID：

- request hash 相同：直接返回原结果；
- request hash 不同：返回 idempotency conflict；
- `retryable_error` 不写最终结果，允许后续重试。

建议保留 180 天，覆盖长时间离线设备。

## `http_idempotency_records`

用于非 Sync 的 POST/PUT：

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `user_id` | `uuid` | NOT NULL |
| `scope` | `text` | 路由/业务用例标识 |
| `idempotency_key` | `text` | 最大 160 |
| `request_hash` | `text` | 64 位 SHA-256 |
| `response_status` | `smallint` | 200–599 |
| `result_metadata` | `jsonb` | NOT NULL，只存资源 ID/版本等小结果 |
| `resource_type` | `text` | nullable |
| `resource_id` | `uuid` | nullable |
| `created_at` | `timestamptz` | NOT NULL |
| `expires_at` | `timestamptz` | NOT NULL |

主键：`(user_id, scope, idempotency_key)`；索引 `(expires_at)`。

幂等表不复制完整 Resume 或其他大型响应。重试命中后按 `resource_id` 重新读取当前资源，再映射
HTTP 响应。

v1 不建立通用 Server Outbox。OTP 使用 pending → 事务外发送 → sent/failed 的显式状态；
未来出现支付 webhook、可靠异步通知等真实场景时，再按具体事件增加 Outbox。

## Retention

- 业务软删除行：v1 保留到账号物理清除；
- `sync_changes`：至少 180 天；
- 过期 cursor：要求 bootstrap，不尝试补齐过期 change log；
- `sync_operations`：180 天；
- HTTP 幂等结果：按业务 24 小时到 30 天；
- OTP challenge：过期后 30 天清理；
- Session：撤销/过期后 90 天清理；
- Application 状态事件：跟随账号生命周期保留。

清理任务必须小批量按索引执行，避免长事务和表膨胀。
