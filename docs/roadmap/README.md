# 后端实施路线

> 状态：Draft v0.1  
> 日期：2026-07-26

本路线只定义阶段和完成门槛。每个阶段开始前需要补充字段级设计和验收清单。

## Design Baseline：第一版架构文档

状态：✅ 已完成（2026-07-26），等待产品与字段级评审。

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
- 四大业务模块字段级 schema 与功能 API。

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
- Schema v1 设计审核已通过；尚未创建 Migration，`make check` 通过且未运行可选测试。

验证证据：

- `make check` 与 OpenAPI recommended lint：通过；
- `make contract-source-check`：相邻 APP 的 17 个权威源文件 SHA-256 全部匹配；
- `make migrate-up/status` 与 Compose health：通过；
- production target 镜像构建：通过，scratch 运行镜像约 3.75 MB。

尚未完成：

- Experience、JD、Resume、Application 及必要 Sync API 的正式 OpenAPI；
- 正式 Migration（Schema v1 设计审核已通过）；
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
