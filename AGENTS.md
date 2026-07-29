# AGENTS.md

本文件是 `cv-agent-app-be` 的 Agent 协作和工程约定。开始任何工作前必须完整阅读。

## 1. 工作原则

1. **不确定必追问**：任何不确定点、值得讨论的设计或取舍，必须先向用户确认，不擅自假设。
2. **阶段完成写回 roadmap**：每完成一个 Phase 或 Phase 内 section，必须更新
   `docs/roadmap/README.md`，记录真实结果、验证证据、失败和遗留项。
3. **不擅自增加阶段**：只使用现有 Design Baseline 和 Phase 0–6。新增或重排 Phase 必须先确认。
4. **文件规模**：新业务文件目标不超过 220 行，250 行为硬上限；接近上限时先按职责拆分。
5. **禁止上帝类**：不得让一个文件或类型同时承担 HTTP、业务规则、事务、SQL、序列化和外部调用。
6. **提交约束**：除非用户明确要求，否则不 commit、不 push、不创建 PR。
7. **保护用户改动**：不覆盖、不格式化、不删除与当前任务无关的已有改动。
8. **先业务边界后实现**：共享 API、数据库 schema 或同步语义变化，先更新业务设计和 OpenAPI
   再写实现；旧 fixtures 只作迁移参考。
9. **默认角色是审核与指导**：除非用户明确要求实现，本项目后续默认只做设计审核、代码审查、
   风险识别、验收和开发指导，不主动代替开发者编写业务功能。

生成代码、数据库 migration 和大型测试 fixture 可超过 250 行，但必须：

- 由工具生成或具有不可拆分理由；
- 不混入手写业务逻辑；
- 在同目录 README 或 roadmap 中记录例外；
- 生成文件禁止手工修改。

## 2. 文档阅读路由

开始任何任务都必须先读：

1. 本文件 `AGENTS.md`；
2. [`docs/README.md`](docs/README.md)，确认设计索引和已确认决策；
3. [`docs/roadmap/README.md`](docs/roadmap/README.md)，确认当前 Phase、完成状态和遗留项。

跨仓库产品开发顺序以 `../cv-agent-app/local-docs/p0-product-completion-roadmap/README.md`
为唯一入口。当前 J0–J3、E0–E3 已完成，下一阶段为 APP 侧 E4；后端 Experience 的完整更新、
稳定 revision、搜索与冲突 baseline 契约已经收口；E3 质检补齐了 Sync 幂等重放的完整
`serverEntity` 快照语义，防止普通版本冲突被误判为服务端删除；Phase 5 的 Application 主记录及
`resumeContentHashSnapshot` 契约也已接通，但 Interview、Note、Reminder 与本地通知仍按后续
S4/S5 推进，不得提前混入其他阶段。

根据任务类型继续阅读：

| 文档 | 内容 | 必须阅读的场景 |
| --- | --- | --- |
| `docs/architecture/01-scope-and-boundaries.md` | 后端职责、本地/云端边界、删除语义 | 新模块、数据归属、文件上传、是否应放后端 |
| `docs/architecture/02-technology-and-deployment.md` | Go 技术栈、模块化单体、Docker 和部署 | 工程初始化、依赖、容器、部署、环境配置 |
| `docs/architecture/03-database-design.md` 与 `docs/database/README.md` | ER、字段、索引和事务 | Migration、Repository、SQL、数据模型评审 |
| `docs/architecture/04-sync-design.md` | Push/Pull、cursor、Outbox、墓碑和冲突 | 任何同步、本地缓存、离线、多设备功能 |
| `docs/architecture/05-auth-subscription-and-api.md` | OTP、开发登录、权益、API 和状态机 | Auth、Session、Subscription、endpoint 设计 |
| `docs/architecture/06-performance-security-and-testing.md` | 容量、延迟、安全、压测和最小验收 | 性能、安全、上线和故障分析 |
| `docs/architecture/07-app-contract-compatibility.md` | 现有 APP v1 访问与资产迁移参考 | 修改任何现有 endpoint、DTO、envelope、Cookie |
| `docs/architecture/08-business-capability-baseline.md` | 四大业务模块及 APP/后端分工 | 任何业务范围、数据模型和 Phase 设计 |
| `docs/development/` 下两份文档 | 设计原则与 Coding Agent 交接 | 任何业务实现、架构审核 |
| `docs/api/README.md` 与 `api/openapi/openapi.yaml` | API 边界与机器契约 | API、DTO、Adapter、Sync 接线 |
| `contracts/app-v1/README.md` | 当前 APP 的迁移 fixtures 与来源 hash | 兼容性、Normalizer 和 APP 联调 |

额外规则：

- 涉及多个领域时，阅读所有命中的文档，不只读其中一份；
- 文档与代码冲突时先停下，指出冲突并确认权威来源；
- 修改已确认决策时同步更新索引、相关设计文档和 roadmap；
- 不需要为无关任务通读所有实现历史，但不得跳过适用文档。

## 3. 项目边界

本仓库只承载：

- 账号、设备和会话；
- 订阅和权益；
- Profile、Experience、JD、Resume；
- Application、Interview、Note、Reminder；
- 本地与云端同步；
- 对象存储、幂等、审计和后端任务。

文件边界：v1 不建立 Material 云端表，原始文件及材料元数据留在 APP 本地。对象存储只允许
用于未来经用户明确上传的 Resume PDF 等派生文件。

本仓库禁止承载：

- Agent、LLM、Prompt 或 LangGraph；
- Chromium、简历排版或 PDF 生成；
- 浏览器 DOM 读取和自动填表；
- APP 本地对话、Proposal、Resume Workspace 或 checkpoint。

## 4. 架构边界

按模块化单体组织：

```text
HTTP Handler
  → Application Service
      → Domain
      → Repository Port
          → PostgreSQL Adapter
      → External Port
          → Redis / Email / Object Storage Adapter
```

硬性规则：

- Handler 只做 HTTP 解析、鉴权上下文、调用 Service 和响应映射；
- Domain 不依赖 HTTP、PostgreSQL、Redis、云厂商 SDK；
- Service 负责编排用例和事务边界，不拼 SQL；
- Repository 只负责持久化，不决定业务状态流转；
- Adapter 不反向依赖业务 Handler；
- 跨模块调用通过公开 Service/Port，不直接访问其他模块内部表；
- 禁止 `common`、`utils`、`manager` 演变成无边界杂物模块；
- 通用代码必须有明确稳定语义，否则留在所属领域。

## 5. 禁止上帝类

以下情况视为上帝类或上帝文件：

- 一个 Handler 同时校验领域规则并执行 SQL；
- 一个 Service 同时处理账号、订阅、Resume 和投递；
- 一个 Repository 暴露所有业务表；
- 一个 `models.go` 放置整个系统全部模型；
- 一个 `routes.go` 注册并实现全部 endpoint；
- 一个同步函数同时解析协议、解决冲突、写数据库和发送通知；
- 为减少文件数量，把 API、状态机、序列化和持久化堆在一起。

出现以下信号必须拆分：

- 文件接近 220 行且仍在增长；
- 测试需要构造大量无关依赖；
- 改一个业务规则导致多个无关模块回归；
- 类型名称只能使用 `Manager`、`Processor`、`Helper` 才能描述；
- 单个函数超过约 60 行或存在多层嵌套。

## 6. API 兼容约束

`docs/architecture/07-app-contract-compatibility.md` 是现有 APP v1 访问与资产迁移参考。

- 兼容范围只包括认证/会话传输与云端业务资产；
- LLM、Agent、Prompt、Tool、流式事件和对话契约由 APP 负责，不进入本后端 OpenAPI；
- 兼容目标是 APP 业务功能不变，不要求每个旧 JSON 字段永久冻结；
- 当前 `/v1/product/*` 优先保留，确需调整时同步修改 APP Adapter 和文档；
- Resume `structured` 内部 snake_case 不得转换；
- 现有 APP 响应字段保持 camelCase；
- 现有创建请求中的 snake_case 保持兼容；
- 已上线客户端的新字段必须向后兼容，默认可被旧客户端忽略；
- 开发阶段允许同步更新 APP Adapter、Normalizer 和类型，不复制 Agent 时代冗余；
- OpenAPI 变化必须记录 APP 影响和主流程联调结果。

正式 OTP 登录和同步是增量能力；开发密码登录必须兼容现有 APP，但生产环境绝对禁止启用。

## 7. Go 代码约定

- 使用 Go 最新稳定版并在 `go.mod` 和工具链配置锁定；
- 默认使用标准库，第三方依赖必须有明确价值；
- 所有外部 I/O 接受 `context.Context`；
- 不用 `panic` 处理普通业务错误；
- 错误保留 cause，并在 HTTP 边界映射稳定错误码；
- 时间统一使用 UTC，API 输出 RFC 3339；
- ID 使用 UUIDv7；
- 金额使用最小货币单位整数，禁止 float；
- 枚举在 Domain 定义并显式验证；
- 配置只从类型化 Config 进入业务模块；
- 日志使用结构化字段，禁止拼接敏感正文；
- 不使用全局可变状态；
- goroutine 必须有生命周期、取消和错误回收机制。

## 8. 数据库约定

- App 永远不直连 PostgreSQL；
- 每个用户资源查询必须显式带 `user_id`；
- 跨实体关联必须验证同一用户所有权；
- 所有列表使用稳定排序和游标分页；
- 所有写入使用事务、乐观锁和幂等策略；
- 外部网络调用不得放在数据库事务中；
- 状态流转的当前状态和事件记录必须原子写入；
- Migration 一经进入共享环境不得原地修改，只能新增；
- 禁止在未确认目标数据库时执行 destructive migration；
- 索引必须对应真实查询，并用执行计划验证；
- 禁止 N+1；
- JSONB 只保存结构化文档，常用筛选字段必须独立建列；
- Redis 不是业务真相源。

## 9. 同步约定

- 不用客户端时间做 last-write-wins；
- 离线写入必须与本地 Outbox 同事务；
- 重试使用稳定 `operationId`；
- 云端使用 `entityVersion`；
- 删除使用 tombstone；
- Resume 冲突只允许重读、另存、明确覆盖三条路径；
- cursor 对客户端不透明；
- Pull 成功写入本地后才能推进 cursor；
- 同步失败不得删除 APP 对话、草稿或 checkpoint。

## 10. 安全约定

- Token、验证码、密码、密钥、简历正文和邮件正文不得进入普通日志；
- 密码只允许开发环境，使用 Argon2id；
- 生产配置发现开发登录开关时必须启动失败；
- Session Token 只保存哈希；
- 对象存储使用短期签名 URL；
- APP 原始材料不得进入上传接口或对象存储；
- Renderer 不接触长期会话凭据或云厂商密钥；
- 错误响应不返回 SQL、堆栈或内部路径；
- 每个资源必须验证跨用户越权会被拒绝；
- 任何账号注销、物理删除或生产数据操作都属于 destructive action。

## 11. Docker-only 开发命令

本项目本地、CI 和生产都通过 Docker 运行后端。禁止把“本机安装 Go”作为开发前提。

```text
make config          校验 Compose
make tidy            在容器内整理并锁定 Go modules
make fmt             在容器内格式化 Go
make vet             在容器内运行 go vet
make test            可选：在容器内运行已有 Go tests
make build           构建 production target
make contract-lint   在锁定的 Redocly 容器中校验 OpenAPI 3.1
make contract-source-check  对相邻 APP 权威源文件做 SHA-256 漂移检查
make check           完整格式、vet、build、行数和 Compose 检查
make dev             前台启动 API/PostgreSQL/Redis/Mailpit，API 热重载
make up              后台启动完整开发栈
make down            停止开发栈，不删除数据卷
make migrate-status  查看 migration 状态
make migrate-up      执行 migration
make migrate-down    回退一个 migration，仅限确认后的本地/测试环境
```

约束：

- 不直接在宿主机运行 `go test`、`go build`、`goose` 或 `air`；
- Dockerfile 和 Compose 版本必须显式锁定，不使用 `latest`；
- 任何本地开发后端必须由 Compose 启动；
- `docker compose down -v` 会删除本地数据库，未经明确确认禁止执行；
- 修改依赖后必须执行 `make tidy` 和 `make check`。

## 12. 最小验收

不以测试数量或覆盖率作为开发目标，也不要求建设重型 contract test 套件。最低必须验证：

- Docker 启动、健康检查和空库 Migration；
- 四大业务 APP 主流程；
- 用户隔离、Resume 冲突、Application 状态机和幂等重试；
- 静态检查、格式检查、构建和镜像；
- 代表性数据与明确服务器规格下的性能压测。

## 13. 完成定义

只有同时满足以下条件才可宣称一个阶段完成：

- 计划内功能和失败路径均实现；
- 最小验收和相关 smoke 通过；
- 无新增业务文件超过 250 行；
- 无上帝类或跨层越权；
- API/OpenAPI 已记录且 APP 业务主流程可用；
- Migration 和回滚/恢复路径已验证；
- 性能敏感阶段有真实指标；
- `docs/roadmap/README.md` 已记录真实完成结果；
- 清楚区分已完成、未验证和后续事项。
