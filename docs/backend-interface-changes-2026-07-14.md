# 后端接口变动 — 2026-07-14

本次改动为**内部 Agent 抽取能力升级**,不新增或删除路由,不改变现有字段类型语义,仅对**经历导入**流程涉及的候选对象做增量字段补充和一个字段的空值范围放宽。对外接口 contract **向后兼容**(additive + nullable relaxation),前端如已正确处理可选字段可零改动接入。

---

## 影响面

只影响**经历导入子图 (`experience_import`)** 通过 SSE 抛出的 `agent.interrupt` 事件中 `candidates` 数组的对象形状,以及前端 resume 该 interrupt 时回传的 `confirmed_candidates` 对象形状。

### 涉及接口

| 类别 | 端点 / 事件 | 变动 |
|---|---|---|
| SSE 事件 | `POST /copilot/chat/stream` → `agent.interrupt` (`type="experience_import"`) 载荷中的 `candidates[]` | 字段扩展 + `organization` 可空 |
| Interrupt Resume | `POST /copilot/interrupts/{interrupt_id}/resume` body 中的 `confirmed_candidates[]` (若前端回传编辑后的候选) | 与上同 |
| 直接导入 (未走对话) | `POST /product/import/text` body 中的 `candidates[]` (`ImportCandidateBody`) | **无变化**,domain 层原本就支持 `organization/role` 可空 |

其他所有端点(简历、JD、artifact、files、resume canvas 等)**不受影响**。

---

## Candidate 对象形状变化

**旧形状** (`app/graphs/experience/nodes.py` 内 `ExperienceCandidate`,变动前):

```jsonc
{
  "title": "string",              // 必填
  "organization": "string",       // 必填
  "start_date": "YYYY-MM | null",
  "end_date":   "YYYY-MM | 'present' | null",
  "content": "string",            // 必填
  "category": "work | project | education | volunteer | other"
}
```

**新形状**:

```jsonc
{
  "title": "string",                    // 必填 (不变)
  "organization": "string | null",      // ⚠️ 由必填变为可空
  "role": "string | null",              // ➕ 新增
  "start_date": "YYYY-MM | null",
  "end_date":   "YYYY-MM | 'present' | null",
  "content": "string",                  // 必填 (不变)
  "category": "work | project | education | volunteer | other",
  "tags": "string[]"                    // ➕ 新增,可为 []
}
```

### 字段语义

- **`title`** — 经历标识:职位名 / 项目名 / 学位名。不再包含所属机构。
- **`organization`** — 归属机构。**当源文本未明确归属时为 `null`**,不再幻觉填充(旧行为会强行编造)。
- **`role`** — 组织内的职位或角色(如 `研究助理（核心开发者）`、`项目负责人`)。当 `title` 已完整表达该角色时为 `null`。保证与 `organization` 内容不重叠。
- **`content`** — 详情描述。**每条 bullet 以 `- ` 前缀分行**,可直接按 markdown 渲染列表。数字、百分比、专有名词逐字保留。
- **`tags`** — 从原文抽取的技术栈/领域标签(如 `["Spark", "Hadoop", "数据分析"]`)。可为空数组。**只来自原文,不会凭空生成**。

---

## 兼容性判定

| 兼容维度 | 结论 |
|---|---|
| 已发布调用方是否需要立即改动 | **不需要** |
| 类型契约层面 | 向后兼容 (additive + one field: required→nullable) |
| 现有反序列化会否报错 | 不会 (旧字段一个不缺;新字段前端不消费也不影响) |
| Domain / DB schema | 无变化 (`ImportCandidate` 已支持 `organization/role` 可空 + `tags`) |
| 迁移 | 不需要迁移 |

### 前端接入建议 (可选)

1. **`organization`** 处理为可空,`null` 时可显示占位符 (如"未指定机构") 或隐藏该字段。
2. **`role`** 若非空,建议在卡片上以从属信息展示(如"公司 · 职位"或独立一行)。
3. **`tags`** 建议以 chip / badge 形式渲染,便于用户在 review 时快速删除/添加。
4. **`content`** 现按 markdown 列表格式产出,若原本按纯文本 `\n` 拆分渲染仍可工作;若切换为 markdown 渲染可直接得到列表结构。

---

## 变更文件

- [app/graphs/experience/nodes.py](../app/graphs/experience/nodes.py)
  - `ExperienceCandidate` schema 增加 `role`、`tags`,`organization` 改为可空
  - 抽取 prompt 提到模块级常量 `_EXTRACT_SYSTEM_PROMPT`,明确字段语义、禁止幻觉、bullet 前缀、语言一致
  - 新增 `_postprocess_candidate` 做 `organization` / `role` / `title` 之间的去冗余(如 `南昌大学-研究助理` → org=`南昌大学` / role=`研究助理`)

## 未变更 (显式说明)

- `AgentInterruptEvent` TypedDict (`app/core/events.py`) 中 `candidates: list[dict[str, Any]]`,类型级签名不变
- `POST /product/import/text` 的 `ImportCandidateBody`,domain 层字段可空性未变
- 其他所有子图、路由、SSE 事件类型

---
---

# Part 2 — 简历生成流程契约变动 (Layer 2)

本部分记录**简历生成**(`resume_generation` subgraph)的两组变动:
- **Layer 1 (已上线)** — 内部改进,**不改对外契约**:draft 生成加严格 grounding、新增 `fact_check` 节点、`self_review` 硬性 gate 事实错误。
- **Layer 2 (待上线,本次定稿)** — **改对外契约**:产物从 markdown blob 换为结构化 JSON、废除 "变体数组" 概念、interrupt 载荷字段调整。

## Layer 1 变更(内部,已生效)

| 项 | 变更 |
|---|---|
| `draft_generation_node` prompt | 抽为常量 `_DRAFT_SYSTEM_PROMPT`,加入硬性 grounding 禁令:所有日期/组织/角色/百分比/技术名必须逐字来自源经历,禁止改动。规定 section 顺序与 bullet 结构。 |
| draft 温度 | `0.6 → 0.2` |
| 经历传参 | 移除 `experiences[:5]` + `content[:600]` 粗暴截断,改为按字段清晰的 labeled block 全量传入 |
| 新增 `fact_check_node` | 在 `self_review` 之前跑;`chat_structured` 输出 `mismatches: [{field, drafted_value, source_value, experience_title, detail}]` |
| `self_review_node` | 只要 `fact_mismatches` 非空,硬性 `verdict=needs_revision`,把具体错误写入 `revision_instruction`,下一轮 draft 强制修复 |
| Graph | 新增边 `draft_generation → fact_check → self_review` |
| State | 新增字段 `fact_mismatches: list[dict]` |

**对外契约:无变化**。

## Layer 2 契约变动(待上线)

### 影响面

| 类别 | 端点 / 事件 | 变动 |
|---|---|---|
| SSE 事件 | `POST /copilot/chat/stream` 的 `agent.interrupt` (`type="resume_review"`) | 新增 `resume` 字段(单个对象);`variants` 字段保留但**始终为空数组**(向后兼容占位) |
| SSE 事件 | `agent.interrupt` (`type="application_package_review"`) | 同上 |
| Interrupt Resume | `POST /copilot/interrupts/{interrupt_id}/resume` | `action="accept"` 时不再需要 `selected_variant_id`;若传入将被忽略 |
| Domain 存储 | `resume_variants` 表 | 新增 `structured JSONB NULL` 列(alembic 迁移),`ResumeVariant`/`ResumeVariantCreate` 模型加 `structured: dict | None` 字段 |

**未变化**:所有 `/product/resumes/*`、`/product/resume-items/*` REST 端点;`ResumeItem` 表结构;copilot chat 请求 body。

### 新增结构化 schema

放在 `app/graphs/resume/nodes.py`(与其他 pydantic schema 同层)。

```python
class ResumeBullet(BaseModel):
    id: str                                  # server-assigned, stable (e.g. "bul-<uuid>")
    text: str                                # 单条 bullet 全文
    matched_jd_requirement_ids: list[str]    # Layer 3 起填充;Layer 2 始终 []

class ResumeSectionItem(BaseModel):
    id: str                                  # server-assigned
    title: str | None                        # 岗位 / 项目名 / 学位名
    organization: str | None
    role: str | None
    start_date: str | None                   # "YYYY-MM" | "present" | null
    end_date: str | None
    source_experience_id: str | None         # 反向链接到源经历库
    bullets: list[ResumeBullet]              # experience/project 场景;summary/skills 可为 []
    raw_text: str | None                     # summary 段落文本 / skills 内容;不用 bullet 时使用

class ResumeSection(BaseModel):
    id: str                                  # server-assigned
    type: Literal["summary","education","experience","project","skills","other"]
    heading: str | None                      # 自定义标题;为 null 时前端按 type 显示默认
    items: list[ResumeSectionItem]

class ResumeContact(BaseModel):
    name: str | None
    email: str | None
    phone: str | None
    location: str | None

class ResumeStructure(BaseModel):
    language: str                            # "zh-CN" | "en-US" | ...
    contact: ResumeContact | None            # 来自 user_profile;可为 null
    sections: list[ResumeSection]
```

**ID 生成策略**:LLM 只产出内容字段,`id` 由服务端在 draft_generation_node 内部用 `uuid.uuid4()` 后处理分配,保证稳定、去重、无 LLM 幻觉。

### `agent.interrupt` 载荷 diff

**旧** (`type="resume_review"`):

```jsonc
{
  "event": "agent.interrupt",
  "interrupt_id": "int-...",
  "type": "resume_review",
  "message": "I've generated 1 resume variant(s)...",
  "variants": [
    {
      "id": "variant-...",
      "title": "AI Generated Variant",
      "content": "# 个人简历\n\n## 个人总结\n...",   // markdown blob
      "score": { ... },
      "evidence_summary": [ ... ],
      "risk_summary": [ ... ],
      "missing_info": []
    }
  ],
  "action_options": [ ... ]
}
```

**新**:

```jsonc
{
  "event": "agent.interrupt",
  "interrupt_id": "int-...",
  "type": "resume_review",
  "message": "简历已生成,请审阅...",
  "resume": {                                          // ➕ 新增,单个对象
    "id": "resume-draft-...",                           // 稳定,accept 时可忽略也可回传
    "title": "针对 <公司> <岗位> 的简历",
    "content": "# 个人简历\n\n## 个人总结\n...",       // ⚠️ 保留,markdown,由 structured 派生
    "structured": {                                     // ➕ 主产物
      "language": "zh-CN",
      "contact": { "name": null, "email": null, "phone": null, "location": null },
      "sections": [
        {
          "id": "sec-...", "type": "summary", "heading": "个人总结",
          "items": [ { "id": "item-...", "title": null, "organization": null, "role": null,
                       "start_date": null, "end_date": null, "source_experience_id": null,
                       "bullets": [], "raw_text": "计算机科学硕士在读..." } ]
        },
        {
          "id": "sec-...", "type": "experience", "heading": "实习/工作经历",
          "items": [
            {
              "id": "item-...",
              "title": "AI算法工程师（数据处理、大模型备案）",
              "organization": "江西新华云教育科技有限公司",
              "role": null,
              "start_date": "2024-04", "end_date": "2024-07",
              "source_experience_id": "exp_...",
              "bullets": [
                { "id": "bul-...", "text": "数据清洗与预处理：处理 30 万+条...", "matched_jd_requirement_ids": [] },
                { "id": "bul-...", "text": "大规模语料管理：负责 300 万+条...", "matched_jd_requirement_ids": [] }
              ],
              "raw_text": null
            }
          ]
        }
        // ... 其他 section: education / project / skills
      ]
    },
    "score": { ... },                                   // 原字段位置不变
    "evidence_summary": [ ... ],
    "risk_summary": [ ... ],
    "missing_info": []
  },
  "variants": [],                                       // ⚠️ 保留字段但始终 []
  "action_options": [ ... ]
}
```

### Accept payload diff

前端在 `POST /copilot/interrupts/{interrupt_id}/resume` 提交 accept 时:

**旧**:

```json
{"action": "accept", "selected_variant_id": "variant-xxx"}
```

**新**:

```json
{"action": "accept"}
```

- `selected_variant_id` 字段若前端仍传入将被后端忽略,不报错。
- Backend `output_node` 直接接受 `state.variants[0]`(内部仍是单元素列表)。

### `application_package_review` 载荷 diff

只影响 payload 内的 `resumes` 段(如有):从 `variants: [...]` 变为 `resume: {...}`(单个)。其他 deliverable 字段不变。

### 存储层 diff

**表结构变化**:`resume_variants` 添加一列。

```sql
ALTER TABLE resume_variants ADD COLUMN structured JSONB NULL;
```

对应 alembic 迁移文件:`alembic/versions/0010_resume_variants_structured.py`。

**模型变化**:

```python
class ResumeVariant(BaseModel):
    # ... existing fields
    structured: dict | None = None            # ➕

class ResumeVariantCreate(BaseModel):
    # ... existing fields
    structured: dict | None = None            # ➕
```

**Repository / Service**:新增 `structured` 列的读写。若旧行 `structured` 为 NULL(历史 variant 无结构化数据),API 返回时以 `null` 呈现。

### 兼容性判定

| 兼容维度 | 结论 |
|---|---|
| 已发布调用方(消费旧字段) | 无 breaking:`variants` 字段仍存在,只是变空数组;`content` markdown 仍在 `resume.content` |
| 前端渐进接入 | 支持:老 FE 忽略 `resume` 字段仍可展示(但会看到空 variants,得看不到简历——所以过渡期建议 FE 同时读 `resume`) |
| DB 迁移 | 需要 (加 `structured JSONB` 列,可安全 NULL) |
| 单元测试 | `test_resume_*`、`test_natural_language_backend_flow.py::test_resume_review_accept_*` 需更新:`selected_variant_id` 逻辑改为可选 |

### 施工顺序(Layer 2 内部)

1. Alembic 迁移 `0010_resume_variants_structured.py` (加列)
2. domain `ResumeVariant` / `ResumeVariantCreate` 加 `structured` 字段
3. `PostgresResumeRepository` 读写 `structured`
4. `app/graphs/resume/nodes.py`:引入 `ResumeStructure` 系列 schema;`draft_generation_node` 换 `chat_structured` 产出结构化,再派生 markdown;`fact_check_node` 输入切换为 structured(更准确,可字段级比对)
5. `output_node` interrupt 载荷改为 `resume: {...}` + `variants: []`;移除 `selected_variant_id` 强校验
6. Copilot / SSE 层将 `AgentInterruptEvent` TypedDict 加 `resume: dict` 可选字段
7. 更新 test fixtures,跑全量单元测试

---

## Layer 2 变更文件预告

- `alembic/versions/0010_resume_variants_structured.py` — 新增
- [app/domain/resume/models.py](../app/domain/resume/models.py) — `ResumeVariant` / `ResumeVariantCreate` 加 `structured`
- [app/infra/db/repositories/resume_repo.py](../app/infra/db/repositories/resume_repo.py) — 读写新列
- [app/graphs/resume/nodes.py](../app/graphs/resume/nodes.py) — 新增 `ResumeStructure` schema、`_render_structured_to_markdown` 渲染器、`draft_generation_node` 改结构化输出、`fact_check_node` 输入切换、`output_node` 载荷改造
- [app/graphs/resume/state.py](../app/graphs/resume/state.py) — 新增 `resume_structure: dict | None` 字段
- [app/core/events.py](../app/core/events.py) — `AgentInterruptEvent` TypedDict 加 `resume: dict` 可选字段

---
---

# Part 3 — Layer 3:JD 深度适配 (per-requirement 覆盖 + 每 bullet 追踪)

在 Layer 2 的结构化产出之上,把 JD 适配的"深度"补齐:让 FE 可以精准可视化「这条 bullet 对应 JD 的哪一条要求」,并自动检测「哪一条 JD 要求没有任何简历内容覆盖」。

## 契约变动汇总

| 类别 | 变动 |
|---|---|
| **Bullet 对象** | `matched_jd_requirement_ids: string[]` 从 Layer 2 的"始终 `[]`"改为由 LLM 生成的真实映射;每个 bullet 可标注 0 个或多个 JD requirement id。 |
| **variant 对象** | 新增 `coverage_report: { requirements: [...], covered_count, total_count } \| null`;`risk_summary` 在存在未覆盖 requirement 时自动追加一条 `type: "coverage_gap"` 记录。 |
| **CoT 计划** | `matching_plan.coverage_plan: [{ requirement_id, requirement_text, planned_source_experience_ids: [] }]`(仅用作 LLM 提示,前端一般不消费,但通过 SSE/state 可见)。 |
| **state 新字段** | `coverage_report: dict \| None`;`uncovered_jd_requirement_ids: list[str]`。 |
| **subgraph 拓扑** | 在 `fact_check → self_review` 之间插入 `coverage_check`;新边 `fact_check → coverage_check → self_review`。 |

**不影响**:HTTP 路由、DB schema、interrupt payload 顶层结构、SSE 事件类型。所有变动都在 `resume` 对象内以 additive 字段体现。

## `variant.coverage_report` schema

```jsonc
{
  "requirements": [
    {
      "requirement_id": "req-spark-hadoop",
      "requirement_text": "有 Spark / Hadoop / Hive 等大数据框架使用经验",
      "bullet_count": 1,                        // 有多少条 bullet tag 了这个 requirement
      "supporting_items": ["维基百科编辑历史分析"]  // 提供支撑的 item.title 列表(去重)
    },
    ...
  ],
  "covered_count": 5,
  "total_count": 6
}
```

## Bullet 级 requirement 映射示例

```jsonc
{
  "id": "bul-...",
  "text": "在4GB内存限制下，设计流式解析+分批处理管道，使用Scala、Apache Spark、Hadoop搭建分布式系统，高效处理54.3GB大规模用户行为数据。",
  "matched_jd_requirement_ids": ["req-spark-hadoop", "req-large-data"]
}
```

前端可以:
- 在 bullet 旁展示 requirement 徽章
- 悬浮 requirement 时高亮所有对应 bullet
- 显示"未覆盖"警告并给出建议(内容来自 `variant.risk_summary` 的 `coverage_gap` 项)

## `coverage_check_node` 行为

- 输入:`state.jd_requirements` + `variants[0].structured`(或 `state.resume_structure`)
- 遍历所有 sections/items/bullets,累加每个 requirement 的 bullet 计数与来源 item 标题
- 输出:
  - `coverage_report`(挂到 variant 上 + state 上,双写)
  - `uncovered_jd_requirement_ids`(纯 id list,便于下游/UI 快查)
  - variant.risk_summary 追加 `coverage_gap` 条目(若有 uncovered)

**不发起 revision**——覆盖度是"软信号",通过 risk_summary 交给用户/前端决定是否补经历,避免源经历真的不支持某 requirement 时进入无限 revision 循环。

## `matching_plan.coverage_plan` schema

```jsonc
{
  "strategy": "...",
  "key_experiences_to_highlight": [...],
  "skills_to_emphasize": [...],
  "tone": "professional",
  "structure_suggestions": [...],
  "coverage_plan": [
    {
      "requirement_id": "req-spark-hadoop",
      "requirement_text": "有 Spark / Hadoop / Hive 等大数据框架使用经验",
      "planned_source_experience_ids": ["exp_005"]
    },
    ...
  ]
}
```

`planned_source_experience_ids` 是 CoT 阶段的**建议**,draft_generation 的 prompt 会把它作为参考,但 LLM 有权在生成时另选。真正生效的是最终 bullet 上的 `matched_jd_requirement_ids`,coverage_check 也是以后者为准。

## 兼容性

| 兼容维度 | 结论 |
|---|---|
| 已发布调用方 | Additive:老 FE 忽略 `matched_jd_requirement_ids` / `coverage_report` / `coverage_gap` risk 即可正常工作 |
| DB 迁移 | 不需要(coverage 数据序列化在 `structured` 的 bullet 内,以及 variant 的运行时字段;若要持久化 coverage_report,后续在 `resume_variants` 加列即可) |
| 单元测试 | 现有 138 项测试全过;`_LlmBullet` 的 `matched_jd_requirement_ids` 有默认空数组,老 mock 不需要改 |

## 变更文件

- [app/graphs/resume/graph.py](../app/graphs/resume/graph.py) — 新增 `coverage_check` 节点,插入 `fact_check → coverage_check → self_review`
- [app/graphs/resume/nodes.py](../app/graphs/resume/nodes.py) — 新增 `CoveragePlanItem`、扩展 `MatchingPlan`、`_LlmBullet` 加 `matched_jd_requirement_ids`、`_assign_structure_ids` 保留 LLM 值、`_DRAFT_SYSTEM_PROMPT` 增加映射指令、`draft_generation_node` 传入 jd_requirements 与 coverage_plan、新增 `coverage_check_node`
- [app/graphs/resume/state.py](../app/graphs/resume/state.py) — 新增 `coverage_report`、`uncovered_jd_requirement_ids` 字段

## 实测生成结果(基于 `陈剑升-香港城市大学.pdf` + 数据工程实习 JD,6 条 requirement)

**CoT `coverage_plan`**:
```
req-spark-hadoop:  []                                       # planner 未推荐,LLM draft 时自主补上
req-sql-python:    [exp_003, exp_004, exp_005, exp_006, exp_007]
req-bi-dashboard:  [exp_004]
req-large-data:    [exp_005]
req-ml-support:    [exp_003, exp_006]
req-english:       [exp_001]
```

**Bullet 级 `matched_jd_requirement_ids`(节选)**:
```
[req-sql-python]                           编写95+个复杂SQL脚本，单个脚本最高约500行...
[req-bi-dashboard]                         搭建并交付50+个 Power BI / Datawind 交互式看板...
[req-sql-python, req-ml-support]           利用Python处理3D时空轨迹数据，设计多维度量化指标体系...
[req-spark-hadoop, req-large-data]         在4GB内存限制下，使用Scala、Apache Spark、Hadoop搭建分布式系统处理54.3GB数据
[req-ml-support]                           对30万+条语料库进行去重、构造、缺失值插补等数据清洗...
```

**Coverage 报告**:
```
covered: 5 / 6

req-spark-hadoop     bullets=1  supports=[维基百科编辑历史分析]
req-sql-python       bullets=3  supports=[数据分析实习生, 基于3D运动轨迹跟踪的艾灸考评系统]
req-bi-dashboard     bullets=1  supports=[数据分析实习生]
req-large-data       bullets=1  supports=[维基百科编辑历史分析]
req-ml-support       bullets=6  supports=[AI算法工程师..., 维基百科..., 深度学习流量分析..., 艾灸考评...]
req-english          bullets=0  supports=[]      ← 未覆盖
```

**risk_summary 自动追加**:
```json
[{"type": "coverage_gap", "severity": "medium",
  "text": "1/6 JD requirement(s) lack a supporting bullet: req-english (良好的英文阅读能力，能看懂英文技术文档)"}]
```

**Fact check 副产品**:同一轮 LLM 把源文 `EFTD/EFTTC` 拼成了 `EFTTD`,fact_check_node 检出该错误,self_review 硬性 `needs_revision`,进入下一轮自动修复(在完整 graph 里 revision → draft_generation 会带着这条错误重生成)。

**结论**:JD 适配深度达到"可视化 + 可量化"级别,前端可以直接以 requirement 为轴渲染匹配状态、发现覆盖缺口、并追踪单条 bullet 的溯源与用途。

---
---

# Part 4 — Artifact 生成流程增强(cover_letter / self_intro / match_report / interview_prep / linkedin_summary)

Artifact 子图目前只有 `context_assembly → draft_generation` 两个节点,和 resume Layer 1 之前一样是幻觉重灾区(interview_prep 编造数字/技术、linkedin_summary 编造开场故事、self_intro 把从未出现的 Hive 说成"熟练掌握")。本次改造按 resume 已经验证过的 A/B/C 三层节奏推进。

## Layer A — 事实忠诚(P0,治幻觉)

**目标**:所有 artifact 的每一处 date/organization/role/metric/technology/specific achievement 必须逐字来自源经历,禁止编造。

### 具体动作

- `artifact_draft_node` 系统 prompt 加入硬性 grounding 禁令(与 resume `_DRAFT_SYSTEM_PROMPT` 同风格)
- **移除 `experiences[:4]` + `content[:300]`** 粗暴截断,改为全量 labeled block(含 id、category、tags、dates)
- temperature 从 `0.7` 降到 `0.2`
- profile.contact(name/email/phone/location)完整传入(修 `[您的姓名]` 占位符 bug)
- 新增节点 `artifact_fact_check_node`:与 resume `fact_check_node` 同风格,产出 `fact_mismatches`
- 新增节点 `artifact_self_review_node`:mismatches 非空 → 硬性 `verdict=needs_revision`,组织 `revision_instruction`
- 新增节点 `artifact_revision_node` + `revision → draft_generation` 循环边,最多 3 轮
- graph 拓扑改为:`context_assembly → draft_generation → fact_check → self_review → [revision → draft_generation]* → persist`

### 对外契约变化(Layer A)

无变化,内部质量提升。

## Layer B — 结构化产出(P0,解锁前端画布编辑)

**目标**:每类 artifact 有类型特定的 structured JSON,markdown 由 structured 派生;前端可精确定位到单段/单题/单条 requirement 进行编辑。

### Artifact 对象契约扩展(向后兼容)

`GET /product/artifacts/{id}`、`POST /copilot/chat*`(artifact.completed 事件所引用的 artifact)返回体统一扩展:

```jsonc
{
  "id": "artifact-...",
  "type": "cover_letter",
  "title": "...",
  "content": "# 求职信...",              // markdown, DERIVED from structured
  "structured": { /* type-specific, 见下 */ } | null,
  "source_experience_ids": ["exp_001", ...],
  ...其他现有字段
}
```

### 每种类型的 structured schema

**cover_letter**:
```python
class _CoverLetterParagraph(BaseModel):
    id: str
    text: str
    source_experience_ids: list[str] = []
    matched_jd_requirement_ids: list[str] = []  # Layer C 起填充

class _CoverLetterStructure(BaseModel):
    recipient: str | None                    # 如"尊敬的招聘经理"
    opening: str                             # hook 段
    body_paragraphs: list[_CoverLetterParagraph]  # 2-4 段核心成就段落
    closing: str                             # call-to-action + 落款前致辞
    signature: str | None                    # 来自 profile.name
```

**self_intro**:
```python
class _SelfIntroSentence(BaseModel):
    id: str
    text: str
    source_experience_ids: list[str] = []

class _SelfIntroStructure(BaseModel):
    sentences: list[_SelfIntroSentence]      # 通常 4-6 句
```

**match_report**:
```python
class _MatchRequirement(BaseModel):
    id: str
    requirement_id: str                      # 来自 state.jd_requirements
    requirement_text: str
    match_level: Literal["strong", "partial", "missing"]
    evidence_experience_ids: list[str] = []  # 支持这个 match 的经历
    evidence_snippets: list[str] = []        # 精确到句的引用片段
    recommendation: str                      # 一句话建议

class _MatchReportStructure(BaseModel):
    requirements: list[_MatchRequirement]
    overall_score: int                       # 0-100
    actionable_suggestions: list[str]        # 3 条动作建议
```

**interview_prep**:
```python
class _InterviewStarAnswer(BaseModel):
    situation: str
    task: str
    action: str
    result: str

class _InterviewQuestion(BaseModel):
    id: str
    question: str
    star_answer: _InterviewStarAnswer
    source_experience_ids: list[str] = []    # STAR 内容依据的经历
    matched_jd_requirement_ids: list[str] = []  # Layer C 起填充

class _InterviewPrepStructure(BaseModel):
    questions: list[_InterviewQuestion]      # 5 道
    ask_back_questions: list[str]            # 反问面试官的 3 个问题
```

**linkedin_summary**:
```python
class _LinkedinParagraph(BaseModel):
    id: str
    text: str
    source_experience_ids: list[str] = []

class _LinkedinSummaryStructure(BaseModel):
    hook: str                                # 首段 hook
    body_paragraphs: list[_LinkedinParagraph]
    call_to_action: str                      # 结尾期望/联系
```

### DB 迁移

新增 `alembic/versions/0011_artifacts_structured.py`:

```sql
ALTER TABLE artifacts ADD COLUMN structured JSONB NULL;
```

Domain 层 `Artifact` 加 `structured: dict | None = None`;repository 读写新列。

### 产出流程

`draft_generation_node` 用 `chat_structured` 直接产出类型特定 schema;`_assign_artifact_ids` 后处理分配 `paragraph`/`question`/`sentence` 稳定 UUID;`_render_artifact_to_markdown(type, structured)` 派生 markdown 作为 `content` 字段。

### 兼容性(Layer B)

| 维度 | 结论 |
|---|---|
| 老 FE 忽略 `structured` | 完全可用,`content` 仍返回完整 markdown |
| API 契约 | Additive:新增 `structured` 字段;`content` 不变 |
| DB 迁移 | 需要(加 `structured JSONB NULL` 列,可安全 null) |

## Layer C — JD / 经历适配深度(P1)

**目标**:每个 artifact 里的每一处主张都能追溯到源经历 + JD requirement;前端可视化"这段 cover letter body 对应 JD 第 X 条要求"。

### 每类 artifact 的深度适配

- **cover_letter**:每段 `body_paragraphs[].matched_jd_requirement_ids` 由 LLM 填,加 coverage_check(可选警告);paragraph 和源经历双向可查
- **match_report**:天然逐 requirement,`evidence_experience_ids` + `evidence_snippets` 显式产出;新增 field-level 一致性检查:`match_level=strong` 必须有 ≥1 个 evidence_experience_id
- **interview_prep**:每题的 `matched_jd_requirement_ids`;新增 `interview_coverage_check_node` — 若某个高优先级 JD requirement 未被任何题目 tag,产出 `uncovered_jd_requirement_ids` 提示补题
- **linkedin_summary / self_intro**:不涉及 JD,只挂 `source_experience_ids`(Layer B 已完成)

### 契约变化(Layer C)

- 每类 artifact 的 structured 内已预留 `matched_jd_requirement_ids` 字段,Layer C 只是从"始终 `[]`"变为 LLM 生成的实际值,**contract 层面无 breaking change**
- match_report 的 `evidence_experience_ids` / `evidence_snippets`、interview_prep 的 `uncovered_jd_requirement_ids` 都是 additive

## 施工顺序

1. **Layer A**:改 `artifact_draft_node` prompt/temperature/全量经历传参;新增 `artifact_fact_check_node` + `artifact_self_review_node` + `artifact_revision_node`;`graph.py` 加节点、加循环边
2. **Layer B**:alembic 0011 迁移 → `Artifact` domain 加 `structured` → repository 读写 → `_ARTIFACT_STRUCTURED_SCHEMAS` 类型 dispatch → `draft_node` 用 `chat_structured` → `_render_artifact_to_markdown` 渲染 → `Artifact` API 返回新字段
3. **Layer C**:draft prompt 加 requirement tagging 指令 → coverage_check 节点(interview_prep 专用/或所有类型通用) → match_report 强化 evidence 一致性 gate

## 变更文件预告

- `alembic/versions/0011_artifacts_structured.py` — 新增
- [app/domain/artifact/models.py](../app/domain/artifact/models.py) — `Artifact` 加 `structured: dict | None`
- [app/infra/db/repositories/artifact_repo.py](../app/infra/db/repositories/artifact_repo.py) — 读写 `structured`
- [app/graphs/artifact/nodes.py](../app/graphs/artifact/nodes.py) — 大改:5 类结构化 schema、grounding prompt、fact_check、self_review、revision、structured→markdown 渲染
- [app/graphs/artifact/graph.py](../app/graphs/artifact/graph.py) — 拓扑扩展
- [app/graphs/state.py](../app/graphs/state.py)(或 artifact 专用 state 文件) — 新增 `artifact_fact_mismatches`、`artifact_structured` 等字段
- [app/api/routes/product/artifact.py](../app/api/routes/product/artifact.py) — 返回体加 `structured`

---
---

# Part 5 — 多需求场景收口(application_package 质量拉齐 + 前端适配指南)

Part 4 完成 artifact 单独生成的质量收口后,`application_package` 子图(一次对话产出 resume + 附加投递材料)存在两个新出现的 gap:
- **resume 侧**:package 拓扑没引入 Part 1-3 新增的 `fact_check` / `coverage_check` 节点,单独生成时的幻觉守卫在 package 模式下失效。
- **artifact 侧**:package 内的每个 deliverable 直接调用 `artifact_draft_node`,绕过了 Part 4 的 fact_check / self_review / revision 循环。

本次改动把两处都收敛回单一质量基线;同时把 artifact 的 draft 与 persist 拆分,保证不论重试多少轮,**每次生成只产生一条 DB 记录**。

## 面向前端的关键变化

以下按"你在页面上会看到什么/需要改什么"分类。

### ✅ 无需改动(向后兼容)

- **`GET /product/artifacts/*` 返回体**:字段全部保留,`structured` 从 Part 4 起就是 additive nullable 字段,忽略仍可工作
- **`agent.interrupt` (type=resume_review / application_package_review)** 顶层字段不变
- **`artifact.started / artifact.delta / artifact.completed` SSE 事件**:字段不变,仍在 canvas 类型上触发
- **`_resume_canvas_metadata` 派生的 canvas presentation JSON**:字段不变

### ⚠️ 建议接入(体验会更好)

#### 1. Application package 的 deliverables 现在每个都带 `structured`

`application_package_review` interrupt 载荷里的 `deliverables` 数组,每个元素新增 `structured` 字段:

```jsonc
{
  "kind": "artifact",
  "artifact_type": "self_intro",             // 或 cover_letter / match_report / ...
  "artifact_id": "artifact-...",
  "title": "自我介绍",
  "content": "# Self Introduction\n\n...",   // markdown, 由 structured 派生
  "structured": {                             // ⬅️ 本次新增
    "sentences": [
      { "id": "sent-...", "text": "...", "source_experience_ids": ["exp_003"] },
      ...
    ]
  },
  "requirement_text": "...",
  "order": 1,
  "status": "completed"
}
```

Structured shape 与 Part 4 定义的完全一致,按 `artifact_type` dispatch:
- `cover_letter`:`recipient / opening / body_paragraphs[] / closing / signature`
- `self_intro`:`sentences[]`
- `match_report`:`requirements[] / overall_score / actionable_suggestions[]`
- `interview_prep`:`questions[] / ask_back_questions[] / coverage_report / uncovered_jd_requirement_ids`
- `linkedin_summary`:`hook / body_paragraphs[] / call_to_action`

**前端画布编辑现在可以在 package 场景下同样精确定位到单段/单题/单条 requirement**,不再需要"package 里的 artifact 只能整块编辑"的降级路径。

#### 2. 多轮 revision 不再产生多条 artifact 记录

**旧行为**:artifact 生成过程中每轮 revision 都会创建一条 `artifacts` DB 行(fact_check 失败 → revision → draft 再次 create_artifact)。用户在 artifact 列表里会看到多个"半成品"版本。

**新行为**:draft 阶段只在内存里产 structured;等 self_review 判定通过(或达到最大重试次数)后由 `persist` 节点**一次性落库**,列表里每次生成只有一个最终版本。

**前端影响**:如果之前你有"过滤同类型只显示最新一条"的补偿逻辑,现在可以移除。

#### 3. Package 模式下的 resume 现在也会经过 fact_check + coverage_check

`application_package_review` interrupt payload 里的 `resume` 对象,现在和单独 `resume_review` 完全等价——包含:

```jsonc
{
  "id": "resume-draft-...",
  "title": "...",
  "content": "...",
  "structured": { ... },
  "score": { ... },
  "evidence_summary": [...],
  "risk_summary": [                                // ⚠️ 现在也会包含 coverage_gap
    { "type": "coverage_gap", "severity": "medium",
      "text": "1/6 JD requirement(s) lack a supporting bullet: ..." }
  ],
  "coverage_report": { "requirements": [...], "covered_count": 5, "total_count": 6 },
  "missing_info": []
}
```

**前端影响**:如果 `risk_summary` 渲染逻辑之前只处理过 `missing_evidence`,现在也需要处理 `coverage_gap`(与单独 resume_review 一致)。

#### 4. 部分 artifact structured 内新增 coverage 字段

`interview_prep` structured 内在 coverage_check 后追加:

```jsonc
{
  "questions": [...],
  "ask_back_questions": [...],
  "coverage_report": {                              // ⬅️ 新增
    "requirements": [
      { "requirement_id": "req-english",
        "requirement_text": "良好的英文阅读能力",
        "question_count": 0 }
    ],
    "covered_count": 4,
    "total_count": 5
  },
  "uncovered_jd_requirement_ids": ["req-english"]   // ⬅️ 新增
}
```

markdown 渲染层也会在文末附一行 `> ⚠️ Coverage gap — the following JD requirement(s) have no matching question: req-english`。**如果不消费这两个字段,不影响任何现有渲染逻辑**;前端可选择用它们高亮"面试题没有覆盖到的 JD 要求"。

### 🚫 无 breaking change

本次改动**未删除任何字段、未改变任何类型语义**。所有添加都是 additive nullable,老 FE 不动可继续工作。

## 后端内部变更(不影响前端,列出供参考)

- **`app/graphs/artifact/nodes.py`**:
  - `artifact_draft_node` 拆分:只做 LLM 生成 + 结构化,不再落库不再 emit SSE
  - 新增 `artifact_persist_node`:统一负责落库和 SSE 事件发射,只在 revision 循环结束后调用一次
  - 新增 `generate_verified_artifact(state, config)` helper:内部串跑 draft → fact_check → coverage_check → self_review →(revision 循环最多 N 轮)→ persist,返回最终 state delta
- **`app/graphs/artifact/graph.py`**:拓扑加 `persist` 节点在 `self_review` 之后
- **`app/graphs/application/graph.py`**:resume 侧补齐 `fact_check` + `coverage_check` 节点,拓扑与单独 `resume_generation` 一致
- **`app/graphs/application/nodes.py`**:`generate_application_artifacts_node` 改用 `generate_verified_artifact`,每个 deliverable 都走完整验证循环

## 单元测试

138/138 通过。修改的 fixture:
- `tests/unit/test_graphs/test_artifact.py`:两个用例改为 draft + persist 两步,验证 persist 后才产生 SSE 事件
- `tests/unit/test_application_package_flow.py::test_package_artifacts_are_collected_and_failures_do_not_block`:mock 目标从 `artifact_draft_node` 换成 `generate_verified_artifact`
