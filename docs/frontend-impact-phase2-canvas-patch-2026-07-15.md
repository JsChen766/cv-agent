# 前端影响说明 — Phase 2 简历画布决定性 Patch

**产出日期**：2026-07-15  
**对应后端变动**：context-persistence-and-canvas-editing-handoff-2026-07-15.md § Phase 2  
**影响范围**：additive only；现有接口无破坏性变更

---

## 1. 新增端点

### `PATCH /product/resumes/{resume_id}/variants/{variant_id}/structured`

用于对简历画布（`structured`）做**确定性批量编辑**，不走 SSE / LLM，同步返回。

#### Request

```http
PATCH /product/resumes/{resume_id}/variants/{variant_id}/structured
Authorization: Bearer <token>
Content-Type: application/json
```

```jsonc
{
  "operations": [
    // --- Bullet 级操作 ---
    { "op": "replace_bullet",  "bullet_id": "bul-xxx", "text": "新文本" },
    { "op": "delete_bullet",   "bullet_id": "bul-yyy" },
    {
      "op": "add_bullet",
      "item_id": "item-xxx",
      "text": "新 bullet 文本",
      "after_bullet_id": "bul-zzz"   // null 或省略 → 追加到末尾
    },
    {
      "op": "reorder_bullets",
      "item_id": "item-xxx",
      "bullet_ids": ["bul-a", "bul-b", "bul-c"]  // 必须与当前 bullets 集合完全一致
    },
    // --- Item 级操作 ---
    {
      "op": "replace_item_field",
      "item_id": "item-xxx",
      "field": "title" | "organization" | "role" | "start_date" | "end_date" | "raw_text",
      "value": "..."
    },
    { "op": "delete_item", "item_id": "item-xxx" },
    {
      "op": "add_item",
      "section_id": "sec-xxx",
      "item": { "title": "...", "organization": "..." },  // id 由后端分配
      "after_item_id": "item-yyy"   // null 或省略 → 追加到末尾
    },
    {
      "op": "reorder_items",
      "section_id": "sec-xxx",
      "item_ids": ["item-a", "item-b"]  // 必须与当前 items 集合完全一致
    },
    // --- Section 级操作 ---
    {
      "op": "replace_section_field",
      "section_id": "sec-xxx",
      "field": "heading",
      "value": "新标题"
    },
    {
      "op": "reorder_sections",
      "section_ids": ["sec-a", "sec-b", "sec-c"]  // 必须与当前 sections 集合完全一致
    }
  ]
}
```

- `operations` 数组最少 1 条
- 所有 op **顺序执行**，任一失败整批回滚（服务端保证原子性）
- `add_bullet` / `add_item` 的新 id 由后端生成（`bul-<uuid>` / `item-<uuid>`），Response 里可见

#### Response — 成功 (200)

```jsonc
{
  "success": true,
  "data": {
    "variantId": "variant-new-xxx",       // 新创建的 variant 行的 id（与请求的 variant_id 不同）
    "structured": { /* 完整新 structured */ },
    "content": "...",                      // 重新渲染的 markdown
    "version": 3,                          // 在版本链中的序号（从 1 起）
    "parentVariantId": "variant-src-xxx"  // 指向被编辑的那一版
  }
}
```

> **重要**：每次 PATCH 都会新建一个 `resume_variants` 行（不是 in-place 更新）。  
> 新 `variantId` 是之后操作的基准；前端应更新本地持有的 `activeVariantId`。

#### Response — 失败

| 状态码 | 原因 |
|---|---|
| `404` | `resume_id` 或 `variant_id` 不存在，或不属于当前用户 |
| `422` | 非法 op（未知 op type、id 找不到、`reorder_*` 集合不一致等） |

---

## 2. 现有接口变动（additive，向后兼容）

### `ResumeVariant` 对象新增字段

所有返回 `ResumeVariant` 的场景（`GET /product/resumes/{id}`、`agent.interrupt` 中的 `resume` 字段等）现在会包含两个新字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `parentVariantId` | `string \| null` | 版本链父节点 id；AI 生成的初版为 `null` |
| `version` | `number` | 在该 resume 下的版本序号，从 `1` 起；AI 生成初版为 `1` |

**旧字段全部保留，类型语义不变**，前端如未读取新字段可零改动。

```diff
 {
   "id": "variant-xxx",
   "title": "...",
   "content": "...",
+  "parentVariantId": null,
+  "version": 1,
   "score": { ... },
   "evidenceSummary": [...],
   "riskSummary": [...],
   "missingInfo": [...],
   "createdAt": "..."
 }
```

---

## 3. 前端集成要点

### 3.1 Optimistic Update 建议

1. 前端在本地立即对 `structured` 应用 op（乐观更新，无需等待后端）
2. 发出 PATCH 请求
3. 收到 Response 后，用 Response 的 `structured` + `content` + `variantId` 覆盖本地状态，并更新 `activeVariantId = data.variantId`
4. 若请求失败（422/404），回滚本地乐观更新并展示错误提示

### 3.2 id 稳定性保证

- **保持不变的 id**：所有被 op 定位但未被删除的 `sec-*` / `item-*` / `bul-*` id，PATCH 前后完全一致
- **新增内容的 id**：`add_bullet` / `add_item` 由后端分配，前端可从 Response `structured` 中读取
- **版本链**：每次 PATCH 产出新 `variantId`，旧 variant 行保留（可通过 `parentVariantId` 链回溯）

### 3.3 `reorder_*` op 的参数要求

`reorder_bullets` / `reorder_items` / `reorder_sections` 要求传入的 id 数组与当前集合**完全一致**（不多不少不重复）。前端构造时应直接把当前渲染顺序的 id 数组重排后传入，不要过滤或新增。

### 3.4 `replace_item_field` 允许的字段

仅限以下 6 个字段：`title` / `organization` / `role` / `start_date` / `end_date` / `raw_text`。  
**`id` 字段不可通过此 op 修改**（后端会 422）。

---

## 4. 数据库迁移（后端侧，无需前端操作）

迁移 `0013_resume_variants_parent.py` 已就绪，为 `resume_variants` 表新增：
```sql
ALTER TABLE resume_variants
  ADD COLUMN parent_variant_id TEXT NULL REFERENCES resume_variants(id) ON DELETE SET NULL;
```

---

## 5. 不属于 Phase 2 的内容（Phase 3 会补充）

以下能力**不在本次范围**，不要基于本文档的接口期待：

- 对话式编辑（说自然语言 → 后端定位 + patch）：Phase 3 实现
- SSE 广播多设备同步
- Undo/Redo 专用端点（前端可自行用本地历史栈，或利用 `parentVariantId` 链回退）
