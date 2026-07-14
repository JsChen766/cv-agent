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
