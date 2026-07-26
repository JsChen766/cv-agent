# Coding Agent 实施交接

> 状态：Implementation Baseline v1.0
> 日期：2026-07-26
> 适用对象：接手 `cv-agent-app-be` 业务实现的 Coding Agent

## 1. 当前基线

仓库当前不是空项目，也不是已完成后端：

- `ce65fad`：Docker-only 工程和设计基线；
- `5ddafb0`：Schema Migration 和正式业务 OpenAPI；
- PostgreSQL Migration 已到 version 6；
- 已有 23 张业务表、42 个外键和 development plan seed；
- 已有 API 健康检查、配置、PostgreSQL、Redis、日志和优雅关闭骨架；
- 已有 OTP、四大 CRUD、Tracker、Sync 的 OpenAPI；
- 尚未实现业务 Handler、Application Service、Domain 和 Repository；
- APP 的 LocalSyncStore、Outbox、Sync Worker 也尚未接线。

后端只实现确定性业务。Agent、LLM、Prompt、浏览器、PDF、Material 和本地 checkpoint 不得进入。

## 2. 开始任何任务前

必须依次完整阅读：

1. [`AGENTS.md`](../../AGENTS.md)；
2. [`docs/README.md`](../README.md)；
3. [`docs/roadmap/README.md`](../roadmap/README.md)；
4. 本文；
5. [`design-principles.md`](design-principles.md)；
6. 当前任务命中的架构、数据库和 OpenAPI 文档。

不得只根据任务描述直接写代码。若文档、OpenAPI、Migration 或 APP 行为冲突，先指出冲突并向
用户确认权威来源。

## 3. 按模块阅读

| 实施范围 | 必读内容 |
| --- | --- |
| 工程、配置、部署 | `architecture/02`、`architecture/06`、`compose.yaml`、`Dockerfile` |
| Identity/Entitlement | `architecture/05`、`database/01`、`components/identity.yaml` |
| Sync | `architecture/04`、`database/04`、`components/sync.yaml`、`paths/sync.yaml` |
| Experience/JD | `architecture/08`、`database/02`、对应 OpenAPI 和 APP fixtures |
| Resume | `architecture/01`、`architecture/04`、`database/02`、Resume OpenAPI |
| Application Tracker | `architecture/05` 状态机、`database/03`、Tracker OpenAPI |
| APP 兼容 | `architecture/07`、`contracts/app-v1/README.md`、相邻 APP Adapter |
| 性能或上线 | `architecture/02`、`architecture/06`、真实 query plan 和压测结果 |

文档短名均位于 `docs/architecture/` 或 `docs/database/`。

## 4. 前置代码导航

先理解现有基础设施，不重复创建另一套：

| 路径 | 用途 |
| --- | --- |
| `cmd/api/main.go` | Composition Root；只负责组装依赖和启动 |
| `internal/platform/config/config.go` | 类型化配置和生产安全门禁 |
| `internal/platform/database/postgres.go` | pgxpool 创建、关闭和 readiness |
| `internal/platform/cache/redis.go` | Redis 客户端和 readiness |
| `internal/platform/httpserver/server.go` | HTTP server、middleware 和生命周期 |
| `internal/platform/httpserver/health.go` | liveness/readiness 示例 |
| `internal/platform/httpapi/envelope.go` | 当前 success/error envelope |
| `migrations/00002`–`00006` | 已确认数据库结构，不是待生成草稿 |
| `api/openapi/openapi.yaml` | 正式 API 机器契约入口 |
| `contracts/app-v1/` | 旧 APP 迁移对照，不是永久 contract |

当前没有可复用的业务万能 Service 或 BaseRepository；不要为了“快速”新建一个。

## 5. 推荐包结构

每个领域保持独立：

```text
internal/modules/<module>/
├─ domain/       实体、值对象、状态机、领域错误
├─ application/  用例、Port、事务编排、DTO-independent result
├─ postgres/     SQL、行映射、Repository 实现
└─ httpapi/      Handler、request/response DTO、错误映射
```

首批 module：`identity`、`entitlement`、`profile`、`sync`、`experience`、`jd`、`resume`、
`application`。

- 跨模块只调用对方公开的 Application Port；
- `sync` 调用业务用例，不绕过它们直接改业务表；
- 事务抽象可以放平台层，但业务事务内容留在所属 Application Service；
- 不建立包含全系统 model 的 `models.go`、全表 Repository 或全路由 Handler；
- 公共代码只有在至少两个模块拥有完全相同且稳定的语义后才提取。

## 6. 单个功能的实施流程

1. 在 roadmap 中定位 Phase 和完成门槛；
2. 阅读该模块 Schema、OpenAPI、APP/PRD 来源；
3. 列出成功路径、失败路径、事务边界、用户隔离和查询路径；
4. 如需改契约，先更新设计文档和 OpenAPI并通过 lint；
5. 实现 Domain 不变量和稳定错误；
6. 定义 Application Port、用例和事务边界；
7. 实现带 `user_id` 的 Repository 和 keyset 查询；
8. 实现薄 Handler 与明确 API DTO；
9. 在 `cmd/api/main.go` 组装，不使用全局可变单例；
10. 运行最小 smoke、静态门禁和必要的数据库验证；
11. 更新 roadmap，写清已完成、未验证、风险和下一步。

一个任务优先完成一个纵向用例，不要一次铺开所有领域的空接口。

## 7. 写入事务模板

所有同步业务写入至少包含：

```text
鉴权用户与设备
→ 校验 Entitlement
→ 命中幂等记录或开始事务
→ 带 user_id 读取/锁定聚合
→ 校验 expectedVersion 和领域不变量
→ 写业务数据
→ 递增 entityVersion
→ 同事务写 sync_changes
→ 保存幂等结果
→ 提交后返回 API DTO
```

特殊事务：

- Experience 正文更新必须插入不可变 revision；
- JD PUT 必须原子替换完整 requirements；
- Resume Replace 同时比较 `entityVersion` 和 `contentHash`；
- Application status 与 StatusEvent 必须原子写入；
- 邮件、Redis 和对象存储网络调用不得占用数据库事务。

## 8. 数据和安全硬规则

- 所有用户资源 SQL 显式携带 `user_id`；
- 所有关联 ID 校验同一用户，不能只检查 UUID 格式；
- 所有列表使用稳定 keyset cursor，禁止深 offset 和 N+1；
- 普通 CRUD 不使用 Redis 作为真相源或默认缓存；
- Token、验证码、密码、邮箱、正文和 DSN 不进入普通日志；
- Session 只保存 token hash；开发密码只用 Argon2id；
- production 发现开发登录开关必须启动失败；
- 删除写完整 tombstone，保留到账号物理清除；
- 不使用客户端时间做 last-write-wins；
- 不修改已进入共享环境的 Migration，只追加新 Migration。

任何 `migrate-down`、账号物理清除或生产数据操作都要先获得明确授权。

## 9. APP 兼容注意点

- `/v1`、`access_token` Cookie 和 envelope 是当前迁移基线；
- Experience/JD 现有创建请求包含 snake_case；
- Resume `structured` 内部字段保持 snake_case；
- 新正式写入要求 APP 保存并回传 `entityVersion`；
- Resume Replace 需要新增 `expectedEntityVersion`；
- JD/Experience 的 Agent 时代兼容字段只能由 DTO 派生固定/null 值；
- 修改 endpoint、字段或错误码时，同步评估相邻 APP Adapter、Normalizer 和类型；
- `make contract-source-check` 只检查上游漂移，不能代替真实 APP 主流程联调。

## 10. 实施顺序

除非用户明确重排，遵循 roadmap：

1. Phase 0：补 CI、环境配置和当前模块的 OpenAPI 功能审核；
2. Phase 1：Identity、Session、Profile、Entitlement、OTP 和限流；
3. Phase 2：同步内核和 APP LocalSyncStore contract；
4. Phase 3：Experience、JD；
5. Phase 4：Resume；
6. Phase 5：Application Tracker；
7. Phase 6：商业化、部署、灾备和性能验收。

Phase 1 建议先做 Session middleware 与开发登录，再做 Profile/Entitlement，最后接 OTP 邮件和限流。

## 11. Docker-only 验证

常规前置：

```text
git status --short
make config
make migrate-status
make check
```

按变更补充：

- 修改 OpenAPI：`make contract-lint`；
- 修改现有 APP 兼容面：`make contract-source-check` + APP 主流程；
- 新增 Migration：在确认的空库/本地库执行 `make migrate-up/status`；
- 修改依赖：`make tidy` 后 `make check`；
- 已有相关测试时可运行 `make test`，不建设重型测试体系。

不得在宿主机直接运行 Go、Goose；不得未经授权执行 `down -v` 或 destructive migration。

## 12. 完成交接格式

Coding Agent 每次交付必须说明：

1. 完成了哪个 Phase/section 和哪些业务用例；
2. 修改了哪些 API、Migration、包和 APP Adapter；
3. 事务、幂等、用户隔离和冲突如何保证；
4. 实际运行了哪些命令，结果是什么；
5. 哪些内容未验证，不能用“应该可用”代替证据；
6. 性能相关查询的索引和执行计划证据；
7. roadmap 写回位置；
8. 是否存在未提交改动，且未经要求不得 commit/push。

当前明确未决项：邮件供应商、云厂商/地域、LocalSyncStore 加密、支付和定价。实现遇到这些边界时
必须停下确认，不得绑定临时供应商方案后宣称完成。
