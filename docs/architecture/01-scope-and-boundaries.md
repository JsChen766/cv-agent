# 范围与数据边界

> 状态：Draft v0.1  
> 日期：2026-07-26

## 1. 后端定位

新后端是桌面 APP 的业务数据服务，不是 Agent 后端。

它负责稳定、确定性、可审计的业务操作：

- 身份认证和设备会话；
- 订阅状态和功能权益；
- 固定资产 CRUD；
- 投递状态合法性校验；
- 本地与云端增量同步；
- 未来可选 Resume 派生文件的对象存储授权；
- 幂等、冲突检测、审计和可观测性。

它不负责：

- Agent 推理和 Prompt 编排；
- LLM 调用；
- 简历生成、语义匹配和内容改写；
- Chromium 排版和 PDF 生成；
- 浏览器 DOM 读取、自动填表和 Webmail 填写；
- 用户本地对话、Proposal、审批卡和检查点。

## 2. 数据分类

### 2.1 仅本地

以下数据不上传云端：

- Agent 对话和 Tool 过程；
- 临时 JD/Experience/Resume Proposal；
- 用户确认前的生成候选；
- Resume Workspace 和本地不可变 checkpoint；
- AI 修改的 pending change；
- SelectedFile 句柄和本地绝对路径；
- Material 原始文件、元数据、关联及其本地路径；
- 浏览器 Cookie、Session 和页面 DOM；
- 浏览器填写过程与未确认的 Fill Proposal；
- 本地 PDF 导出路径；
- 模型 API Key 和本地模型运行状态。

### 2.2 本地与云端双向同步

- User Profile 的可同步字段；
- Experience 及其当前内容；
- JD 及结构化 requirements；
- Resume 当前完整文档；
- 投递记录；
- 投递状态历史；
- 面试轮次、笔记和提醒；
- 用户级可同步设置；

### 2.3 云端权威、本地缓存

- 账号状态；
- 邮箱验证状态；
- 设备和可撤销 Session；
- 套餐、订阅状态和权益；
- 服务端幂等记录；
- 同步序列和云端变更日志；
- 安全与审计事件；
- 可选 Resume 派生文件的权属和存储位置。

## 3. APP 既有存储兼容

以下既有存储保持不变：

- `ConversationStore`：本地加密对话；
- `ResumeDraftStore`：本地加密草稿、workspace 和 checkpoint；
- `ResumeDraftCloudLink`：本地草稿与 Cloud Resume 的关联；
- Electron Keychain：登录凭据和本地密钥；
- Browser Session：招聘网站和 Webmail 登录状态。

新增一个独立 `LocalSyncStore`，只承载需要同步的领域副本：

- 本地业务实体投影；
- `local_outbox`；
- 云端同步 cursor；
- 每条记录的 `entityVersion`；
- 同步错误和重试状态；
- 删除墓碑。

`LocalSyncStore` 不取代现有对话和简历草稿文件。

## 4. 领域边界

### Identity

用户、邮箱、设备、会话、验证码和账号状态。

### Entitlement

套餐、订阅、权益和未来支付事件。业务模块只查询权益，不直接依赖支付渠道。

### Profile

用户基础资料、求职偏好和表单填写所需的个人信息。

### Experience Bank

经历条目、当前 revision、历史 revision 和标签。

### JD Library

JD 原文、公司、岗位、来源、哈希和结构化 requirements。

### Resume Library

每份 Resume 的云端当前完整文档、质量信息、目标 JD 和归档状态。

### Application Tracker

投递记录、投递状态机、状态事件、面试、笔记和提醒。

### Sync

设备增量同步、幂等、冲突、删除墓碑和服务端变更序列。

## 5. Resume 冻结语义

云端 Resume 继续采用单文档模型：

- 一份 Resume 只有一份当前 `structured`；
- `structured` 是唯一云端内容来源；
- `contentHash` 是内容指纹，不代表历史版本；
- Application 可冻结实际投递 Resume 的 `contentHash`，但不复制正文，也不形成 Resume 版本实体；
- `entityVersion` 用于并发写入保护；
- 云端不提供版本历史、回退或 diff；
- 本地 checkpoint 继续承担历史和恢复；
- checkpoint 恢复只创建新的本地工作头，不自动写云端；
- 双端同时修改时必须展示冲突处理，不静默覆盖。

## 6. 写入与用户确认边界

Agent 产生的内容必须遵循：

```text
本地生成候选
→ 本地 Proposal
→ 用户确认
→ APP 写本地同步实体和 Outbox
→ 云端 CRUD API
→ 服务端返回当前实体和新版本
→ APP 更新本地投影
```

后端不理解 Agent 的推理过程，只验证确定性的业务 contract。

## 7. 文件边界

- Material 原始文件、元数据和业务关联均不上传云端；
- 文档解析继续在 APP 本地执行；
- 材料入库与关联继续由 APP 本地管理；
- APP 本地存储设备文件引用，云端 API 不接收材料数据或本地路径；
- Resume PDF 默认本地生成，可选择作为派生文件上传；
- 数据库不保存 Material 或文件二进制；未来可选 Resume 派生文件另行评审。

## 8. 删除语义

- 同步实体默认软删除，写入 `deleted_at`；
- 删除必须进入同步变更日志；
- v1 业务墓碑保留到账号物理清除，不做日常物理回收；
- 可选 Resume 派生文件对象采用延迟回收；
- 账号注销使用独立工作流，不复用普通 CRUD 删除；
- `rejected`、`no_response` 等业务终态不等于删除。
