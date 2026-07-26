# CV Agent App Backend

面向 CV Agent 桌面端的独立、高性能业务后端。

本仓库只承载账号、订阅权益、云端固定资产、双向同步和 CRUD 业务能力，不承载 Agent、
LLM、LangGraph、浏览器自动化或桌面端本地生成流程。

## 当前阶段

当前已完成架构基线与 Phase 0 工程骨架，已经确认：

- 首发市场为中国大陆；
- 后端使用独立仓库和独立部署；
- APP 保留既有本地存储；
- Experience、JD、Resume、投递和面试采用本地与云端双向同步；
- Material 原始文件与元数据全部留在 APP 本地；
- 正式产品使用邮箱验证码免密码登录；
- 开发环境保留受限的密码登录，以提高测试效率；
- 暂不绑定支付渠道，只建立订阅与权益的供应商无关模型；
- 技术方案以高性能、可横向扩展和可商业化运维为目标。

## Docker-only 本地开发

本项目不要求在宿主机安装 Go、PostgreSQL、Redis、Goose 或 Air。除 Docker/Compose 和
Make 之外，开发、测试、迁移和运行全部在容器内完成。

```bash
cp .env.example .env
make config
make tidy
make dev
```

示例配置把 PostgreSQL 映射到宿主机 `15432`，避免与相邻 APP 项目的 `5432` 冲突；
容器网络内仍使用标准 `5432`。如端口仍被占用，只修改 `.env` 中的宿主机映射。

启动后：

- API liveness：`http://127.0.0.1:8080/health/live`
- API readiness：`http://127.0.0.1:8080/health/ready`
- Mailpit：`http://127.0.0.1:8025`

常用校验：

```bash
make check
make contract-lint
make contract-source-check
make migrate-status
make migrate-up
```

`make down` 保留 PostgreSQL 和 Redis 数据卷。不要在未确认时执行 `docker compose down -v`。

## 文档

- [Agent 协作与工程规范](AGENTS.md)
- [设计文档索引](docs/README.md)
- [范围与数据边界](docs/architecture/01-scope-and-boundaries.md)
- [技术栈与部署架构](docs/architecture/02-technology-and-deployment.md)
- [数据库设计](docs/architecture/03-database-design.md)
- [本地与云端同步](docs/architecture/04-sync-design.md)
- [认证、订阅与 API](docs/architecture/05-auth-subscription-and-api.md)
- [性能、安全与最小验收基线](docs/architecture/06-performance-security-and-testing.md)
- [现有 APP 访问与资产兼容参考](docs/architecture/07-app-contract-compatibility.md)
- [四大业务能力基线](docs/architecture/08-business-capability-baseline.md)
- [OpenAPI 3.1 入口](api/openapi/openapi.yaml)
- [APP v1 迁移参考 fixtures](contracts/app-v1/README.md)
- [后端工程设计原则](docs/development/design-principles.md)
- [实施路线](docs/roadmap/README.md)

## 状态说明

工程骨架已可通过 Docker 启动和校验，但业务模块尚未实施。继续开发前仍需完成数据库字段级
评审、OpenAPI 功能评审和 APP 本地同步存储的技术验证。除非用户明确要求实现，本项目后续
由 Codex 只承担架构指导、代码审核、风险识别和验收。
