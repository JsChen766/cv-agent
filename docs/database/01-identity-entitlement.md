# Identity 与 Subscription Schema

> 状态：Approved Design v1.0

## `users`

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `id` | `uuid` | PK，UUIDv7 |
| `status` | `text` | `active/suspended/pending_deletion/deleted` |
| `created_at` | `timestamptz` | NOT NULL |
| `updated_at` | `timestamptz` | NOT NULL |
| `deleted_at` | `timestamptz` | 账号物理清除前的状态时间 |

约束：`deleted_at IS NULL OR status IN ('pending_deletion','deleted')`。

## `user_emails`

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `user_id` | `uuid` | FK users，CASCADE |
| `email_normalized` | `text` | NOT NULL，小写规范化地址 |
| `email_display` | `text` | NOT NULL，展示地址 |
| `is_primary` | `boolean` | NOT NULL，默认 true |
| `verified_at` | `timestamptz` | NOT NULL |
| `created_at` | `timestamptz` | NOT NULL |

索引：

- `UNIQUE (email_normalized)`；
- `UNIQUE (user_id) WHERE is_primary`；
- `(user_id, created_at)`。

首版 UI 只有一个主邮箱，但独立表允许以后安全换绑，不把邮箱作为用户主键。

## `email_login_challenges`

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `id` | `uuid` | PK，客户端 challenge ID |
| `email_normalized` | `text` | NOT NULL |
| `purpose` | `text` | v1 仅 `login` |
| `code_hash` | `bytea` | NOT NULL，不保存验证码明文 |
| `delivery_status` | `text` | `pending/sent/failed` |
| `attempt_count` | `smallint` | NOT NULL，默认 0 |
| `max_attempts` | `smallint` | NOT NULL |
| `expires_at` | `timestamptz` | NOT NULL |
| `consumed_at` | `timestamptz` | nullable |
| `request_ip_hash` | `bytea` | nullable |
| `device_fingerprint_hash` | `bytea` | nullable |
| `created_at` | `timestamptz` | NOT NULL |

约束：

- `attempt_count BETWEEN 0 AND max_attempts`；
- `max_attempts BETWEEN 1 AND 10`；
- 只有 `delivery_status='sent'` 才允许 verify；
- verify 使用行锁，成功时原子设置 `consumed_at`。

索引：

- `(email_normalized, created_at DESC)`；
- `(expires_at) WHERE consumed_at IS NULL`。

Redis 只做发送/尝试限流，Challenge 真相保存在 PostgreSQL。请求先提交 pending challenge，再在
事务外同步调用邮件 Provider；发送成功标记 sent，失败标记 failed，避免网络调用占用数据库事务。

## `devices`

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `id` | `uuid` | PK，APP 安装实例 ID |
| `user_id` | `uuid` | FK users，CASCADE |
| `device_name` | `text` | NOT NULL，最大 120 |
| `platform` | `text` | `macos/windows/linux` |
| `app_version` | `text` | NOT NULL，最大 40 |
| `last_seen_at` | `timestamptz` | NOT NULL |
| `revoked_at` | `timestamptz` | nullable |
| `created_at` | `timestamptz` | NOT NULL |
| `updated_at` | `timestamptz` | NOT NULL |

索引：`(user_id, revoked_at, last_seen_at DESC)`。

约束：`UNIQUE (user_id, id)`，供 Session 和同步表使用复合外键。

## `auth_sessions`

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `user_id` | `uuid` | FK users，CASCADE |
| `device_id` | `uuid` | 复合 FK devices(user_id,id) |
| `token_hash` | `bytea` | NOT NULL，SHA-256 后 32 bytes |
| `expires_at` | `timestamptz` | NOT NULL |
| `last_used_at` | `timestamptz` | NOT NULL |
| `revoked_at` | `timestamptz` | nullable |
| `created_at` | `timestamptz` | NOT NULL |

索引：

- `UNIQUE (token_hash)`；
- `(user_id, revoked_at, expires_at)`；
- `(device_id, revoked_at)`。

请求只按 `token_hash` 命中 Session，再读取 user/device 状态；不在普通日志记录 token。

## `development_password_credentials`

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `user_id` | `uuid` | PK/FK users，CASCADE |
| `password_hash` | `text` | Argon2id PHC string |
| `created_at` | `timestamptz` | NOT NULL |
| `updated_at` | `timestamptz` | NOT NULL |

表可以存在于所有环境，但 production 不注册密码路由且不得写入记录。

## `user_profiles`

除同步公共列外：

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `full_name` | `text` | nullable，最大 120 |
| `phone` | `text` | nullable，最大 40 |
| `location` | `text` | nullable，最大 160 |
| `current_title` | `text` | nullable，最大 160 |
| `current_company` | `text` | nullable，最大 200 |
| `years_of_experience` | `smallint` | nullable，0–80 |
| `career_stage` | `text` | nullable，最大 40 |
| `target_roles` | `text[]` | NOT NULL，默认空数组 |
| `target_industries` | `text[]` | NOT NULL，默认空数组 |
| `target_locations` | `text[]` | NOT NULL，默认空数组 |
| `preferred_language` | `text` | NOT NULL，默认 `zh-CN` |
| `resume_style` | `text` | nullable，最大 40 |
| `linkedin_url` | `text` | nullable，最大 2048 |
| `github_url` | `text` | nullable，最大 2048 |
| `personal_website` | `text` | nullable，最大 2048 |

每个用户最多一行：`UNIQUE (user_id)` 且 `CHECK (id = user_id)`，Profile 的同步 ID 即用户 ID。

## Subscription

### `plans`

`id uuid PK`、`code text UNIQUE`、`name text`、`status active/inactive`、`version integer`、
`created_at`、`updated_at`。

### `plan_entitlements`

`plan_id uuid`、`feature_code text`、`value jsonb`、`created_at`、`updated_at`，主键为
`(plan_id, feature_code)`。首批 feature code：

- `experience.limit`
- `jd.limit`
- `resume.limit`
- `application.limit`
- `sync.enabled`

### `subscriptions`

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `user_id` | `uuid` | FK users |
| `plan_id` | `uuid` | FK plans |
| `status` | `text` | `trialing/active/canceled/expired` |
| `starts_at` | `timestamptz` | NOT NULL |
| `ends_at` | `timestamptz` | nullable |
| `created_at` | `timestamptz` | NOT NULL |
| `updated_at` | `timestamptz` | NOT NULL |

部分唯一索引：每个用户最多一个 `trialing/active` Subscription。支付接入前不存 provider 字段。
