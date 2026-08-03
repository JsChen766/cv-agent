# Experience、JD、Resume Schema

> 状态：Approved Design v1.0

以下三个根表都包含公共同步列，并建立 `UNIQUE (user_id, id)`。

## `experiences`

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `category` | `text` | `work/project/education/volunteer/other` |
| `title` | `text` | NOT NULL，1–200 |
| `organization` | `text` | nullable，最大 200 |
| `role` | `text` | nullable，最大 200 |
| `location` | `text` | nullable，最大 200 |
| `start_date` | `text` | nullable，`YYYY-MM` 或 `YYYY-MM-DD` |
| `end_date` | `text` | nullable，`YYYY-MM`、`YYYY-MM-DD` 或 `present` |
| `tags` | `text[]` | NOT NULL，默认空数组 |
| `resume_section_key` | `text` | nullable，规范化 kebab-case；仅 `other` 可设置 |
| `resume_section_label` | `text` | nullable，最大 120；与 key 成对出现 |
| `status` | `text` | `active/archived` |
| `current_revision_id` | `uuid` | 当前不可变 revision |

约束：

- 日期文本保留 APP 已确认的月份精度和“至今”语义，不擅自补日或丢弃 `present`；
- 完整日期必须是真实日历日期；月份必须在 `01`–`12`；
- 日期先后由 Domain 按区间比较：开始月份取该月第一天，结束月份取该月最后一天，
  `present` 始终视为当前仍在进行；
- 未删除 Experience 在业务层必须有 current revision；
- `current_revision_id` 使用 `(user_id,current_revision_id)` 复合外键，确保 revision 同属该用户；
- Service 还需校验 revision 的 `experience_id` 等于当前 Experience。
- `category` 继续只接受五个既有值；论文、奖项、证书、研究、社团和未来合法类型使用
  `category=other` 加 key/label，不扩展后端 category 枚举。历史 `other` 的双空字段仍合法。
- `skills` 是显式的 `other` section key；它的正文仍是不可变 revision，简历端必须为展示 bullet
  提供同一 snapshot 的 quote/offset，不得把 tags 或 raw_text 作为无证据捷径。

索引：

- `(user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL`；
- `(user_id, category, status, updated_at DESC, id DESC) WHERE deleted_at IS NULL`；
- `(user_id, status, updated_at DESC, id DESC) WHERE deleted_at IS NULL`。

单用户上限 200，v1 搜索在用户范围内扫描，不提前引入全文检索或 GIN。

## `experience_revisions`

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `id` | `uuid` | PK，UUIDv7 |
| `user_id` | `uuid` | NOT NULL |
| `experience_id` | `uuid` | 复合 FK experiences(user_id,id)，CASCADE |
| `revision_number` | `integer` | 从 1 递增 |
| `content` | `text` | NOT NULL，供现有 APP/生成链路直接读取 |
| `source` | `text` | `manual/import/app_generated` |
| `revision_hash` | `text` | 64 位小写 SHA-256 |
| `created_by_device_id` | `uuid` | nullable，复合 FK devices |
| `created_at` | `timestamptz` | NOT NULL |

当前 APP 的 `ExperienceCreateInput` 和 `ExperienceRevision` 只接受 `content`，背景、职责、成果和
技术细节均由 APP 组织在正文中；技能检索使用 Experience 根表 `tags`。v1 不建立无人读写的
`structured JSONB`。

约束和索引：

- `UNIQUE (experience_id, revision_number)`；
- `UNIQUE (user_id, id)`；
- `CHECK (revision_hash ~ '^[0-9a-f]{64}$')`；
- `(user_id, experience_id, revision_number DESC)`。

Revision 永不 UPDATE/DELETE；更新正文时在事务中插入新 revision、切换根表并写 SyncChange。

## `job_descriptions`

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `title` | `text` | NOT NULL，1–240 |
| `company` | `text` | nullable，最大 240 |
| `target_role` | `text` | nullable，最大 240 |
| `source_kind` | `text` | `manual/pasted/browser/imported` |
| `source_url` | `text` | nullable，最大 4096 |
| `raw_text` | `text` | NOT NULL |
| `jd_hash` | `text` | 64 位小写 SHA-256 |
| `requirements_origin` | `text` | `manual/app_extracted` |
| `status` | `text` | `active/archived` |

索引：

- `(user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL`；
- `(user_id, status, updated_at DESC, id DESC) WHERE deleted_at IS NULL`；
- `(user_id, company, updated_at DESC) WHERE deleted_at IS NULL`；
- `(user_id, jd_hash) WHERE deleted_at IS NULL`，非唯一，只用于提示重复。

## `jd_requirements`

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `id` | `uuid` | PK，跨普通更新保持稳定 |
| `user_id` | `uuid` | NOT NULL |
| `jd_id` | `uuid` | 复合 FK job_descriptions，CASCADE |
| `text` | `text` | NOT NULL |
| `category` | `text` | `qualification/responsibility/technology/domain/soft_skill/other` |
| `importance` | `text` | `must_have/preferred/optional` |
| `keywords` | `text[]` | NOT NULL，默认空数组 |
| `weight` | `numeric(6,5)` | nullable，0–1 |
| `sort_order` | `smallint` | NOT NULL，>= 0 |
| `created_at` | `timestamptz` | NOT NULL |
| `updated_at` | `timestamptz` | NOT NULL |

约束和索引：

- `UNIQUE (user_id, id)`；
- `UNIQUE (jd_id, sort_order) DEFERRABLE INITIALLY DEFERRED`；
- `(user_id, jd_id, sort_order)`；
- `weight IS NULL OR weight BETWEEN 0 AND 1`。

JD PUT 提交完整 requirements。服务端按 ID update/insert/delete，并只递增一次 JD version。

## `resumes`

| 列 | 类型 | 约束/含义 |
| --- | --- | --- |
| `title` | `text` | NOT NULL，1–240 |
| `target_role` | `text` | nullable，最大 240 |
| `target_company` | `text` | nullable，最大 240 |
| `jd_id` | `uuid` | nullable，复合 FK JD |
| `structured` | `jsonb` | NOT NULL，当前完整文档 |
| `content` | `text` | NOT NULL，结构化文档的确定性文本投影 |
| `content_hash` | `text` | 64 位小写 SHA-256 |
| `schema_version` | `text` | NOT NULL，最大 80 |
| `status` | `text` | `draft/active/published/archived` |
| `quality_status` | `text` | `unverified/passed/needs_revision/failed` |
| `quality_issues` | `jsonb` | NOT NULL，默认 `[]` |
| `quality_gate_version` | `text` | nullable |
| `score` | `jsonb` | NOT NULL，默认 `{}` |
| `evidence_summary` | `jsonb` | NOT NULL，默认 `[]` |
| `risk_summary` | `jsonb` | NOT NULL，默认 `[]` |
| `missing_info` | `jsonb` | NOT NULL，默认 `[]` |

约束：

- `structured/score` 必须为 object；
- issues/evidence/risk/missing 必须为 array；
- `content_hash` 格式合法；
- Replace 同时比较 `entity_version` 与 `content_hash`；
- `jd_id` 属于同一用户，JD 物理删除时只置空 `jd_id`；
- 云端不建 Resume revision/version 表。

索引：

- `(user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL`；
- `(user_id, status, updated_at DESC, id DESC) WHERE deleted_at IS NULL`；
- `(user_id, jd_id, updated_at DESC) WHERE deleted_at IS NULL`；
- `(user_id, content_hash)`，用于幂等诊断，不唯一。
