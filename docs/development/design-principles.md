# 后端工程设计原则

> 状态：Baseline v0.1  
> 日期：2026-07-26

本文件补充 `AGENTS.md`，解释后端实施时的具体设计取舍。

## 1. 模块化单体优先

当前领域之间存在大量事务和同步关系，先保持单体部署、模块隔离：

- 一个发布单元；
- 一个 PostgreSQL 数据库；
- 领域包相互隔离；
- 每个模块有公开应用服务；
- 通过 Port 隔离 Redis、邮件和对象存储。

只有出现独立团队、独立扩缩容、独立可靠性或合规边界时，才评估拆服务。

## 2. 单一职责

### Handler

负责：

- HTTP 参数和 body 解析；
- 读取认证上下文；
- 调用一个应用用例；
- 将结果映射到明确的 API DTO。

不负责：

- SQL；
- 状态机；
- 跨资源权限判断；
- 重试和业务事务。

### Application Service

负责：

- 用例编排；
- 权限和权益调用；
- 事务边界；
- Domain、Repository 和外部 Port 协作；
- 幂等与冲突结果。

一个 Service 对应一个聚合或紧密相关的用例集合，不能成为全系统入口。

### Domain

负责：

- 状态机；
- 不变量；
- 值对象和枚举；
- 确定性校验；
- 与基础设施无关的决策。

### Repository

负责：

- SQL 和行映射；
- 原子条件更新；
- 数据库约束错误转换；
- 批量读取和分页。

Repository 不发送邮件、不操作对象存储、不决定投递状态是否合法。

## 3. 聚合与事务

- User、Experience、JD、Resume、Application 分别是主要聚合；
- Application 状态与 StatusEvent 同事务；
- Experience current revision 与新 Revision 同事务；
- 业务行和 SyncChange 同事务；
- 只有存在真实可靠异步副作用时才增加专用 Server Outbox，不预建通用事件总线；
- v1 Material 全部留在 APP 本地；未来 Resume 派生文件上传另行评审；
- 跨聚合强一致需求必须先证明，避免扩大锁范围。

## 4. Business Flow First

- 先固化四大业务主流程、领域不变量和失败语义，再写 Handler；
- OpenAPI 记录正式功能 API，当前 APP v1 fixtures 只作迁移对照；
- Handler response 由明确 DTO 产生，不直接序列化数据库模型；
- Domain 模型、DB 模型和 API DTO 不共用一个万能 struct；
- 新增字段必须有默认语义；
- 已上线客户端的破坏性变化使用新版本；开发阶段可同步修改 APP Adapter；
- 请求和响应均设置大小限制。

## 5. 数据库优先的性能设计

- 先确定访问路径，再设计索引；
- 使用 keyset cursor；
- 热列表避免对大 JSONB 排序或过滤；
- Resume 列表只返回摘要，详情才返回 `structured`；
- 同步变更日志不复制大型 Resume 正文；
- Pull 按实体类型批量 hydrate；
- 批量写入使用批量 SQL，但保留单项结果；
- 在真实数据分布上检查执行计划；
- 不用 Redis 掩盖错误 SQL。

## 6. 并发与幂等

- `entityVersion` 是业务并发基线；
- `contentHash` 是 Resume 内容指纹，不是云端历史版本；
- `operationId` 解决客户端重试；
- `Idempotency-Key + requestHash` 防止同 key 不同 payload；
- 条件更新失败返回明确冲突；
- 网络超时后查询或重放同 operation，不盲目创建第二条；
- 不持有数据库锁等待邮件、Redis 或对象存储。

## 7. 本地优先同步

- APP 先写本地实体和 Outbox；
- 云端负责跨设备最终收敛；
- 同步协议只处理固定资产，不上传 Agent 工作过程；
- 墓碑覆盖最长离线周期；
- 过期 cursor 只重建 LocalSyncStore；
- Resume 双端修改必须人工决策；
- Application 状态变化通过命令，不允许通用 PATCH 绕过状态机。

## 8. 安全默认

- 鉴权后仍逐资源校验 owner；
- 关联 ID 不能因为格式合法就被信任；
- 验证码、登录和上传接口分别限流；
- 文件下载每次重新校验权属；
- 日志只记录必要元数据；
- 开发能力通过环境、路由和测试三层隔离；
- 管理能力不能隐藏在普通用户 API 参数中。

## 9. 可观测而不泄密

允许记录：

- request ID、route template、duration、status；
- 不可逆 user/device 标识；
- query count、冲突类型、同步批量大小；
- 对象大小、MIME 和状态。

禁止记录：

- Token、验证码和密码；
- 完整邮箱、电话和 IP；
- Experience/JD/Resume 正文；
- 文件签名 URL；
- 数据库 DSN 和密钥。

## 10. 最小验收策略

本项目不追求测试数量或覆盖率。为保证商业数据安全和可验证性能，最低保留：

- Docker 启动和健康检查；
- Migration 空库执行；
- 四大业务 APP 主流程 smoke；
- 用户隔离、Resume 冲突、Application 状态机和幂等重试；
- 代表性数据下的性能压测。

## 11. 反模式

禁止：

- `BaseRepository` 暴露任意表 CRUD；
- Controller 直接开启事务并拼 SQL；
- 所有业务错误都返回 500；
- 用时间戳覆盖版本冲突；
- 用数据库 JSONB 存所有字段以逃避 schema；
- 用缓存作为业务唯一事实；
- 为“以后可能需要”预建微服务；
- 一次重构顺带改掉无关 API；
- 通过巨大 `utils.go` 共享无关逻辑；
- 未验证关键失败路径或性能就宣称完成。
