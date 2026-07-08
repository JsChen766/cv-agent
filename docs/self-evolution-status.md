# Self-Evolution (自进化) 现状

> 记录时间: 2026-07-08
> 基于代码库实际实现与架构文档 `new-agent-architecture-plan.md` 的对比分析。

---

## 概览

自进化体系以 **PreferenceBank 偏好银行** 为核心，设计为三源闭环：用户反馈 → 信号存储 → LLM 提取 → embedding 去重 → 偏好注入。以下分模块记录实装状态。

---

## 一、已实装

### 1. Self-Review 自检循环 ✅

简历生成子图内置 3 轮质量内循环：

```
draft_generation_node
  → self_review_node (LLM 审稿：评分 + 修改说明)
  → review_route (条件边)
      ├─ "needs_revision" 且 iteration < 3: → revision_node → draft_generation
      └─ "pass" 或 iteration >= 3: → output_node (interrupt)
```

- 文件: `app/graphs/resume/nodes.py` (self_review_node, revision_node, review_route)
- 配置: `app/core/config.py` → `max_self_review_iterations = 3`
- 成熟度: **100%**

### 2. Rolling Summary 长对话记忆压缩 ✅

超过消息阈值时，旧消息由 LLM 压缩为 2-4 句摘要，保留关键决策和偏好。

- 文件: `app/memory/rolling_summary.py`
- 成熟度: **100%**

### 3. Context Assembly 智能上下文聚合 ✅

生成时并发拉取所有相关上下文：JD 文本、经历（RAG 检索）、指南、偏好、用户画像。偏好以结构化块注入 prompt。

- 文件: `app/memory/context_assembly.py`, `app/graphs/resume/nodes.py` (context_assembly_node)
- 成熟度: **100%**

### 4. Explicit Preference 显式偏好 CRUD ✅

用户通过 API 直接声明偏好规则，priority=100，source="explicit"，每次生成都参与上下文。

- 文件: `app/api/routes/users.py`, `app/domain/preference/service.py`
- 成熟度: **100%**

### 5. 信号记录（Rejection / Edit Diff）✅

| 信号源 | 触发点 | 写入位置 |
|---|---|---|
| 用户 discard 并填写理由 | `POST /threads/{id}/discard` | `preference_signals` |
| 用户编辑 artifact 内容 | `PATCH /product/artifacts/{id}` | `preference_signals` |

- 文件: `app/api/routes/threads.py`, `app/api/routes/product/artifact.py`
- 信号存入 `preference_signals` 表，`processed=FALSE`
- 成熟度: **100%**（记录部分）

### 6. upsert + embedding 去重（代码存在，无调用）⚠️

`upsert_from_extraction()` 方法已实现：embedding 相似度 > 0.85 则强化已有偏好（`reinforcement_count++`、confidence 上限 1.0），否则新建。

- 文件: `app/domain/preference/service.py` (80-131 行), `app/infra/db/repositories/preference_repo.py`
- 测试: `tests/unit/test_domain/test_preference_service.py`
- 成熟度: **代码完整，但无任何生产代码调用**

---

## 二、缺失的关键环节

### 1. 信号 → 偏好提取 Pipeline ❌

架构文档规划的闭环：

```
preference_signals (processed=FALSE)
  → LLM 提取结构化规则
  → embedding 去重 (threshold=0.85)
    → 已存在：reinforce（+confidence, +count）
    → 不存在：创建新 preference
  → mark_signal_processed()
```

`get_unprocessed_signals()`、`upsert_from_extraction()`、`mark_signal_processed()` 在 service/repo 层都有实现，但**没有任何编排层调用它们**（无 graph node、无 background job、无 API 端点）。

结果：信号进了 `preference_signals` 表就永远停在那里。

- 影响等级: **CRITICAL**

### 2. 定期 Consolidation ❌

架构文档规划每 5 条信号执行一次 consolidation：
- LLM 检测冲突偏好（高优先级覆盖低）
- embedding > 0.9 则合并
- confidence < 0.3 且 reinforcement_count = 1 则清理

完全未实现。

### 3. 对话中隐式偏好提取 ❌

用户说"我喜欢量化表达"——graph 中没有节点从 conversation message 中提取偏好。

### 4. 简历编辑信号捕获 ❌

`PATCH /product/artifacts/{id}` 已捕获 artifact 编辑 diff，但简历 canvas 编辑 (`product/resume.py`) 没有 diff 捕获。

### 5. 变体接受强化 ❌

用户 accept 一个生成的 resume variant——这明明是正向反馈信号，但 `output_node` 没有记录任何 reinforcement。

### 6. Confidence Decay / 弱信号清理 ❌

无时间衰减机制，旧偏好永远保持原始 confidence。

### 7. 跨会话元学习 ❌

每个 session 拉取相同偏好列表，无 session 级别的洞察积累。

---

## 三、成熟度矩阵

| 组件 | 成熟度 | 说明 |
|---|---|---|
| Preference 数据模型 & schema | 100% | models + migration 完整 |
| 显式偏好 CRUD API | 100% | `POST /users/me/preferences` 等 |
| Rejection 信号记录 | 100% | discard 端点写入信号表 |
| Edit Diff 信号记录 (artifact) | 60% | 仅 artifact，无 resume |
| Self-Review 自检循环 | 100% | 3 次迭代 |
| Rolling Summary | 100% | 消息阈值触发压缩 |
| Context Assembly + 注入 | 100% | 并发拉取所有上下文 |
| upsert + embedding 去重 | 80% | service/repo 有代码，无调用 |
| **信号 → 偏好提取** | **0%** | pipeline 未搭建 |
| **定期 consolidation** | **0%** | 未实现 |
| **对话隐式提取** | **0%** | 未实现 |
| **简历编辑信号捕获** | **0%** | 未实现 |
| **变体接受强化** | **0%** | 未实现 |
| **Confidence decay** | **0%** | 未实现 |
| **跨会话元学习** | **0%** | 未实现 |
