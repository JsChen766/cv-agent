# 后端实施路线

> 状态：Draft v0.1  
> 日期：2026-07-26

本路线只定义阶段和完成门槛。每个阶段开始前需要补充字段级设计和验收清单。

## Design Baseline：第一版架构文档

状态：✅ 已完成（2026-07-26），Schema 已确认，API 等待功能评审。

已完成：

- 后端与 APP 本地数据边界；
- Go、PostgreSQL、Redis、对象存储和 Docker 技术栈；
- 模块化单体与大陆云服务器部署拓扑；
- Identity、Entitlement、Experience、JD、Resume、Application 和 Sync 数据模型；
- 邮箱验证码正式登录与开发密码登录隔离；
- 本地优先双向同步、幂等、墓碑和冲突处理；
- 容量、延迟、安全、最小验收和发布门禁；
- 现有 APP 业务访问方式、核心资产语义和 Session Cookie 兼容参考；
- 后端 AGENTS.md、220/250 行限制、禁止上帝类和分层原则；
- Phase 0–6 实施顺序。

Phase 0 完成前还需确认：

- 本地 SyncStore 加密方案；
- 云厂商、地域和邮件验证码供应商；
- 功能 OpenAPI 审核结论。

### Design Baseline 补充记录（2026-07-26）

- 已从 APP 仓库迁移并适配 Agent 协作规范；
- 已新增后端工程设计原则；
- 已提取现有 APP v1 访问与资产 API，作为低成本替换参考；
- 已明确正式 OTP 和 LocalSyncStore 是 APP 增量开发，不冒充零改动能力；
- 已修正早期文档中 `/v1/resumes`、全 camelCase 和 Access/Refresh Token 等不兼容设计。
- 已确认 v1 Material 原始文件和元数据均留在本地，不建立云端表。
- 已确认 LLM/Agent 调用由 APP 负责，不进入新后端 OpenAPI、实现或兼容范围。

### Design Baseline 业务收敛记录（2026-07-26）

- 已审计原 `/Users/apple/cv-agent` 后端的 Experience、JD、Resume 和 Application；
- 已确认只参考前三者的 CRUD/数据语义，不复制 FastAPI/LangGraph 代码；
- 已确认原 Application graph 只是投递材料生成，不是 Application Tracker；
- 产品核心收敛为经历库、JD 库、简历库、投递追踪四个模块；
- 账号、订阅与同步保留为支撑能力；
- 兼容标准调整为 APP 业务功能不变，允许必要时同步修改 APP Adapter/Normalizer；
- 现有 OpenAPI 和 fixtures 降级为迁移参考，不再作为永久字段冻结门禁；
- 不建重型测试体系，仅保留启动、Migration、安全边界、冲突/状态机和性能验收。

## Phase 0：契约与工程基础

状态：🟡 进行中。

目标：

- 初始化 Go 仓库；
- 建立模块边界；
- 固化四大业务能力、数据库 schema 和功能 API；
- 建立 PostgreSQL migration；
- 建立 Docker 本地环境；
- 建立 CI、日志、配置和最小验收基础。

完成门槛：

- 空库 migration 可重复执行；
- API 健康检查可用；
- local/test/staging/production 配置隔离；
- 生产配置无法开启开发登录；
- 基础静态检查、build 和镜像构建通过。

### Phase 0 初始化记录（2026-07-26）

已完成：

- 初始化 Go 1.26.5 模块化单体骨架；
- 建立 Docker-only 开发栈：API、PostgreSQL 18.4、Redis 8.0.6、Mailpit；
- 建立 Air 热重载、Goose Migration 和 multi-stage production 镜像；
- 建立类型化配置、生产环境开发密码登录保护和测试；
- 建立 PostgreSQL/Redis 客户端、连接池和依赖就绪检查；
- 建立 `/health/live`、`/health/ready` 与当前兼容 envelope；
- 从当前 APP 提取 v1 访问与资产接口，生成模块化 OpenAPI 3.1 迁移参考；
- 建立 21 个 payload 对照样本，并记录 17 个上游源文件 SHA-256；
- 使用 Redocly 2.31.6 Docker 镜像建立 OpenAPI lint 门禁；
- 建立 JSON 日志、Request ID、超时和优雅关闭；
- 建立 Docker 内 `fmt`、`vet`、build 和 220/250 行检查；
- 规范 Git 忽略规则：跟踪 `AGENTS.md` 与 `docs/`，仅忽略本地配置、缓存和构建产物；
- 使用空库成功执行 `00001_bootstrap.sql`，Goose 状态为 version 1；
- 真实 Compose 联调下 liveness 与 readiness 均返回 200。

### Phase 0 Schema 设计记录（2026-07-26）

- 已按 Identity/Subscription、核心资产、Tracker、Sync 拆出字段、约束、外键和索引审阅稿；
- 明确 Experience revision、JD 聚合更新、Resume 单文档和 Application transition 事务；
- 经 APP/PRD 复核确认 Experience 仅存 content、JD 聚合更新、Application 无 draft、三种终态；
- 用户已确认 Resume 云端单文档、本地 checkpoint 历史，以及完整墓碑保留至账号物理清除；
- 已确认 v1 不建立 Material；支付事件和通用 Server Outbox 同样暂不建立；
- Schema v1 已实现为 `00002`–`00006`；正式 OpenAPI 已覆盖 OTP、完整 CRUD、Tracker 和 Sync。
- 已补 Coding Agent 实施交接，固化阅读顺序、代码导航、纵向交付流程和验收格式。

验证证据：

- `make check` 与 OpenAPI recommended lint：通过；
- `make contract-source-check`：相邻 APP 的 17 个权威源文件 SHA-256 全部匹配；
- `make migrate-up/status`：升级至 version 6，实建 23 表、42 外键和 5 条开发权益；
- production target 镜像构建：通过，scratch 运行镜像约 3.75 MB。

尚未完成：

- 正式 OpenAPI 的用户评审、业务实现与 APP 联调；
- CI；
- local/test/staging/production 完整部署配置；
- APP LocalSyncStore 的接线方案与首批功能联调清单。

因此 Phase 0 不标记完成。后续 Codex 默认只做审核、指导和验收，不主动实现业务模块。

## Phase 1：账号、设备与权益

范围：

- 邮箱验证码 challenge；
- 正式免密码登录；
- 开发密码登录；
- 与 APP 兼容的 opaque Session；
- 设备管理与登出；
- User Profile；
- Plan、Subscription、Entitlement；
- Redis 限流。

完成门槛：

- 验证码防爆破；
- Session 撤销、过期和设备隔离；
- 设备撤销；
- 权益查询；
- 登录主流程和跨用户隔离验收。

### Phase 1 纵向切片 1：最小认证基座（2026-07-26）

状态：🟡 部分完成，切片内 3 个用例通过端到端联调，其他 Phase 1 用例未开始。

已完成：

- `internal/platform/security`：Argon2id 密码 hash/verify 与 SHA-256 Session Token；
- `internal/platform/id`：UUIDv7 生成器；
- `internal/modules/identity`：按 `domain / application / postgres / httpapi` 分层，
  以及组装模块的 `module.go`，未出现上帝类；
- Session Issuer 生成 opaque token（`[A-Za-z0-9._~-]`），DB 只存 SHA-256 hash；
- Session middleware `RequireSession` 通过 `access_token` Cookie 恢复会话；
- Dev 密码登录：`POST /v1/auth/login`（仅 `ENABLE_DEV_PASSWORD_LOGIN=true` 时注册）；
- 当前用户：`GET /v1/users/me`；
- 会话登出：`POST /v1/auth/logout`；
- Device upsert 严格校验 `user_id` 归属，禁止跨用户复用同一 device id；
- Device/Session 复合外键 `(user_id, id)` 保护跨用户越权；
- 新增 `migrations-dev/00001_dev_account.sql`（独立 goose 表 `goose_db_version_dev`，
  只由 `make migrate-dev-up` 加载），种子账号 `dev@example.com / devpassword` 及
  绑定的 Profile、development Subscription；
- `HTTP Handler` 路由从平台层通过 `RouteRegistrar` 挂载 `/v1`，不出现上帝路由文件。

安全约束落地：

- 生产环境启动即因 `DevPasswordAuth && Environment==production` 拒绝启动（既有
  `platform/config` 门禁，未变更）；
- Cookie 在非 local/test 下 `Secure=true`，始终 `HttpOnly + SameSite=Lax`；
- 错误响应仅返回稳定错误码 `invalid_credentials / session_invalid / device_conflict`；
- Password/token/cookie 均未写入结构化日志。

验证证据：

- `make check`：contract-lint、gofmt、go vet、go build、行数检查、`compose config`
  全部通过；
- `make test`：现有 3 个包共 5 个测试通过（`-race`）；
- `make migrate-up`：主 migration 保持 version 6；
- `make migrate-dev-up`：dev seed migration 独立追踪至 version 1；
- Docker-only 端到端 smoke（`compose up -d api` 后 curl）：
  - 错误密码返回 `401 invalid_credentials`；
  - 正确密码返回 `200 + Set-Cookie: access_token=...` 并写入 `auth_sessions`；
  - `GET /v1/users/me` 使用 Cookie 返回用户；无 Cookie 返回 `401 session_invalid`；
  - `POST /v1/auth/logout` 撤销 Session 并清除 Cookie，后续请求返回 `401`；
  - 同用户重登：`devices` 记录被 upsert，`device_name/app_version` 更新；
  - 跨用户使用同一 device id：返回 `409 device_conflict`（不写入）。

新增/修改文件行数（业务代码 220/250 行限制）：

- 最大文件 `internal/modules/identity/httpapi/handlers.go` 128 行；
- 所有新业务/平台文件均 <150 行，无上帝类。

未完成 / 未验证：

- 正式 OTP 邮箱验证码 challenge/verify（`email_login_challenges`、Mailpit、Redis 限流）；
- Profile GET/PUT、Entitlement GET；
- `DELETE /v1/devices/{deviceId}/sessions` 远程撤销；
- 单元测试（依赖真实 pgxpool 的 Repository 尚未做隔离测试）；
- CI 流水线；
- APP LocalSyncStore 接线。

后续下一切片建议：Profile GET/PUT + Entitlement GET，将 Phase 1 的“权益查询”门槛
覆盖到位后再进入 OTP。

### Phase 1 纵向切片 2：Profile + Entitlement + Sync Recorder（2026-07-26）

状态：🟢 切片内 3 个用例全部通过端到端联调；Phase 1 剩余 OTP/Redis 限流/设备撤销
未开始。

已完成：

- 新增 `internal/platform/authctx`：跨模块只读 `Principal` 上下文；identity
  `RequireSession` 中间件重构后写入该上下文，`CurrentUser` 不再依赖 identity
  内部结构。
- 新增 `internal/modules/sync`：定义合法的 `EntityType` / `Operation` 枚举，
  以及 `TxRecorder` 端口与 PostgreSQL 适配器 `PgxRecorder`。业务模块通过
  接收 `TxRecorder` 完成同事务写入，`sync` 内部不感知具体业务。
- 新增 `internal/modules/entitlement`（domain/application/postgres/httpapi），
  实现 `GET /v1/users/me/entitlements`：读取当前 `trialing/active` 订阅 +
  `plan_entitlements`，`features` 通过 `feature_code` map 输出；无生效订阅
  返回 `404 no_active_subscription`（不静默返回空）。
- 新增 `internal/modules/profile`（domain/application/postgres/httpapi），
  实现 `GET/PUT /v1/users/me/profile`：
  - PUT 强制携带 `expectedVersion`，通过 `SELECT … FOR UPDATE` 锁定聚合，
    版本不匹配返回 `409 entity_version_conflict`；
  - 校验 nullable/长度/URL/数组元素约束；`preferredLanguage` 强制非空；
  - 事务内：UPDATE user_profiles → `entity_version += 1` →
    INSERT `sync_changes(user_profile, upsert)`；两条写入原子提交；
  - JSON 请求体强制 `DisallowUnknownFields`，限长 32 KiB；
  - Repository 使用 `WHERE user_id = $1 AND entity_version = $2 - 1`
    强制乐观锁，行未被更新即返回 `ErrVersionConflict`；
- `identity.Module` 暴露 `Authenticator()` 供其他模块挂载 `RequireSession`；
  `cmd/api/main.go` 用一个 `Group` 一次性挂载所有 authenticated 子路由，
  避免出现全路由 `routes.go` 上帝文件。
- `HTTP Handler` 的 `RouteRegistrar` 保持不变，模块通过 `router.Get/Put/…`
  自我注册。

同步 / 事务不变量落地：

- Profile PUT 与 `sync_changes` 写入使用同一 `pgx.Tx`；任一失败整个事务回滚；
- 事务级别 `ReadCommitted` + 显式行锁，保证同事务内可读并锁定当前 profile；
- 无网络调用（邮件、Redis、对象存储）进入该事务；
- `sync_changes.entity_version` 与 `user_profiles.entity_version` 保持一致
  （通过“先更新聚合再基于新版本追加 change 行”）；
- Change 表通过复合 `UNIQUE (user_id, entity_type, entity_id, entity_version)`
  自动防止重复追加同一版本。

安全 / 隔离约束落地：

- 所有 SQL 显式使用 `authctx.Principal.UserID`；跨用户越权路径通过
  `WHERE user_id=$1` 与 `user_profiles.UNIQUE(user_id, id)` 双重防护；
- Entitlement 只读订阅表，不接触 subscription provider metadata；
- Profile DTO 手工组装，不直接序列化 Domain 或 DB 行；
- 未在日志中记录 Profile 字段、订阅字段或 principal。

验证证据：

- `make check`：contract-lint + gofmt + vet + build + 行数（无 >220 行文件）
  + `compose config` 全部通过。
- `make test`：现有 5 个测试仍通过。
- Docker-only 端到端 smoke（`compose up -d api` 后 curl）：
  - `GET /v1/users/me/entitlements` 返回
    `{plan:"development", subscriptionStatus:"active", features:{...}, effectiveUntil:null}`；
  - 初次 `GET /users/me/profile` 返回 `entityVersion=1`；
  - `PUT` with `expectedVersion=1` 返回 `entityVersion=2` 且字段回显正确；
  - 陈旧版本再次 `PUT expectedVersion=1` 返回 `409 entity_version_conflict`；
  - `preferredLanguage=""` 返回 `422 invalid_profile`；
  - 未知字段返回 `400 bad_request`；
  - 新建用户 `bob` 登录后 `GET /users/me/profile` 只看到自己的空档案，
    未污染 dev1 的数据；
  - 数据库直接查询：`sync_changes` 出现 1 条
    `(user_profile, dev1, version=2, upsert)`；`user_profiles` 更新为
    `entity_version=2` 且新字段落库。

新增文件行数：最大 `profile/postgres/repository.go` = 101 行；所有新业务文件
远低于 220 目标；未新增 200 行以上文件；未出现 `models.go / routes.go`
类上帝文件。

未完成 / 未验证：

- 正式 OTP 邮箱验证码 challenge/verify（`email_login_challenges`、Mailpit、
  Redis 限流）；
- `DELETE /v1/devices/{deviceId}/sessions` 远程撤销；
- Repository 层的单元测试（仍靠端到端 Docker smoke 验证 SQL 正确性）；
- CI 流水线；
- Sync Push/Pull/Bootstrap（`sync_changes` 已写入，读取端属于 Phase 2）；
- APP LocalSyncStore 接线。

下一切片建议：Phase 1 收尾 OTP + Redis 限流 + `DELETE /devices/{id}/sessions`，
或直接进入 Phase 2 Pull（读取端消费本切片已写入的 `sync_changes`）。

### Phase 1 纵向切片 3：Device 兼容、远程撤销与自动 Provision（2026-07-27）

状态：🟢 切片内 4 个用例已通过端到端联调；Phase 1 仍缺 OTP 与 Redis 限流。

背景：切片 2 收尾后与 APP 联调，暴露三个阻塞项：登录必须携带 `device`（APP v1
不发送）、设备远程登出未落地、新账号首次登录缺少 `subscription` 会立即被
`no_active_subscription` 拒绝。本切片专门解决兼容与运营缺口，不引入 OTP。

已完成：

- `identity/application/device_fallback.go`：开发登录未携带 `device` 时按
  `SHA256("dev-fallback|<userID>|<UA>|<remoteIP>|<namespace>")` 合成
  UUID 格式的 legacy-client 兼容 bucket；`Platform` 通过 User-Agent 关键字识别；
  同一 UA + IP 反复登录只 upsert 单条记录。该 fallback 只服务 local/test 旧
  LoginScreen，不代表可靠的物理设备身份；正式 OTP 必须由 APP 提供持久化安装 ID。
- `identity/httpapi/handlers.go`：新增 `clientIP()`，用 `net.SplitHostPort`
  从 `RemoteAddr` 拆出宿主机 IP，避免容器网络下每次登录端口变化导致设备重复；
  不信任客户端直接提交的 `X-Forwarded-For`。
- `identity/application/session_service.go` +
  `identity/postgres/session_repo.go`：新增 `RevokeSessionsByDevice`，
  用单条 CTE SQL 校验 `Device.user_id == principal.user_id` 并执行
  `UPDATE auth_sessions SET revoked_at=now()`，跨用户设备返回
  `404 device_not_found`。
- `identity/httpapi/routes.go` + `handlers.go` + `module.go`：新增
  `DELETE /v1/devices/{deviceId}/sessions`（受 `RequireSession` 保护），
  响应 `{ deviceId, revokedSessionCount }`；OpenAPI `identity.yaml`
  同步补充 path + response schema。
- `identity/application/login_dev.go` + `entitlement/postgres/provisioner.go`：
  密码校验成功后以独立短事务确保存在当前有效 Subscription；插入使用与部分唯一索引
  匹配的 `ON CONFLICT ... DO NOTHING`，随后重新确认订阅时间窗口与 Plan 状态。
  无法建立有效订阅时登录返回 500，不签发缺少权益基础的 Session。
- `compose.yaml` + `scripts/goose_guard.sh`：迁移入口通过 guard 脚本执行，
  `migrations-dev` 仅允许在 `APP_ENV=local/test` 且数据库 host 为本机或 Compose
  PostgreSQL 时运行；普通 destructive migration 是否执行仍由 AGENTS.md 的人工授权
  约束控制。

安全 / 事务不变量落地：

- Device fallback 的哈希输入包含 `userID`，不同用户不会碰撞；同一用户多台机器在
  相同 UA/NAT 下仍可能共享 legacy bucket，因此不作为正式设备隔离依据。
- `RevokeSessionsByDevice` 使用单条 CTE SQL 原子完成设备权属判断与 Session 更新；
  不存在或跨用户设备统一返回 `404 device_not_found`。
- 自动 provisioning 使用独立事务和部分索引冲突处理；提交前确认时间窗口与 Plan
  状态，失败时保留 cause 并阻断登录，避免签发“登录成功但无权益”的 Session。
- `identity/application` 的 Session Port 使用自身 `AuthLookup` 投影，不再反向依赖
  PostgreSQL Adapter。
- Session 鉴权合并 User/Session 查询，并只在 `last_used_at` 超过 10 分钟时执行
  条件更新，普通热请求只执行一次查询。

验证证据：

- `make check`：contract-lint + gofmt + vet + build + 行数 + compose config
  全部通过。
- `make test`：`device_fallback_test.go` 覆盖 fallback、UUID、平台和 metadata
  规范化；`session_service_test.go` 覆盖热 Session 不写与过期阈值刷新；
  `login_dev_test.go` 覆盖 Repository 故障保真；`profile/domain/validate_test.go`
  覆盖中文 rune 计数、超长、必填和越界；全部通过。
- Docker 端到端 smoke（`compose up -d` 后 curl）：
  - APP 兼容登录（无 `device` 字段，Content-Type JSON）返回 200 + Cookie；
  - 同一 UA/IP 反复登录后 `SELECT count(*) FROM devices WHERE user_id=…` 保持
    单条 fallback 记录，`device_name` 落 UA、`platform` 命中 `macos`；
  - `DELETE /v1/devices/{deviceId}/sessions` 返回
    `{"deviceId":"…","revokedSessionCount":1}`，随后同 Cookie 请求
    `/v1/users/me` 返回 `401 session_invalid`；
  - `UPDATE plans SET status='inactive'` 与 `UPDATE subscriptions SET ends_at`
    过期后 `/entitlements` 返回 `no_active_subscription`；恢复后再次返回 active；
  - 新账号 `carol@example.com` 首次登录后自动写入 `subscriptions` 单条 active
    记录，重复登录不产生第二条，`/entitlements` 立即返回 development features。
  - 隔离 QA 账号 8 个并发首次登录全部返回 200，最终只有 1 条 active
    Subscription；测试账号及级联数据随后清理完成。
  - 显式传入非法 Device UUID 返回 400；不存在/跨用户 Device 撤销返回 404；
    合法设备撤销返回 200，原 Cookie 后续返回 401。

新增/修改文件行数：最大 `identity/httpapi/handlers.go` 为 166 行，
`device_fallback.go` 为 113 行；全部低于 220 行目标，无 200 行以上业务文件。

未完成 / 未验证：

- 正式 OTP 邮箱验证码 challenge/verify 与 Redis 限流；
- Repository 层单元测试（仍依赖 Docker smoke 验证 SQL）；
- CI 流水线；
- Sync Pull/Bootstrap 与 APP LocalSyncStore 接线。

下一切片建议：Phase 1 收尾 OTP + Redis 限流；或提升优先级，先做 Phase 2
Pull/Bootstrap，让 APP 能开始消费已写入的 `sync_changes`。

## Phase 2：同步内核

范围：

- UUIDv7；
- entityVersion；
- `sync_changes`；
- Push/Pull/Bootstrap；
- 幂等；
- tombstone；
- APP LocalSyncStore contract。

完成门槛：

- 离线创建后只同步一次；
- 多设备冲突可复现；
- cursor 分页不丢数据；
- 崩溃后安全重放；
- 删除传播通过；
- 500 条一页的同步压测通过。

## Phase 3：Experience 与 JD

范围：

- Experience CRUD 和 revision；
- JD CRUD 和 requirements；
- APP 本地双向同步接入。

完成门槛：

- 与 PRD 字段对齐；
- Experience revision 事实来源稳定；
- Requirement ID 稳定；
- 离线读写和双设备同步通过。

## Phase 4：Resume Library

范围：

- Cloud Resume 单文档 CRUD；
- contentHash；
- entityVersion；
- metadata PATCH；
- archive/delete tombstone；
- PDF 派生文件引用；
- 现有 ResumeDraftCloudLink 接入。

完成门槛：

- 本地 checkpoint 不上传；
- Cloud-only、Local-only、Synced、Local changes、Cloud changes、Conflict 六态通过；
- 三路冲突处理通过；
- 相同幂等请求不重复创建；
- 过期版本返回明确冲突。

## Phase 5：Application Tracker

范围：

- Application CRUD；
- 状态机；
- Delivery Intent 接入；
- 状态事件；
- 看板查询；
- Interview Round；
- Note；
- Reminder。

完成门槛：

- 非法拖拽被服务端拒绝；
- 状态事件和当前状态原子一致；
- 终态约束通过；
- 面试提醒跨设备同步、本地通知执行；
- 看板列表满足性能目标。

## Phase 6：商业化准备

范围：

- 支付 Provider Adapter 接口；
- Subscription event 幂等；
- 配额执行；
- 账号注销；
- 数据导出和清除；
- 管理与审计工具；
- 生产部署和灾备。

支付渠道和定价未确定时，本阶段只实现不会被具体渠道推翻的通用能力。

完成门槛：

- 支付事件重放不重复生效；
- Entitlement 与业务写入一致；
- 注销和数据清除可审计；
- 备份恢复演练；
- 500 RPS 基线和故障演练通过；
- staging APP 完整闭环通过。

## 全路线约束

- 不引入 Agent、LLM 或 LangGraph；
- 不建立云端 Resume 版本历史；
- 不覆盖现有本地 Conversation/ResumeDraft；
- 不使用客户端时间解决冲突；
- 不把业务文件写入 API 服务器本地磁盘；
- 不在没有压测证据时引入微服务、Kubernetes 或复杂缓存；
- 每阶段更新本文状态和真实验收结果；
- 除非明确要求，不提交或推送 Git。
