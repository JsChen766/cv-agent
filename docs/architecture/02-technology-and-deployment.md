# 技术栈与部署架构

> 状态：Draft v0.1  
> 日期：2026-07-26

## 1. 技术栈

| 层级 | 选型 | 说明 |
| --- | --- | --- |
| 语言 | Go 最新稳定版 | 编译部署简单、并发能力强、运行资源可控 |
| HTTP | `net/http` + `chi` | 轻量、透明、避免重框架侵入 |
| 数据库驱动 | `pgx` | PostgreSQL 原生能力和高性能访问 |
| 查询代码 | `sqlc` | 从审核过的 SQL 生成类型安全 Go 代码 |
| 数据库 | PostgreSQL | 事务、JSONB、索引和成熟运维生态 |
| Migration | Goose 或 Atlas | 版本化、可审查、可回滚的 schema 变更 |
| 缓存 | Redis | 验证码、限流；业务缓存按压测结果引入 |
| 文件 | 可选 S3 兼容对象存储 | 只用于 Resume 派生文件，OSS/COS 通过 Adapter 接入 |
| API 契约 | REST + OpenAPI 3.1 | 适配 Electron，便于生成客户端和契约测试 |
| 日志 | Go `slog` JSON | 结构化、可脱敏 |
| 观测 | OpenTelemetry | Metrics、Trace、Log correlation |
| 构建 | Docker multi-stage | 可移植、最小运行镜像 |

### Phase 0 锁定版本（2026-07-26）

| 组件 | 版本 |
| --- | --- |
| Go | 1.26.5 |
| PostgreSQL | 18.4 (`bookworm`) |
| Redis | 8.0.6 (`alpine`) |
| Air | 1.65.1 |
| Goose | 3.27.3 |
| Mailpit | 1.30.5 |

本地开发、测试、Migration 和构建均通过 Docker 执行；宿主机不安装 Go 工具链。
版本在 Dockerfile、Compose 和 `go.mod` 中显式锁定，不使用 `latest`。

## 2. 架构形态

采用模块化单体：

```text
cmd/api
  └─ HTTP Server

internal/
  ├─ identity/
  ├─ entitlement/
  ├─ profile/
  ├─ experience/
  ├─ jd/
  ├─ resume/
  ├─ application/
  ├─ sync/
  └─ platform/
```

每个业务模块内部保持：

```text
domain → application service → repository port → PostgreSQL adapter
                              → HTTP handler
```

约束：

- Handler 不写 SQL；
- Repository 不承载业务状态机；
- 领域模块之间通过明确 Service/Port 调用；
- 不建立跨模块随意访问表的“万能 Repository”；
- 不为未来假设提前拆微服务。

## 3. 生产部署拓扑

```text
Desktop APP
    │ HTTPS
    ▼
DNS / WAF / Load Balancer
    │
    ├──────────────┐
    ▼              ▼
Go API A        Go API B
    │              │
    └──────┬───────┘
           ▼
    PostgreSQL 主库
       ├─ Redis
       └─ OSS/COS
```

### API 服务器

- 两个无状态实例起步；
- Docker 部署；
- 健康检查分为 liveness 和 readiness；
- 优雅关闭，停止接收新请求后等待在途事务；
- 通过负载均衡横向扩容；
- 不在容器本地磁盘保存业务文件。

### PostgreSQL

- 优先使用托管 PostgreSQL；
- 与 API 使用同地域私有网络；
- 自动备份和时间点恢复；
- 生产、预发布、开发环境完全隔离；
- 连接池总量按数据库上限反推；
- 首版不使用读写分离，出现真实读瓶颈后再增加只读副本。

### Redis

首版只用于：

- 邮箱验证码 TTL；
- 登录、验证码和敏感接口限流；
- 短期幂等/防重辅助；
- 可选的撤销状态热点缓存。

Redis 不作为业务唯一存储，故障时不能丢失用户固定资产。

### 对象存储

- APP Material 不上传对象存储；
- 首版对象存储只服务于用户明确上传的 Resume PDF 等派生文件；
- 服务端生成短期签名上传/下载 URL；
- APP 不持有云厂商永久密钥；
- 上传完成后服务端校验 size、MIME 和 SHA-256；
- 对象 key 不包含邮箱、姓名等隐私信息；
- 删除先标记，延迟物理清理。

## 4. 环境划分

| 环境 | 用途 | 数据 |
| --- | --- | --- |
| local | 本地开发 | 可随时重建 |
| test | 自动化测试 | 每次测试隔离 |
| staging | APP 联调和预发布 | 仅测试数据 |
| production | 中国大陆正式用户 | 生产数据 |

生产配置必须满足：

- 禁止开发密码登录；
- 禁止数据库开发免认证；
- 禁止调试错误栈返回客户端；
- 禁止复用 staging 密钥；
- Migration 使用独立发布步骤，不由所有 API 实例并发执行。

## 5. 开发密码登录

为了提升开发效率，可以保留密码登录，但必须是编译和运行时双重受限能力：

- 仅 `APP_ENV=local|test` 可启用；
- 必须显式设置 `ENABLE_DEV_PASSWORD_LOGIN=true`；
- 生产启动时发现该配置必须直接失败；
- 开发密码只保存 Argon2id 哈希；
- 仅在 local/test 注册与现有 APP 兼容的 `/v1/auth/login` 密码处理逻辑；
- OpenAPI 生产文档不包含此 endpoint；
- CI 增加生产配置不可启用的测试；
- 开发账号不能进入生产数据库。

正式登录只使用邮箱验证码；验证成功后签发与现有 APP 兼容的 opaque Session Token。

## 6. 不采用的首版方案

### 不使用 Kubernetes

当前业务是一个 CRUD 模块化单体。Kubernetes 会提前引入集群、Ingress、证书、网络策略、
升级和监控复杂度，不能直接提高数据库性能。

### 不使用微服务

账号、Experience、JD、Resume 和 Application 存在事务与同步关系。首版拆微服务会增加：

- 分布式事务；
- 跨服务一致性；
- API 编排；
- 调试与部署成本。

如果未来某个模块出现独立扩缩容或团队边界，再通过现有模块接口拆分。

### 不使用重 ORM

核心列表、同步和状态流转查询需要明确索引和执行计划。使用 `sqlc` 保留 SQL 可控性，
避免隐式 N+1 和不可预测查询。

## 7. 仓库建议结构

```text
cv-agent-app-be/
├── cmd/
│   ├── api/
│   └── migrate/
├── internal/
├── migrations/
├── api/openapi/
├── docs/
├── deployments/
├── test/
├── Dockerfile
├── compose.yaml
├── go.mod
└── Makefile
```

首轮编码前只建立必要目录，不创建没有业务内容的占位包。
