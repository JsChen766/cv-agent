# AGENTS.md — cv-be 后端开发指南

本文档是 Codex 在此项目中工作的核心参考。每次开始新任务前必须阅读。

---

## 项目概述

基于 LangGraph + LangChain + FastAPI 的多 Agent 简历助手后端。

完整架构规划见 `docs/new-agent-architecture-plan.md`。

---

## 核心设计原则

### 高内聚、低耦合

**高内聚**：每个模块拥有完整的垂直切片（models + service + repository），功能自包含，不依赖其他模块的内部实现。

**低耦合**：模块间只通过接口（Protocol）通信，不依赖具体实现；框架代码（LangGraph、FastAPI）只存在于对应层，不向下渗透。

### 依赖方向（严格单向，不可反转）

```
api → graphs → tools → domain ← infra
                 ↓
           rag / memory / providers
                 ↓
               core
```

违反此方向的 import 是架构错误，必须拒绝。

---

## 目录结构

```
app/
├── api/          # FastAPI 路由、中间件、请求/响应 schema
├── graphs/       # LangGraph subgraph、Node、State 定义
├── tools/        # Tool 协议定义 + 各工具实现 + 统一注册表
├── domain/       # 业务领域层（无框架依赖，纯业务逻辑）
├── rag/          # RAG 服务（Guideline RAG + Evidence RAG）
├── memory/       # ThreadState、Context Assembly、滚动摘要
├── providers/    # LLM Provider 抽象（OpenAI format / Anthropic format）
├── infra/        # Repository 具体实现（Postgres）、文件存储/解析
└── core/         # 共享基础：config、types、errors、SSE events
```

---

## 各层规则

### api/
- 只处理 HTTP 关注点：路由、鉴权、序列化/反序列化
- 不包含业务逻辑，调用 `graphs/` 或 `domain/` service
- `schemas/` 里的 Pydantic 模型只用于 I/O，不作为业务模型传递

### graphs/
- 所有 LangGraph 代码（StateGraph、Node、conditional edge）都在这里
- 不直接访问数据库，不 import `infra/`
- 通过 `tools/registry.py` 获取工具列表
- 每个 subgraph 是独立的 `StateGraph`，在 `graphs/main.py` 组装

### tools/
- 每个工具一个文件，实现 `Tool` 协议（`base.py` 定义）
- 只调用 `domain/` service，不直接操作数据库
- 所有工具通过 `tools/registry.py` 注册，**新增工具只需创建文件 + 注册一行**
- 工具必须声明：`name`、`description`、`input_schema`、`requires_confirmation`、`risk_level`

### domain/
- **零框架依赖**：不 import FastAPI、LangGraph、asyncpg、SQLAlchemy
- Repository 只定义 `Protocol`（接口），具体实现在 `infra/`
- 业务逻辑写在 `service.py`，通过依赖注入接收 repository 实例
- 这一层可以独立测试，不需要数据库或 HTTP 服务

### infra/
- 实现 `domain/` 中定义的 Repository Protocol
- 唯一允许直接使用 asyncpg / SQLAlchemy 的层
- 文件解析（PDF/Word）也在这里，做成同步接口

### rag/
- Guideline RAG 和 Evidence RAG 各自独立，可单独升级检索策略
- 不依赖 LangGraph，只依赖 `providers/` 和 `infra/`

### core/
- 最底层，不依赖任何其他层
- 放置：`config.py`（pydantic-settings）、`types.py`（共享类型）、`errors.py`、`events.py`（SSE 事件类型）

---

## 扩展标准步骤

### 新增工具
1. 在 `tools/<domain>/` 创建工具文件，实现 `Tool` 协议
2. 在 `tools/registry.py` 注册一行
3. 完成——Router 的 `open_ended` 子图自动感知

### 新增 Artifact 类型
1. 在 `graphs/artifact/registry.py` 添加一行注册（type 标签 + 默认 context_hints）
2. 完成——不需要修改 subgraph 逻辑

### 新增 Subgraph（新业务链路）
1. 在 `graphs/` 创建新目录，实现 `StateGraph`
2. 在 `graphs/router.py` 添加路由分支
3. 完成

### 新增 LLM Provider
1. 在 `providers/` 创建文件（实现 `Provider` 协议）
2. 在 `providers/factory.py` 注册
3. 完成

---

## 关键架构决策

| 事项 | 决策 |
|---|---|
| API 层 | Python FastAPI（async），并发瓶颈时可拆 Node.js BFF |
| LLM 格式 | OpenAI format + Anthropic format，覆盖所有主流厂商 |
| 确认机制 | LangGraph `interrupt()` + PostgreSQL Checkpointer，替代 PendingAction 表 |
| Self-Review 上限 | 最多 3 轮 |
| PDF 导出 | 前端浏览器 print-to-PDF，后端不介入 |
| 文件解析 | 同步接口，无独立 Job 系统 |
| PreferenceBank | 自动提取（行为信号）+ 显式设置并存，显式优先 |
| 向量检索 | PostgreSQL pgvector |

---

## 代码规范

- Python 3.12+，全面使用 `async/await`
- 类型注解覆盖所有函数签名
- Pydantic v2 用于数据校验
- `ruff` 用于 lint 和 format（不用 black/flake8）
- `mypy` 静态类型检查
- 测试：`pytest` + `pytest-asyncio`，domain 层单元测试不依赖数据库

---

## 禁止事项

- ❌ 在 `domain/` 层 import 任何框架（FastAPI / LangGraph / asyncpg）
- ❌ 在 `graphs/` 层直接访问数据库
- ❌ 在 `tools/` 层绕过 domain service 直接操作数据库
- ❌ 在任何层反向 import（下层 import 上层）
- ❌ 新增工具时修改 Router 或 Orchestrator 核心逻辑
- ❌ 在 `core/` 层 import 其他任何层
