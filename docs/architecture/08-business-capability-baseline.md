# 四大业务能力基线

> 状态：Baseline v0.2  
> 日期：2026-07-26  
> 依据：APP PRD、当前 APP Adapter、原 `cv-agent` 后端只读审计

## 1. 产品目标

新后端不是原 Agent 后端的重构，而是面向 APP 的轻量业务后端。产品核心只有四个：

1. 经历库；
2. JD 库；
3. 简历库；
4. 投递追踪。

账号、订阅、设备会话和同步是支撑能力，不应反向污染四个业务模块。后端不承担 LLM、Agent、
Prompt、LangGraph、匹配计算、简历生成、浏览器自动填写或 PDF 排版。

## 2. 原后端审计结论

原后端 `/Users/apple/cv-agent` 可作为业务语义参考，但不复制代码。

| 原能力 | 可参考内容 | 不迁移内容 |
| --- | --- | --- |
| Experience | 用户隔离、分类、标签、归档、不可变 revision、当前 revision | embedding、FactBank、导入 Agent、RAG |
| JD | 原文、公司、岗位、requirements、稳定 requirement ID、分页 | LLM requirement parser、embedding、RequirementMap cache |
| Resume | 2026-07-24 后的单云端文档模型、structured、contentHash、归档 | 生成图、质量修复 Agent、布局测量、AI edit proposal |
| Application | 无可复用 Tracker CRUD | `graphs/application` 只是生成投递材料包，不是投递记录 |
| Identity | 用户隔离、Session Cookie 的现有传输语义 | 旧账号和旧数据迁移 |

因此不沿用原 FastAPI/LangGraph 工程，也不迁移其 checkpoint、thread、artifact、RAG、provider、
uploaded file 和 observability schema。

## 3. 经历库

必须支持：

- 工作、项目、教育、志愿和其他经历；
- 名称、组织、角色、地点、时间、标签和状态；
- 背景、职责、成果、技能等结构化正文；
- 创建、查询、筛选、编辑、归档、删除；
- 更新正文时创建不可变 revision，并原子切换 current revision；
- 本地导入候选经用户确认后写入；
- 稳定 ID、用户所有权、幂等和双向同步。

原始 PDF、DOCX、图片或其他材料不上传云端；后端只接收用户确认后的经历数据。

## 4. JD 库

必须支持：

- 岗位名称、公司、目标角色、原文、来源 URL、hash 和状态；
- 结构化 requirements，包含稳定 ID、类别、重要程度、关键词、权重和顺序；
- 创建、列表、搜索、详情、完整更新、归档和删除；
- APP 本地或未来浏览器模块完成提取后，将确认结果写入后端；
- JD 或 requirement 变化能让 APP 判断旧匹配报告已经过期；
- 与 Resume、Application 建立可空关联。

后端不调用 LLM 解析 JD，不负责抓取网页。JD 提取和匹配算法仍在 APP。

## 5. 简历库

必须支持：

- 一份云端 Resume 只有一份当前 `structured` 完整文档；
- 标题、目标岗位、目标公司、关联 JD、状态、schemaVersion 和 contentHash；
- 列表、详情、创建、完整替换、元数据更新、归档、恢复和同步软删除；
- 本地 ResumeDraft、workspace 和 checkpoint 继续留在 APP；
- 云端不提供版本历史、diff 或回退；
- 本地与云端同时修改时支持重读、另存新 Resume、明确覆盖三条路径；
- 可通过 Resume ID 被投递记录引用，并在仓库中展示是否已经用于投递。

简历生成、质量评估、排版、PDF 导出和 LLM 修改均属于 APP。本后端只校验并保存最终确认资产。

## 6. 投递追踪

必须支持：

- 看板列：已投递、初筛中、面试中、Offer、已拒和无回应；
- 创建、列表、筛选、详情、编辑、软删除；
- 关联公司、岗位、投递时间、Resume、JD、投递方式、目标 URL 和来源；
- 保存公司和岗位快照，避免 JD 后续修改破坏历史；
- 拖拽触发显式 transition，不允许通用 PATCH 绕过状态机；
- 状态与 status event 在一个事务中更新；
- 自动识别记录先进入 `pendingConfirmation`，支持确认和去重；
- 面试轮次、笔记、提醒时间同步；实际系统通知由 APP 本地执行。

邮箱扫描、公司资料补全和面试问题生成属于后续 APP/集成能力，不放入首版 CRUD 内核。

## 7. APP 与后端分工

```text
APP 本地
├─ Agent / LLM / Match Report
├─ Conversation / Proposal / Approval
├─ ResumeDraft / Workspace / Checkpoint
├─ 文件解析、浏览器填写、PDF 和本地通知
└─ LocalSyncStore / Outbox / 本地四大业务投影

新后端
├─ Identity / Session / Entitlement
├─ Experience / JD / Resume / Application
├─ 乐观锁、幂等、状态机和用户隔离
└─ Push / Pull / Tombstone / 跨设备收敛
```

四大业务实体采用本地优先双向同步。账号、订阅和 Session 以云端为准。原始文件、对话、临时
Proposal、匹配报告草稿和 Resume checkpoint 不同步。

## 8. 兼容替换标准

兼容目标是“APP 功能不变”，不是“每个旧 JSON 字段永远不动”：

- 优先保留当前 `/v1` 路径和 Session Cookie，降低替换成本；
- 当前 Experience、JD、Resume Adapter 能直接复用时继续复用；
- 新设计明显更合理时，可以同步修改 APP Adapter、Normalizer 和类型；
- 不要求复制原后端 envelope、内部表结构或 Agent 时代冗余字段；
- 不把已有 fixtures 当作永久冻结门禁，只作为迁移对照样本；
- 每次调整必须证明四大业务主流程仍可完成，且旧功能没有丢失。

## 9. 最小验收

本项目不以测试数量或覆盖率为目标，也不要求建设重型 contract test 套件。最低验收只保留：

- Docker 环境可启动，健康检查通过；
- 空库 migration 可执行；
- 四大业务主流程可由 APP 完成；
- 用户 A 不能访问用户 B 的数据；
- Resume 冲突和 Application 非法状态流转会被拒绝；
- 幂等重试不重复创建；
- 在约定服务器规格与代表性数据下达到性能目标。

没有真实压测结果时，不得宣称“性能优秀”。
