# PostgreSQL Schema v1 审阅索引

> 状态：Approved Design v1.0  
> 日期：2026-07-26  
> 实现：`migrations/00002`–`00008`，本地 Docker PostgreSQL 已升级至 version 8

## 1. 范围

Schema 服务于四个核心业务：

1. Experience Bank；
2. JD Library；
3. Resume Library；
4. Application Tracker。

另外只建立不可缺少的 Identity、Subscription、Device、Sync 和幂等支撑表。Agent、LLM、
Conversation、Proposal、Resume checkpoint、原始文件和浏览器数据不进入数据库。

详细定义：

- [Identity 与 Subscription](01-identity-entitlement.md)
- [Experience、JD、Resume](02-core-assets.md)
- [Application Tracker](03-application-tracker.md)
- [Sync 与幂等](04-sync-reliability.md)

## 2. PostgreSQL 约定

- PostgreSQL 18；
- 所有 ID 使用 APP 可离线生成的 UUIDv7，数据库类型为 `uuid`；
- 时间使用 `timestamptz`，由服务端生成并统一为 UTC；
- 枚举首版使用 `text + CHECK`，避免 PostgreSQL enum 的升级成本；
- 金额只使用最小货币单位 `bigint`，本版没有价格字段；
- hash 使用 64 字符小写十六进制 `text`；
- 同步实体使用 `entity_version bigint` 乐观锁；
- 删除使用 `deleted_at` 墓碑，不把归档等同于删除；
- 业务查询必须同时带 `user_id`；
- JSONB 只保存不用于常规筛选的结构化文档。

## 3. 同步实体公共列

以下实体使用同一组公共列：

```text
id                       uuid primary key
user_id                  uuid not null
entity_version           bigint not null default 1
created_at               timestamptz not null
updated_at               timestamptz not null
deleted_at               timestamptz null
last_modified_device_id  uuid null
```

适用表：

- `user_profiles`
- `experiences`
- `job_descriptions`
- `resumes`
- `applications`
- `interview_rounds`
- `application_notes`
- `reminders`

规则：

- `entity_version >= 1`；
- 有效更新执行 `entity_version = entity_version + 1`；
- Update/Delete 使用 `WHERE user_id = ? AND id = ? AND entity_version = ?`；
- `created_at` 不修改；
- `updated_at` 使用服务端事务时间；
- 删除也递增版本并写 `sync_changes`；
- v1 墓碑保留到账号物理清除，不做日常物理回收。

## 4. 聚合与同步单元

| 聚合 | 根表 | 子表 | Sync payload |
| --- | --- | --- | --- |
| Profile | `user_profiles` | 无 | 完整 Profile |
| Experience | `experiences` | `experience_revisions` | Experience + current revision content |
| JD | `job_descriptions` | `jd_requirements` | JD + 全量 requirements |
| Resume | `resumes` | 无 | 当前完整 Resume |
| Application | `applications` | 状态事件/面试/笔记/提醒 | 根实体与子实体分别同步 |

`jd_requirements` 不作为独立同步实体。APP 更新 JD 时提交完整 requirements 集合，服务端在一个
事务中校验稳定 ID、更新子表、递增 JD 版本并只写一条 JD `sync_changes`。

`experience_revisions` 是不可变历史。同步 Experience 时至少返回 current revision；历史列表由
独立 API 按需读取，不进入每次 Pull。

`application_status_events` 是追加历史，每次 transition 与 Application 新版本在同一事务写入。

## 5. 用户所有权

每个用户业务表除主键外都建立 `UNIQUE (user_id, id)`。跨业务引用使用复合外键：

```text
(user_id, jd_id)       -> job_descriptions(user_id, id)
(user_id, resume_id)   -> resumes(user_id, id)
(user_id, application_id) -> applications(user_id, id)
```

这样即使 Service 漏掉一次检查，数据库也拒绝把 A 用户的实体关联到 B 用户。

## 6. 删除与引用

- Experience、JD、Resume、Application 的普通删除只写 `deleted_at`；
- JD/Resume 删除后 Application 保留公司、岗位、JD 和 Resume 标题快照；
- 软删除 JD/Resume 不清空 Application 的关联 ID，详情层根据墓碑决定是否可跳转；
- 用户账号物理清除时通过 `ON DELETE CASCADE` 删除其全部数据；
- Application 状态事件属于审计历史，不提供普通删除；
- 归档通过 `status` 表达，可恢复，不产生 tombstone。

## 7. v1 明确不建的表

- Agent thread/checkpoint/message；
- MatchReport、Proposal 和生成运行记录；
- Resume version/revision；
- FactBank、embedding 和向量表；
- uploaded files、Material 元数据和对象存储；
- 支付供应商 event；
- 通用 audit log。

已确认 v1 不建立 Material 云端元数据表，本地附件关联继续由 APP 管理；未来确有跨设备材料
目录需求时作为独立能力增加，不影响四大核心。

## 8. 已确认结论

已确认：

- v1 不建立 Material 云端表；
- Experience revision 只存 APP 已使用的 `content`；
- JD requirements 作为 JD 聚合全量原子更新；
- Resume 遵循 APP 既有云端单文档模型；
- Application 在用户确认投递完成后创建，不增加 `draft`；
- `offer/rejected/no_response` 为终态；
- Resume 云端只保存当前文档，本地 checkpoint 负责版本历史；
- v1 完整软删除行保留到账号物理清除，不另建最小 Tombstone 表；
- Subscription 只保留套餐、权益和当前订阅。
