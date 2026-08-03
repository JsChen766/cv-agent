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

### Phase 0 CI 与单机生产自动部署完成记录（2026-08-02）

- 远程 `main` push 先在 GitHub-hosted runner 执行 Docker-only `make check` 与 `make test -race`；
  只有质量门禁通过才进入 `production` Environment，部署任务串行且不取消正在执行的生产发布。
- GitHub Actions 使用专用最小权限 SSH key 调用服务器固定部署脚本，只传递本次 `GITHUB_SHA`；服务器
  再次确认该提交仍为 `origin/main`，拒绝任意 SHA、脏工作树和并发部署。
- 服务器保留原 `/home/ubuntu/cv-agent-app-be/.env.prod` 与全部 Docker volume；自动部署顺序固定为
  fetch → 精确 checkout → Compose config → build → 向前 migration → up → 本机 readiness。失败不执行
  `migrate down`，避免自动破坏生产数据。
- GitHub 与服务器 Secrets、主机指纹和现场健康验证必须在首次 workflow 实跑后补充真实结果；在该证据
  写回前，本记录只表示 CI/部署配置已建立，不提前宣称灾备或 Phase 6 完成。
- 首次生产 workflow `#1`（run `30754169801`）真实触发后，`quality` 在容器内执行 `go build` 时因
  GitHub Runner 挂载工作区的 Git ownership 校验失败；`deploy` 被依赖门禁正确阻断，生产服务器未更新。
  dev 镜像随后显式信任固定挂载目录 `/workspace`，本地重建镜像后重新通过 `make check` 与 `make test`；
  该失败及门禁行为均已保留为真实验收证据。
- 修复后的生产 workflow `#2`（run `30754486528`）已完整通过：`quality` 中 `make check` 与 race tests
  成功，随后 `deploy` 完成 Secrets 校验、专用 SSH 部署、公开 readiness 和临时 Runner key 清理。
  服务器最终精确运行提交 `5d071b004a2ef0f3e9695c8c1419e02332d11981`，API 容器已重建，PostgreSQL、
  Redis 保持健康，migration `00001`–`00009` 均为已应用，`https://hkapi.coolto.com.cn/health/ready`
  返回 `ready`。至此本节 CI 与单机生产自动部署验收通过；这不扩大为其他 Phase 或灾备能力完成。

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

Brevo OTP 配置准备（2026-07-27）：

- `.env.example` 与本地忽略的 `.env` 已加入 `EMAIL_PROVIDER`、Brevo API 地址、API Key、
  Template ID、Sender 和可选 Reply-To；密钥占位为空，不进入 Git；
- Compose 已显式透传这些变量，local 默认仍为 `mailpit`，填写 Brevo 参数并切换 provider
  前不会影响现有开发栈；`docker compose config --quiet` 已通过；
- 本记录只代表配置骨架就绪，OTP challenge/verify、Brevo Adapter 和 Redis 限流仍未实现。

未完成 / 未验证：

- 正式 OTP 邮箱验证码 challenge/verify 与 Redis 限流；
- Repository 层单元测试（仍依赖 Docker smoke 验证 SQL）；
- CI 流水线；
- Sync Pull/Bootstrap 与 APP LocalSyncStore 接线。

下一切片建议：Phase 1 收尾 OTP + Redis 限流；或提升优先级，先做 Phase 2
Pull/Bootstrap，让 APP 能开始消费已写入的 `sync_changes`。

### Phase 1 纵向切片 4：Mailpit OTP + Redis 限流（2026-07-27）

状态：🟢 Phase 1 功能门槛已完成；生产 Brevo Sender Adapter 仍待上线前切换。

已完成：

- 实现 `POST /v1/auth/email/challenges` 与 `POST /v1/auth/email/verify`；6 位数字码
  10 分钟有效、最多错误 5 次、60 秒后可重发；正确验证码在 PostgreSQL 行锁事务中
  原子消费，不存在邮箱时同时创建 User、已验证主邮箱和空 Profile；
- OTP 只以 HMAC-SHA256 保存，哈希密钥由 `OTP_HASH_KEY` 提供；请求 IP 与设备指纹同样
  只保留 HMAC，不把邮箱/IP/验证码写入 Redis key 或日志；
- Redis Lua 脚本原子检查并递增多维 fixed-window 计数：15 分钟内邮箱 5、设备 10、
  IP 20；校验按 challenge/device/IP 各 10，数据库仍以 maxAttempts=5 作为最终防爆破门；
- Mailpit SMTP Adapter 只负责发送，challenge 先以 pending 提交，发送成功后标 sent，
  失败标 failed；只有 sent challenge 可校验；
- OTP 成功后复用现有 Device、opaque Session、默认 Subscription 与 Entitlement；响应
  返回 user/device/entitlements 并设置 `HttpOnly + SameSite=Lax` Cookie；仅 production
  设置 Secure，本地 `APP_ENV=dev` 可直接联调；
- Compose 已加入 OTP 参数、Sender、Mailpit 依赖；开发密码登录继续由
  `ENABLE_DEV_PASSWORD_LOGIN=true` 保留，production 配置仍禁止开启；
- Identity 继续按 application/postgres/email/redis/httpapi 拆分；OTP Handler 与配置加载
  分文件，所有新增业务文件低于 220 行，未形成上帝类。

验证证据：

- 真实 Mailpit smoke：challenge 返回 202，Mailpit 收到验证码，verify 返回 200；首次邮箱
  自动创建账号、设备、development Subscription，响应含完整 Entitlement 与 Session；
- 立即重发同邮箱返回 `429 auth_rate_limited` 与 `Retry-After: 60`；
- APP `CooltoApiClient` 真实完成 request → Mailpit 取码 → verify → current user →
  Sync Bootstrap；
- `make check` 与 `make test -race` 通过；OpenAPI lint、gofmt、vet、build、行数和 Compose
  校验全绿。

上线前剩余：实现并启用 Brevo `EmailSender` Adapter，验证已认证发件域名与 API Key；
不改 challenge、限流、账号、Session 或 APP 契约。

## Phase 2：同步内核

状态：🟡 参考纵向切片已完成；通用内核可用，业务实体门槛随 Phase 3–5 验收。

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

### Phase 2 纵向切片 1：Profile 参考链路与 APP 同步内核（2026-07-27）

已完成：

- 后端建立 HMAC-SHA256 签名、用户绑定、180 天有效期的 Pull/Bootstrap cursor；
- Bootstrap 捕获用户 `sync_changes` 高水位，按 Projector 和实体 ID keyset 分页，
  最后一页直接签发 Pull cursor；
- Pull 按 `change_seq` 读取 `limit + 1`，页内折叠同实体变化，按业务模块批量 hydrate，
  不由 Sync 模块读取业务表；
- Push 按 operation 开独立事务，以用户 + `operationId` 事务级 advisory lock
  串行化重放；Profile 更新、change 和幂等结果原子提交；
- Profile 模块提供独立 Projector 与 CommandHandler，HTTP、同步编排、业务规则和 SQL
  未堆入单一类型；`GET /users/me` 返回当前 Session 的 `deviceId`；
- APP 建立持久设备 ID、SQLite `LocalSyncStore`、本地 Outbox、冲突/失败表、
  Bootstrap/Pull 原子页写入、单 Worker 锁、Push-first 循环及指数退避；
- payload 使用 AES-256-GCM，随机数据密钥只以 Electron `safeStorage` 包装后落盘；
  系统安全存储不可用时 fail closed；
- Profile 作为首个端到端协议参考；业务 Store 尚未切换到 LocalSyncStore，
  通用 `enqueue` 入口留给 Phase 3–5 的业务 Adapter。

验证证据：

- 后端 `make fmt && make test && make check`：race tests、OpenAPI lint、gofmt、
  vet、build、行数检查和 Compose config 全部通过；
- Docker 联调验证 Bootstrap → Pull、缺 cursor 的 409、直接 Profile PUT 后 Pull、
  Push applied、响应丢失后的 `already_applied`、幂等键复用冲突和陈旧版本冲突；
- APP `npm run check`：181 个既有测试、Node/Vue 类型检查、Node build 和
  Electron production build 全部通过；
- SQLite/AES 内存 smoke 验证稳定 operation 去重、Push 结果回写、远端页覆盖和
  cursor 同事务提交；
- 所有新增业务文件均低于 250 行；最大文件为职责单一的
  `local-outbox-store.ts`，未引入 Sync 上帝类。

尚未完成 / 不在本切片冒充完成：

- Experience/JD 的离线创建“只同步一次”、业务 CRUD 接线与双设备冲突属于 Phase 3；
- Resume tombstone 和三路冲突属于 Phase 4，Application 状态机/删除传播属于 Phase 5；
- 500 条/页真实多实体数据压测尚未执行；
- Electron `safeStorage` 已通过类型和 production build，但尚未做打包应用内真实钥匙串 smoke；
- cursor/change 和幂等记录的到期清理 job、生产密钥轮换与监控留待商业化阶段。

因此 Phase 2 不标记整体完成；当前结果是后续业务模块必须复用的同步内核与 Profile
参考实现，不应复制另一套同步事务或本地存储。

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

### Phase 3 交付记录（2026-07-27）

状态：🟢 Experience 与 JD 的 CRUD、revision、requirements 和同步接线端到端通过；
沿用 Phase 2 同步内核与 Profile 参考模式，未复制第二套同步事务。

已完成：

- 新增 `internal/platform/pagination`：签名无关的 keyset 游标（`updated_at DESC, id DESC`），
  Experience/JD 列表复用，对客户端不透明。
- 新增 `internal/modules/experience`（domain/application/postgres/httpapi/syncadapter/module）：
  - Content 只落在不可变 `experience_revisions`；创建时插入首个 revision 并原子
    切换 `current_revision_id`（借助 deferred FK：先插 revision 再 UPDATE 指针）；
  - 更新时仅当 content hash 变化才追加新 revision 并推进 revision_number，
    纯元数据更新不产生 revision；`GET /revisions` 按 revision_number 倒序 keyset 分页；
  - `PUT` 强制 `expectedVersion` 乐观锁，行未更新即 `409 entity_version_conflict`；
  - `DELETE` 走 `expectedVersion` 软删（tombstone），保留墓碑至账号清除；
  - 请求兼容现有 APP：创建/更新体 `start_date`/`end_date` snake_case，
    响应 camelCase，保留 `factBankStatus: not_applicable` 兼容字段。
- 新增 `internal/modules/jd`（同结构）：
  - `PUT` 原子全量替换聚合与 requirements；客户端提供的 requirement ID 被保留，
    缺失的用 UUIDv7 生成，`sort_order` 按数组顺序重排（requirement ID 稳定）；
  - importance/category 双轨：DB 存 canonical（`must_have` 等），响应回写
    `v2Importance`/`v2Category`，并映射 legacy `importance`（high/medium/low）兼容 APP；
    创建请求优先取 `v2_importance`/`v2_category`，回落 legacy；
  - `raw_text` 变化时重算 `jd_hash`，供 APP 判断旧匹配报告过期；
  - `expectedVersion` 乐观锁与软删同 Experience。
- 同步接线：两模块各提供 `Projector`（Hydrate + Bootstrap，含 tombstone 投影）
  与 `CommandHandler`（create/update/delete，均在 Sync Push 的事务内执行
  `*InTx` 用例）；通过模块内 `recorderAdapter` 桥接 `sync.TxRecorder`，
  业务 Service 不感知 sync 线格式；`cmd/api/main.go` 注册 HTTP 路由、
  三个 Projector 和三个 CommandHandler，未新增全路由上帝文件。

事务 / 同步不变量落地：

- 每个写入用例在单事务内完成聚合写 +（revision/requirements）+ `sync_changes` 追加；
- Experience revision 切换与聚合更新同事务，避免出现指向不存在 revision 的中间态；
- JD requirements 全量 DELETE + 重插在同事务内完成，deferred `UNIQUE(jd_id, sort_order)`
  容忍事务内顺序 churn；
- Push 复用用户 + `operationId` advisory lock 串行化重放；`already_applied` 幂等、
  相同 key 不同 payload 返回 `idempotency_key_reused`；
- 所有 SQL 显式带 `user_id`，复合 `UNIQUE(user_id, id)` 与复合 FK 防跨用户越权。

验证证据：

- `make check`：contract-lint（OpenAPI recommended 通过）+ gofmt + vet + build +
  行数检查（无 >220 行文件）+ compose config 全部通过；
- `make test`：新增 `experience/domain` 与 `jd/domain` 校验测试（rune 计数、
  枚举、必填、weight 边界、乐观锁版本）全部通过，既有测试保持通过；
- Docker 端到端 smoke（`compose up` + `migrate-up`（version 6）+ dev seed）：
  - Experience：创建带首 revision；改 content v1→v2 追加 revision（revs=2）；
    纯元数据 v2→v3 不新增 revision；陈旧 `expectedVersion` 返回 `409`；
    `/revisions` 返回 2 条；`DELETE` 返回 tombstone 且后续 `GET` 返回 `404`；
  - JD：创建带 requirement；`PUT` 保留传入 requirement ID（`019fa2ce…` 不变）、
    为新 requirement 生成 ID、重算 jd_hash；陈旧版本 `409`；`DELETE` tombstone；
  - Sync：Bootstrap 返回 user_profile/experience/JD 投影；Pull 增量拿到 Push 写入的
    Experience；Push create `applied`、重放 `already_applied`（离线只创建一次）；
    stale 版本 Push 返回 `conflict/entity_version_conflict`（双设备冲突可复现）；
    JD Push create `applied`、tombstone 传播；
  - 跨用户：dev 登录仅支持种子账号，越权路径经 `WHERE user_id` + 复合 FK 阻断。

新增/修改文件行数：最大业务文件
`experience/httpapi/handler.go` ≈ 200 行、`jd/httpapi/handler.go` ≈ 210 行，
均 <220 目标；无上帝类、无 `models.go`/`routes.go` 聚合文件。

未完成 / 未验证：

- 500 条/页多实体真实数据的同步分页压测（属 Phase 2 遗留压测项，未在本阶段执行）；
- Repository 层单元测试（SQL 仍靠 Docker smoke 验证，与既有模块一致）；
- APP 端 Experience/JD 编辑、删除调用面及统一冲突 UI；现有创建/查询调用面已完成接线；
- OTP、CI 等 Phase 1/其他阶段遗留项不在本阶段范围。

### Phase 3 APP S1/S2 质检修复（2026-07-28）

- 新增 `00008_experience_date_precision.sql`，Experience 起止日期由 PostgreSQL `date`
  改为受约束文本，完整保留 App 的 `YYYY-MM`、`YYYY-MM-DD` 与结束日期 `present`；
  Domain 同时校验真实日历日期及起止区间语义。
- App 的 Experience/JD create 接入持久化幂等身份：同一 `idempotencyKey` 与相同请求
  复用 entity/operation ID，同键不同请求在本地拒绝；JD requirement ID 不因重试漂移。
- JD legacy category 在 Push 前统一归一到后端 canonical 枚举；未知值回落 `other`。
- App 创建提示改为“本地已保存、等待同步”，projection 暴露同步状态，避免把 Outbox
  入队误报为云端成功。
- 验证：后端 `make fmt && make test && make check` 通过；App `npm run check` 通过
  （196 tests）；空库从 `00001` 到 `00008` 迁移通过；真实 Docker Push/Bootstrap
  保留 `2022-01` 到 `present`，JD `skill` 归一为 `technology`，重放返回
  `already_applied`。临时测试业务资产已软删除。
- 边界：当前 App 没有 Experience/JD 编辑/删除 executor 或 UI，因此本次只确认现有
  创建/查询调用面；完整 update/delete、墓碑和冲突界面不得冒充完成。

### Phase 3 APP E1 Experience Store / IPC 收口（2026-07-29）

- OpenAPI 和同步设计先行冻结 Experience 完整更新契约：Direct `PUT` 与 Sync update
  必须提交全部当前字段，遗漏字段在反序列化阶段拒绝，显式 `null` 表示清空；创建和正文更新
  可携带客户端生成的稳定 `revisionId`，纯元数据更新保持当前 revision。
- Experience Application/Repository/SyncAdapter 已按完整状态更新；版本冲突返回最新聚合或
  tombstone projection。列表默认只查 active，关键词覆盖标题、组织、角色、地点、标签和当前
  revision 正文，统一 Unicode NFKC/trim/lowercase，多标签使用标准化完整匹配 AND。
- App 本地同步将 `failed` 与 `conflict` 分离，并为每个实体加密保存最后服务端 payload、
  operation 与错误码；新增接受服务端、基于最新版本重新应用、另存为新经历三类 Proposal，
  服务端墓碑不允许一键覆盖。Renderer 只通过 IPC/Preload 准备并执行 Proposal，不构造 Outbox。
- Match 与 Resume 共用 Experience 证据资格：仅 active 且 clean/pending 可产生新证据；
  archived/conflict/failed/deleted 均阻断。Match 写入前复核 revision ID 与正文 hash。
- 验证：后端 `make fmt && make test`、`make check` 全绿；App `npm run check` 全绿
  （257 tests，含 250 行门禁、两套类型检查、Node/Electron build）。真实 Docker API +
  PostgreSQL 验证完整 PUT、遗漏字段拒绝、显式 null、元数据不增 revision、指定 revision ID、
  正文/标签搜索、active/archived 过滤和软删 tombstone；临时业务资产已软删除。
- E1 没有实现或修改经历仓库 UI；页面布局、状态表达和响应式方案仍由 E2 在用户确认后实现。

### Phase 3 APP E3 Experience 维护与冲突恢复收口（2026-07-29）

- APP 已按用户确认方案完成 Experience 新建、编辑、归档、恢复、软删除、不可变 revision 和
  未保存保护；所有写入继续经过不可变 Proposal、LocalSyncStore/Outbox 与乐观锁，Renderer
  不绕过同步链路。
- 真实 Electron + Docker 双 Worker 冲突验收发现：`sync_operations` 的幂等重放只恢复状态、
  版本和错误码，没有恢复首次结果中的 `serverEntity`。冲突操作在响应丢失或并发重放后会返回
  `appliedVersion != null` 但实体为空，APP 因而把仍存在的服务端 Experience 误判为墓碑。
- 同步设计已明确同一 `operationId` 必须重放首次结果的完整恢复语义。PostgreSQL Adapter 现在把
  `serverEntity` 与错误码一同保存在既有 `result_metadata` JSONB，并在 replay 时恢复；无 API 字段、
  OpenAPI shape 或 migration 变化。新增纯回归测试覆盖 conflict replay 保留服务端快照。
- Backend Docker `make fmt`、`make test`（`-race`）和 `make check` 全绿；OpenAPI lint、
  gofmt、vet、build、行数门禁及 Compose 校验通过。修复后真实双 Worker 同 operation 重放仍显示
  正确服务端正文，APP 完成对照、编辑锁定、重新应用本地修改并同步收敛；临时资产已软删除。

### Phase 3 APP E5 Experience 版本历史分页收口（2026-07-29）

- `/v1/product/experiences/{id}/revisions` 的响应 shape、cursor 编码和数据库结构保持不变；本轮没有
  migration。Application Service 不再用 `FindDetail` 加载聚合及完整历史做归属检查，改用 Repository
  的轻量 `EXISTS`，查询同时带 `user_id`、Experience ID 与 `deleted_at IS NULL`，不存在、已删除和
  跨用户资源继续统一返回 `experience_not_found`。
- revision 查询改为请求 `limit + 1`，HTTP DTO 最多返回用户请求的 `limit` 条，并且只有 lookahead
  行真实存在时才返回最后一条可见 revision 的 `nextCursor`；正好整页的最终页不再产生虚假下一页。
- 新增确定性回归测试覆盖不存在/跨用户归属拒绝后不查询 revision、Service 将 limit 扩为 lookahead、
  DTO 截断与正好整页无 cursor。Backend Docker `make test`（含 `-race`）和 `make check` 全绿，
  OpenAPI lint、gofmt、vet、build、业务文件行数与 Compose 校验全部通过。
- 真实 Electron + Docker 使用同一 QA Experience 验证 10+2、恢复后 10+3 分页、离线分页失败保留
  已加载首屏以及恢复/离线 pending 同步；最终 QA Experience 已通过正式 Proposal 软删除，PostgreSQL
  按精确 ID 确认墓碑。API 恢复为验收前停止状态。本轮未 commit、未 push。

### Phase 3 APP E6 Experience 统一验收收口（2026-07-29）

- 按正式单用户 200 条 Experience 上限执行容量验收。40 轮真实 Docker API 测量中，列表 p95
  4.92ms、500 changes 后 Pull p95 32.37ms、Bootstrap p95 33.63ms；Electron 200 项首次可用
  92ms，IPC 列表 p95 8.3ms，本地筛选 p95 26.5ms。
- 正好 200 条且请求 `limit=200` 时发现列表错误返回 `nextCursor`；HTTP handler 现使用
  `limit + 1` lookahead 并只在实际存在额外记录时生成游标，DTO 投影拆入职责单一的 pagination
  文件。测试覆盖正好整页和额外一条两种边界，未修改 OpenAPI、数据库或同步 shape。
- 专用双账号验证列表、精确 Experience、revision 与更新均严格按用户隔离；恶意 HTML/脚本只在
  APP 中按文本呈现，非法 Renderer IPC 被 Main 拒绝且未写入。Backend `make test`（`-race`）与
  `make check` 全绿；210 条 QA Experience 与 2 个 QA JD 已通过正式接口软删除并确认普通列表归零。
- 跨仓库唯一 Roadmap 已将 E6 标为完成；下一阶段为 APP S4。Interview、Note、Reminder 和本地通知
  未在本轮提前实现或验收。

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

### Phase 4 交付记录（2026-07-27）

状态：🟢 Cloud Resume 单文档发布/替换、metadata PATCH、archive/软删 tombstone 与
同步接线端到端通过；沿用 Phase 2 同步内核与 Experience/JD 分层模式，未复制第二套同步事务。

设计决策（用户确认）：

- Direct Publish 使用 body 内稳定 `idempotencyKey` + `http_idempotency_records`；Sync
  仍使用稳定 `operationId` 和客户端 UUIDv7 entity ID；
- Replace 至少使用稳定 `expectedContentHash`，能持久化云端版本的客户端可叠加
  `expectedEntityVersion`；`content_hash` 由 `structured` 派生（`json.Compact` + SHA-256）；
- `structured` 及伴随 JSONB 字段（score/evidenceSummary/riskSummary/missingInfo/
  qualityIssues）保持 APP 内部 snake_case 不转换，外层字段 camelCase。

已完成：

- 新增 `internal/modules/resume`（domain/application/postgres/httpapi/syncadapter/module）：
  - `POST /v1/product/resumes/publish` 创建、`PUT /{id}/publish` 原子全量替换聚合；
    create 与 replace 语义分离，Create 不覆盖既有 ID、Replace 不创建缺失 ID，
    `created` 标志区分结果；
  - `PATCH /{id}` 仅更新 metadata（title/status/targetRole/targetCompany/jdId），
    `expectedVersion` 乐观锁；`DELETE /{id}` 走 `expectedVersion` 软删（tombstone）；
  - `content_hash` 由 `structured` 派生，replace 使用稳定 content hash 和可选 entity version
    校验，冲突返回对应 `409`；
  - `pageUsageRatio` 由请求 `observation`（used/available height）派生。
- 同步接线：`Projector`（Hydrate + Bootstrap，含 tombstone 投影）与
  `CommandHandler`（create/update/delete 均在 Sync Push 事务内执行 `*InTx` 用例），
  经 `recorderAdapter` 桥接 `sync.TxRecorder`；`cmd/api/main.go` 注册路由、
  Projector 与 CommandHandler。
- OpenAPI `resume-publication.yaml` 补充 `status`/`qualityStatus`/`qualityIssues`。

修复记录：

- PUT replace 500（`invalid input syntax for type uuid: ""`）：`LoadForUpdate`
  返回聚合的 `UserID` 未被填充，replace 用例写入时 user_id 传入空串。
  已在 `PublishInTx` replace 分支显式回填 `existing.UserID = userID` 修复。

验证证据：

- `make check`：contract-lint（OpenAPI recommended 通过）+ gofmt + vet + build +
  行数检查（无 >220 行文件；`handler.go` 曾 240 行已拆为 `handler.go` +
  `handler_write.go`）+ compose config 全部通过；
- `make test`：新增 `resume/domain` 校验测试全部通过，既有测试保持通过；
- Docker 端到端 smoke（`compose up` + `migrate-up` version 6 + dev seed）10/10 通过：
  publish new（created=true, v=1, pageUsageRatio=0.9）、get、list、replace（v=2,
  created=false）、stale 版本 replace→`409 entity_version_conflict`、错误 hash→
  `409 content_hash_conflict`、patch rename（v=3）、patch archive（v=4）、patch stale
  →`409`、非法 status→`422`；
- 同步 smoke 7/7 通过：Bootstrap 含 resume 投影、Push create `applied`、重放
  `already_applied`（离线只创建一次）、stale update→`conflict`、Pull 增量拿到 Push
  写入的 resume、Push delete→tombstone、Pull 传播 tombstone；
- 跨用户隔离：对他人 resume 的 GET/PATCH/DELETE 均返回 `resume_not_found`，
  列表不泄漏，目标行未被改动。

未完成 / 未验证：

- 500 条/页多实体真实数据的同步分页压测（Phase 2 遗留压测项）；
- Repository 层单元测试（SQL 仍靠 Docker smoke 验证，与既有模块一致）；
- APP 端 LocalSyncStore 将 Resume Store 切换到同步链路的联调；
- Resume PDF 派生文件对象存储引用（对象存储上传能力属后续阶段）。

### Phase 4 APP LocalSyncStore 接线（2026-07-27）

- 新增桌面端 `ResumeSyncStore`：已发布 Resume 的 list/get/publish/replace/rename/archive
  统一读取本地加密 SQLite projection；写入先原子进入 `sync_entities + local_outbox`，
  再立即触发 Sync Push；网络不可用时保留 pending，版本冲突进入 conflict，不静默覆盖；
- `ResumeDraft` 继续保留在独立本地加密文件；发布/覆盖后按 candidateId 写回
  `ResumeDraftCloudLink`（resumeId、contentHash、syncedRevision、entityVersion）；
- Agent 保存审批、Resume 读取工具、PDF 云端来源解析和简历仓库均改用同一
  `ResumeSyncStore`；原 Direct API 保留为兼容 Adapter，但不再是桌面 Resume 业务读源；
- Remote Bootstrap/Pull projection 与 Outbox 本地预测 payload 分离，避免把仅供 UI 的
  contentHash/timestamp 误发给严格的同步命令；多次本地写仍按实体顺序更新 expectedVersion；
- 真实联调由 App Store 生成 Resume create Outbox，后端 Sync Push 返回
  `applied/entityVersion=1`；Direct GET 读回标题一致，服务端 contentHash 与本地预测一致；
- App `npm run check` 通过（181/181），Electron 冷启动通过；旧的无 deviceId Session
  会被静默清理，不会提前访问未启动的同步 Store。

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

### Phase 5 交付记录（2026-07-27）

状态：🟡 Application 主记录的 APP Tracker/J3 闭环已完成；真实性能指标、Tracker 子实体和
本地通知闭环仍未完成。
Application Tracker 五个同步实体（application、application_status_event、
interview_round、application_note、reminder）的 Go 实现端到端通过；CRUD、状态机、
状态事件、看板查询、Interview/Note/Reminder 及同步接线均验证。沿用 Phase 2 同步内核与
Experience/JD/Resume 分层模式，未复制第二套同步事务。DB schema（`00004`/`00005`）与
OpenAPI 契约 Phase 0 已就绪，本阶段只做实现。

设计决策（用户确认）：

- 模块包名 `tracker`，内部分层 domain/application/postgres/httpapi/syncadapter；
- Direct CRUD Create 使用必填 `Idempotency-Key` 与 `http_idempotency_records`；Sync Create
  继续使用稳定 `operationId` 和客户端 UUIDv7 entity ID；
- 一次性交付全部五个实体；
- 创建 Application 不写初始 status_event，看板直接读 `applications.status`；
  transition 用 `operationId` 同时作为 `application_status_events.operation_id` 与 event id；
- 通用 PUT 不改 status，状态变更只能通过 `POST /{id}/transitions` 或同步
  `action:"transition"`；
- Reminder 采用顶层路由 `/product/reminders`，`applicationId` 从 body 取；其余子实体挂
  `/product/applications/{applicationId}/...`。

已完成：

- 新增 `internal/modules/tracker`（domain/application/postgres/httpapi/syncadapter/
  module/recorder_adapter）：
  - `GET/POST /v1/product/applications`、`GET/PUT/DELETE /{id}`、
    `POST /{id}/transitions`、`GET /{id}/status-events`；
  - `GET/POST /{id}/interviews`、`GET/PUT/DELETE /{id}/interviews/{interviewId}`；
    notes 同构；`GET/POST /v1/product/reminders` 与 `GET/PUT/DELETE /{reminderId}`；
  - 状态机 `CanTransition`（applied→screening/rejected/no_response、screening→
    interviewing/…、interviewing→interviewing/offer/…；offer/rejected/no_response 终态），
    非法边返回 `422 illegal_transition`；
  - transition 在单事务内原子写 `applications.status`+`entity_version`、追加不可变
    `application_status_events`、并记录 application 与 status_event 两条 `sync_changes`；
  - 所有写入走 `expectedVersion` 乐观锁与 `deleted_at` tombstone 软删；列表 keyset
    分页（applications/interviews/notes/reminders 用 updated_at DESC,id DESC；
    status_events 用 occurred_at DESC,id DESC）。
- 同步接线：5 个 `Projector`（含 tombstone 投影；status_event 为 projection-only、
  `entity_version=1`、无 tombstone、无 CommandHandler）+ 4 个 `CommandHandler`
  （application 含 create/update/transition/delete，其余 create/update/delete），
  均在 Sync Push 事务内执行 `*InTx` 用例；`recorderAdapter` 按 EntityType 绑定桥接
  `sync.TxRecorder`；`cmd/api/main.go` 追加注册路由、5 Projector 与 4 CommandHandler。

验证证据：

- `make check`：contract-lint（OpenAPI recommended 通过）+ gofmt + vet + build +
  行数检查（无 >250 行业务文件）+ compose config 全部通过；
- `make test`：新增 `tracker/domain` 状态机/终态/校验测试通过，既有测试保持通过；
- Docker 端到端 smoke（既有 `compose up` + migration version 6 + dev seed）通过：
  create application（status=applied,v=1）、list、transition applied→screening（v=2，
  写入 1 条 status_event）、status-events 列表、非法 applied→offer→`illegal_transition`、
  create interview/note/reminder（各 v=1）、list reminders；
- 同步 smoke 通过：Bootstrap 覆盖全部五个 tracker entityType（application/
  application_status_event/interview_round/application_note/reminder）；Push
  `action:"transition"` screening→interviewing（applied,v=3，原子追加第二条
  status_event）；同 `operationId` 重放→`already_applied` 且不产生重复 status_event。

### Phase 3–5 联调收口（2026-07-27）

后端已补齐并通过 Docker smoke：

- Experience、JD、Resume、Application、Interview、Note、Reminder 的 Direct Create 统一
  使用事务内 HTTP 幂等记录；同 key 同请求回放原资源，同 key 不同请求返回 409；
- transition 对同一 `operationId` 做事务级串行化和语义回放，非法 UUID 返回 422；
- Application 显式换绑 JD/Resume 时刷新标题快照，源资产后续改名不追写快照；
- 删除 Application 会在同事务软删除 Interview/Note/Reminder 并写各自 tombstone；
  Status Event 保留审计但在父记录删除后不再通过普通查询/Bootstrap 展示；
- Note/Reminder 关联 Interview 时校验同用户、同 Application；嵌套 GET/PUT/DELETE 严格
  校验父路径；migration `00007` 增加复合外键和匹配当前列表 SQL 的索引；
- Application dedupe 和 Resume create ID 冲突映射为稳定 409，不再泄漏为 500；
- Resume 空质量分响应规范化为五项零分，满足现有 APP Normalizer/OpenAPI；Create 与
  Replace 已禁止互相降级。

APP 仅调整现有调用面：Experience/JD Create 已发送幂等键；Experience/JD/Resume 接收
`entityVersion/deletedAt`；Resume metadata PATCH 携带当前 `expectedVersion`。未新增当前
不存在的 Tracker Adapter/UI，后续 Tracker App 联调仍保留在本 Phase 遗留项。

真实跨仓库联调已使用 APP `CooltoApiClient` 连接 `127.0.0.1:8080` Docker API，完成开发登录、
Experience/JD 创建与读取、Resume 发布/列表/重命名/归档；返回版本分别为 1/1/3，Resume
可在列表命中。联调资产随后通过各资源软删除接口清理。

验证证据：migration version 7 已实际执行；Docker smoke 覆盖 Direct Create 回放/复用冲突、
transition 回放、错误父路径、跨 Application Interview 关联拒绝和父删除传播；`make check`
通过（JD handler 224 行仅超过 220 目标、低于 250 硬上限）。

### Phase 5 / APP J3 联调记录（2026-07-29）

- migration `00009_application_resume_content_hash_snapshot.sql` 将可空
  `resume_content_hash_snapshot` 接入 Application；历史记录保持 `NULL`，新投递冻结实际提交
  Resume 的 SHA-256 `contentHash`。
- OpenAPI、HTTP request/DTO、domain validation、Application service、PostgreSQL repository、
  Sync payload/command 已统一携带该字段。普通 PUT 保留现有指纹；只有显式更换 `resumeId` 时才要求
  新指纹，并与 Resume 标题快照一起刷新。
- APP 已通过不可变 Proposal、二次确认、LocalSyncStore/Outbox 和乐观锁完成 JD/Resume 预填投递、
  软重复提示、精确 Tracker 过滤、双向资产定位及原记录显式纠正；不新增关系表或第二套投递状态。
- 真实 Electron 创建记录后，后端 PostgreSQL 核对 `jd_id`、`resume_id`、标题、内容指纹及
  `entity_version` 一致；随后通过 UI 纠正 Resume 并改回，两次均刷新为目标 Resume 的真实指纹。
  验收记录已软删除清理，migration 状态为 version 9。
- 质检通过：`make check`、`make test`（`-race`）、OpenAPI recommended lint、跨仓库 17 项来源
  SHA-256 校验；JD handler 224 行仍是既有目标提示，低于 250 行硬上限。

### Phase 5 / APP S4 Tracker 闭环联调记录（2026-07-30）

- APP 已完成 Interview、Note、Reminder 独立 Local-first Store、严格 Mapper、Proposal/IPC 与
  “概览 / 日程 / 记录”详情交互；真实 Docker 链路覆盖子实体创建、离线重放、双设备 Note 冲突、
  status event、父 Application 删除级联 tombstone，以及 JD/Resume 不级联删除。
- 真实联调发现旧 Pull cursor 遇到已软删除 Application 的历史 status event 时，
  `HydrateStatusEvents` 因要求父记录 active 而遗漏 projection，令整页返回 `internal_error`。
  hydration 现只按不可变 event 自身 `user_id` 做所有权约束，允许读取已软删除父记录的历史事件；
  active-only Bootstrap 和业务读取语义未改变，旧 cursor 已实际恢复并追到最新 event。
- QA Application、1 场 Interview、2 条 Note、2 个 Reminder 已通过正式删除链软删除；数据库确认
  子实体 tombstone 全部存在且关联 JD/Resume 仍 active。`make test`（含 `-race`）与 `make check`
  全绿，OpenAPI、gofmt、vet、build、行数和 Compose 门禁通过。
- S4 尚未最终完成：未打包 Electron 在当前 macOS 上创建系统通知时返回 `UNErrorDomain 1`，APP 未将
  失败展示伪写为 delivered。需在允许通知的已打包/签名应用身份下补一次真实 show/去重验收；S5
  未开始。

未完成 / 未验证：

- 500 条/页多实体真实数据的看板与同步分页性能压测（Phase 2 遗留压测项，Phase 5
  完成门槛「看板列表满足性能目标」尚未用真实指标验证）；
- Repository 层单元测试（SQL 仍靠 Docker smoke 验证，与既有模块一致）；
- 已打包/签名 APP 身份下的本地系统通知 show 与同设备防重复实测；后端只存提醒状态，不执行通知。

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

## S4.5 Section C：可扩展经历与技能事实模型（2026-08-03）

- migration `00011_experience_resume_sections.sql` 已在本机 Docker PostgreSQL 实际应用：为 Experience 增加
  可空的 `resume_section_key`、`resume_section_label`，并以数据库约束保证字段成对、key 小写 kebab-case、label
  非空且最长 120 字符，以及只有既有 `other` category 能使用开放 section。历史五类 category 和历史 `other`
  的空字段保持兼容，不回写、不制造正文 revision。
- OpenAPI、HTTP DTO/mapper、domain validation、PostgreSQL repository、sync command/payload/projector 一致传递
  该元数据；服务端拒绝缺失配对、非法 key 或核心 category 的自定义 section。开放 key 不由服务端 central switch
  枚举，允许后续合法未知类型；`skills` 只是 App 侧的显式事实 section key，服务端不从 JD 或 tag 生成内容。
- 验证通过：`make fmt && make test && make migrate-up && make migrate-status`、`make check` 和 Docker API 重建均通过；
  仅有未触及的既有 224/222 行目标提示，未超过 250 行硬上限。使用 `http://127.0.0.1:8080` 完成同步创建
  `research-papers` section、bootstrap 回读以及 expected-version 软删除的闭环，未回退线上，测试资产已清理。
- 本记录只完成 S4.5 Section C 的后端契约与本地联调；Section D–H 未开始。

## N0 基线冻结（2026-07-28）

跨仓库互相兼容的可追溯组合已记录（用户授权后 commit）：

- **Backend commit**：`52edd98`（Experience date-precision baseline，migration 00008）
- **App commit**：`283d486`（S1/S2 Experience & JD sync-store baseline）
- **Migration version**：00008（00001–00008 全部 applied）
- **Contract snapshot**：`contracts/app-v1/source-manifest.json` 17 个源文件 SHA-256 通过
  `make contract-source-check`
- **验证证据**：Backend `make check` + `make test`（-race）全绿；App `npm run check` 全绿
  （196 tests）；行数最大 `jd/httpapi/handler.go` 224 行（<250 硬上限）
- App 侧完整记录见
  `../cv-agent-app/local-docs/p0-product-completion-roadmap/README.md` 的
  「N0 冻结联调基线完成记录」。下一步进入 N1 真实 App 验收。

## 全路线约束

- 跨仓库后续顺序以 `../cv-agent-app/local-docs/p0-product-completion-roadmap/README.md`
  的“后续执行 Roadmap（2026-07-28）”为统一入口：N0 基线冻结 → N1 真实 App 验收 →
  S3 Tracker 基础 → S4 Tracker 闭环 → S5 联调性能 → R1 上线准备；
- 不引入 Agent、LLM 或 LangGraph；
- 不建立云端 Resume 版本历史；
- 不覆盖现有本地 Conversation/ResumeDraft；
- 不使用客户端时间解决冲突；
- 不把业务文件写入 API 服务器本地磁盘；
- 不在没有压测证据时引入微服务、Kubernetes 或复杂缓存；
- 每阶段更新本文状态和真实验收结果；
- 除非明确要求，不提交或推送 Git。
