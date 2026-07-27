# 后端设计文档索引

> 状态：Draft v0.1  
> 日期：2026-07-26  
> 适用产品：CV Agent 桌面 APP，中国大陆首发

## 1. 设计目标

为桌面 APP 建立一套独立于现有 Agent 后端的业务后端，负责：

- 账号、设备、登录会话；
- 订阅、套餐和权益；
- Experience、JD、Resume；
- 投递追踪、面试轮次、笔记和提醒；
- 本地数据库与云端数据库的双向增量同步；
- 可选 Resume 派生文件对象存储、审计、幂等和并发冲突保护。

后端不运行 Agent、LLM、LangGraph、Chromium、简历排版或浏览器自动填写。

## 2. 已确认决策

| 决策 | 结论 |
| --- | --- |
| 首发地区 | 中国大陆 |
| 仓库 | 独立仓库 `cv-agent-app-be` |
| 服务形态 | 云端独立业务 API |
| 架构 | 高性能模块化单体，可横向扩展 |
| 主语言 | Go |
| 主数据库 | PostgreSQL |
| 本地策略 | 保留既有本地存储，新增同步域存储 |
| 同步域加密 | SQLite 元数据分层 + AES-256-GCM payload；数据密钥由 Electron `safeStorage` 包装 |
| 双向同步范围 | Experience、JD、Resume、投递和面试 |
| Material | v1 全部留在本地，不建立云端表 |
| 正式登录 | 邮箱验证码免密码登录 |
| 开发登录 | 仅开发环境允许密码登录 |
| 支付 | 暂不接支付渠道，先建立订阅与权益模型 |
| 数据迁移 | 不迁移旧账号和旧业务数据 |
| 性能基线 | 10 万注册用户、1 万 DAU、常规峰值 500 RPS |
| APP 兼容 | 保证现有 APP 业务功能不变；优先复用 v1，必要时允许同步调整 Adapter |
| LLM/Agent 契约 | APP 自行负责，不进入新后端 OpenAPI 或兼容范围 |

## 3. 文档导航

1. [范围与数据边界](architecture/01-scope-and-boundaries.md)
2. [技术栈与部署架构](architecture/02-technology-and-deployment.md)
3. [数据库设计](architecture/03-database-design.md)
   - [PostgreSQL Schema v1 已确认设计](database/README.md)
4. [本地与云端同步](architecture/04-sync-design.md)
5. [认证、订阅与 API](architecture/05-auth-subscription-and-api.md)
6. [性能、安全与测试基线](architecture/06-performance-security-and-testing.md)
7. [现有 APP 访问与资产兼容参考](architecture/07-app-contract-compatibility.md)
8. [四大业务能力基线](architecture/08-business-capability-baseline.md)
9. [OpenAPI 3.1 入口](../api/openapi/openapi.yaml)
10. [API v1 设计说明](api/README.md)
11. [APP v1 迁移参考 fixtures](../contracts/app-v1/README.md)
12. [后端工程设计原则](development/design-principles.md)
13. [Coding Agent 实施交接](development/implementation-handoff.md)
14. [实施路线](roadmap/README.md)

## 4. 上游需求来源

本设计以桌面 APP 仓库 `cv-agent-app/local-docs/` 为需求基线，重点吸收：

- Experience Bank；
- JD 导入、结构化要求与岗位匹配；
- 单文档 Cloud Resume 与本地 checkpoint；
- 简历仓库同步冲突三路处理；
- 内置浏览器投递流程中的 Delivery Intent；
- Application Tracker 状态机；
- 面试轮次、面试笔记和本地通知；
- 账号、隐私和离线能力；Material v1 明确留在本地。

实现历史文档与现行产品文档冲突时，以较新的产品完成路线和本设计中的明确决策为准。

原 `cv-agent` 后端只作为 Experience、JD、Resume 字段语义的参考。其 Application graph 是
投递材料生成流程，不是投递追踪 CRUD；Agent、RAG、线程和生成运行时均不迁移。

## 5. 设计原则

1. 本地优先：网络不可用时，APP 的业务写入仍可完成。
2. 云端可同步：需要跨设备的数据最终收敛到云端。
3. 不静默覆盖：关键业务实体使用乐观锁，不按客户端时间做最后写入获胜。
4. 数据权威明确：本地工作过程与云端固定资产分开。
5. 单体优先：首版不使用微服务或 Kubernetes。
6. 数据库优先：性能首先依靠正确的表结构、索引、事务和查询。
7. 供应商可替换：云厂商、对象存储和未来支付渠道通过 Adapter 隔离。
8. 默认安全：用户隔离、最小权限、敏感信息不进入日志。

## 6. 尚待细化

- 邮件验证码供应商及邮件送达策略；
- 最终云厂商和部署地域；
- 支付渠道、套餐定价和账单流程；
- 正式 API 的 APP Adapter 接线与主流程联调；
- 数据保留、账号注销和合规文本。

## 7. 工程协作规范

所有实现工作必须先阅读仓库根目录 [`AGENTS.md`](../AGENTS.md)。其中明确了：

- 不确定必追问；
- 每阶段写回 roadmap；
- 220 行目标、250 行硬上限；
- 禁止上帝类和跨层越权；
- APP 业务功能兼容；接口变化必须同步评估和修改 APP Adapter；
- 除非明确要求，不 commit、不 push。
