# Application Tracker Schema

> 状态：Approved Design v1.0

## `applications`

包含同步公共列及：

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `jd_id` | `uuid` | nullable，同用户 JD |
| `resume_id` | `uuid` | nullable，同用户 Resume |
| `company_name` | `text` | NOT NULL，1–240 |
| `role_name` | `text` | NOT NULL，1–240 |
| `jd_title_snapshot` | `text` | nullable |
| `resume_title_snapshot` | `text` | nullable |
| `delivery_method` | `text` | `form_fill/email_fill/manual/other` |
| `target_url` | `text` | nullable，最大 4096 |
| `applied_at` | `timestamptz` | 已投递时间 |
| `status` | `text` | `applied/screening/interviewing/offer/rejected/no_response` |
| `pending_confirmation` | `boolean` | 自动识别后等待用户确认 |
| `source` | `text` | `manual/browser/email/other` |
| `dedupe_key` | `text` | nullable，自动识别记录的 64 位 hash |
| `company_business` | `text` | nullable |
| `role_summary` | `text` | nullable |
| `company_culture` | `text` | nullable |
| `rejection_reason` | `text` | nullable |

规则：

- PRD 流程是用户手动提交/发送后，确认“记录此次投递”才创建 Application；
- v1 不增加 `draft`，尚未完成的填写过程继续只存在 APP 本地；
- 手动记录通常 `pending_confirmation=false`；
- 自动识别记录先设 true，确认操作递增版本；
- 公司、岗位和标题快照不会随 JD/Resume 更新；
- 通用 PUT/PATCH 不允许修改 `status`；
- 状态只通过 transition command 更新；
- `applied_at` 可在 pending confirmation 时为空，确认后必须存在；
- `dedupe_key` 只用于浏览器/邮件自动识别，手动重复投递合法。

数据库约束：`pending_confirmation OR applied_at IS NOT NULL`。

索引：

- `(user_id, status, applied_at DESC NULLS LAST, id DESC) WHERE deleted_at IS NULL`；
- `(user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL`；
- `(user_id, company_name, updated_at DESC) WHERE deleted_at IS NULL`；
- `(user_id, jd_id) WHERE deleted_at IS NULL`；
- `(user_id, resume_id) WHERE deleted_at IS NULL`；
- `UNIQUE (user_id, dedupe_key) WHERE deleted_at IS NULL AND dedupe_key IS NOT NULL`。

## 状态机

```text
applied      -> screening | rejected | no_response
screening    -> interviewing | rejected | no_response
interviewing -> interviewing | offer | rejected | no_response
offer        -> terminal
rejected     -> terminal
no_response  -> terminal
```

数据库 CHECK 只限制状态取值，合法边由 Domain 校验。`interviewing -> interviewing` 表示进入下一
轮，必须同时创建新的 Interview Round 或提供 reason。

## `application_status_events`

追加且不可变：

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `id` | `uuid` | PK，UUIDv7 |
| `user_id` | `uuid` | NOT NULL |
| `application_id` | `uuid` | 复合 FK Application，CASCADE |
| `from_status` | `text` | 首个事件可为空 |
| `to_status` | `text` | NOT NULL |
| `reason` | `text` | nullable |
| `occurred_at` | `timestamptz` | 用户语义时间 |
| `created_by_device_id` | `uuid` | nullable |
| `operation_id` | `uuid` | NOT NULL，幂等 |
| `created_at` | `timestamptz` | 服务端写入时间 |

约束和索引：

- `UNIQUE (user_id, operation_id)`；
- `UNIQUE (user_id, id)`；
- `(user_id, application_id, occurred_at DESC, id DESC)`。

Transition 事务顺序：条件锁定 Application → 校验边 → 更新状态/版本 → 插入 Event → 插入
SyncChange → 记录 operation result。

## `interview_rounds`

包含同步公共列及：

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `application_id` | `uuid` | 同用户 Application |
| `round_number` | `smallint` | >= 1 |
| `interview_type` | `text` | `phone/video/onsite/hr/technical/case/other` |
| `scheduled_at` | `timestamptz` | nullable，未确定时间可为空 |
| `timezone` | `text` | IANA timezone，默认 `Asia/Shanghai` |
| `duration_minutes` | `smallint` | nullable，1–1440 |
| `location_or_link` | `text` | nullable，最大 4096 |
| `interviewer` | `text` | nullable，最大 240 |
| `status` | `text` | `scheduled/completed/canceled` |

索引：

- `UNIQUE (application_id, round_number) WHERE deleted_at IS NULL`；
- `(user_id, scheduled_at) WHERE deleted_at IS NULL AND status='scheduled'`。

面试正文不塞入该表，统一使用 Note，避免 Round 变成大文本对象。

## `application_notes`

包含同步公共列及：

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `application_id` | `uuid` | 同用户 Application |
| `interview_round_id` | `uuid` | nullable，同用户 Interview |
| `note_type` | `text` | `general/interview/follow_up/company` |
| `content` | `text` | NOT NULL |

索引：`(user_id, application_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL`。

## `reminders`

包含同步公共列及：

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `application_id` | `uuid` | 同用户 Application |
| `interview_round_id` | `uuid` | nullable |
| `title` | `text` | NOT NULL，1–240 |
| `remind_at` | `timestamptz` | NOT NULL |
| `status` | `text` | `scheduled/delivered/dismissed/canceled` |
| `delivered_at` | `timestamptz` | nullable |

索引：

- `(user_id, remind_at) WHERE deleted_at IS NULL AND status='scheduled'`；
- `(user_id, application_id, remind_at DESC) WHERE deleted_at IS NULL`。

云端只同步 Reminder 状态；Electron 本地负责触发系统通知。
