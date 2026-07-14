# 交接文档 — 上下文持久化 + 简历画布编辑(三阶段)

**产出日期**:2026-07-15
**交接对象**:后续独立对话中的 Claude(或人类工程师)
**背景阅读**:请先读 [CLAUDE.md](../CLAUDE.md)(架构原则)、[docs/backend-interface-changes-2026-07-14.md](backend-interface-changes-2026-07-14.md)(近期契约变动全景),再回到本文件

---

## 0. 交接摘要

本次一次性交接三个**顺序推进、互不阻塞**的工作包:

| 阶段 | 目标 | 契约影响 |
|---|---|---|
| **Phase 1** | 修复**全类目**上下文丢失(不只 JD) | 内部为主;`workspace` 增加一批 additive nullable 字段 |
| **Phase 2** | 简历画布**决定性 patch**(Tier 1,非对话) | 新增 1 个 REST 端点(additive) |
| **Phase 3** | 简历画布**对话式编辑**(Tier 2,LLM 定位 + patch;Tier 3 走既有 resume_generation) | Router 新意图 + 新子图 `resume_edit`;不删旧字段 |

**每一阶段做完都必须能独立发版**,不留半成品。上一阶段的验收标准通过后再启动下一阶段。

---

## 1. 全局约束(每一阶段都必须遵守)

1. **不破坏稳定 id**:`resume.structured` 里所有 `sec-*` / `item-*` / `bul-*` id **必须跨编辑保持稳定**。前端会用它做 optimistic update、diff 高亮、点选定位。任何编辑操作若能保留 id 就保留;新增内容才分配新 uuid。
2. **契约向后兼容**:所有新增字段 additive nullable,所有新增端点单独路径,不改现有响应字段类型语义。
3. **domain 层零框架依赖**([CLAUDE.md](../CLAUDE.md)):新加的持久化能力,repository 只定义 protocol,实现放 `app/infra/`。
4. **测试规矩**:每阶段结束前 `.venv/bin/pytest tests/unit/ -q` 必须 138/138(或更多)全绿。新加节点/端点写对应单测。
5. **不启动 dev server**、不做 UI 联调;前端联调由前端团队接手,后端只保证 SSE/REST 契约按本文件描述产出。
6. **禁用 `--no-verify` 提交**([CLAUDE.md](../CLAUDE.md))。
7. LLM provider 已确认:走 DeepSeek 时 `chat_structured` 必须命中 `json_mode`(参见 [app/providers/openai_format.py](../app/providers/openai_format.py) 的三层兼容阶梯,已就位)。**不要动这个文件的兼容顺序**。

---

## 2. Phase 1 — 全类目上下文持久化(FIRST)

### 2.1 问题现状(代码引用)

后端上下文有效性依赖两个信号,两个都脆弱:

- **`workspace.*Id`** 字段([copilot.py:576–592](../app/api/routes/copilot.py:576)):每轮从前端 `ClientState.activeXxxId` 取。**前端不带,后端就没有**。ClientState 里现有:`activeJdId` / `activeResumeId` / `activeArtifactId` / `activeExperienceIds` / `activeFileId` / `uploadedFileId` / `resumeFileId` / `fileId`。
- **`extracted_params.raw_*_text`** ([router.py:370](../app/graphs/router.py:370) 附近):路由/参数抽取节点在**当轮**用户消息中命中的临时结构化数据。**不落库,下一轮消失**。

各子图读上下文时:
- resume ([resume/nodes.py:40–62](../app/graphs/resume/nodes.py:40)):`extracted_params.raw_jd_text` → 否则 `workspace.jd_id` → 否则空
- context_assembly ([memory/context_assembly.py:95](../app/memory/context_assembly.py:95)):`workspace.jd_id` → 否则空
- 所有子图**从不读 `messages` / `rolling_summary` 里找 JD/resume/artifact/file 的 id**

**典型翻车链**:
1. 用户第 1 轮:粘贴 JD 文本,router 从 message 抽出 `raw_jd_text`,resume 生成正常
2. JD 从未被"导入"为 `jd_records` 一行,因此没有 `jd_id`,`workspace.jd_id=None`
3. 用户第 2 轮:"帮我把简历侧重 SQL",前端 `activeJdId=None`,`extracted_params.raw_jd_text` 也没了
4. 后端 resume 子图看到 `jd_text=None` → 生成时完全丢掉 JD 定位

同样的失败模式适用于:上传的文件(如果前端刷新丢了 `uploadedFileId`)、已经选中的经历子集、当前正在编辑的 artifact。

### 2.2 解决方案(Design)

**核心原则**:thread 建立过任何持久上下文,后端就要能**自己记住**,不依赖前端每轮回传。

采取三条互补动作:

#### 2.2.1 新增 `threads.workspace_snapshot JSONB`

一张表一列,记录该 thread 最近一次**已验证过的 workspace**(即所有 id 都真实存在于对应表)。

Alembic 迁移:`alembic/versions/0012_threads_workspace_snapshot.py`
```sql
ALTER TABLE threads ADD COLUMN workspace_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
```

#### 2.2.2 每轮进入子图前:三方合并 workspace

在 [copilot.py:663–692](../app/api/routes/copilot.py:663) `_build_initial_state` 附近,合并顺序:

```
persisted_snapshot (从 threads.workspace_snapshot 读)
  ← 被 client_state.workspace 覆盖(前端有明确表达的最新意图)
    ← 被本轮 extracted_params 促成的新引用覆盖
```

**never drop keys**:前端不发 `activeJdId` **不意味着**要清空 `workspace.jd_id`。只有明确的 "clear" 信号(如前端发 `activeJdId: ""` 或 payload 有 `"reset": true`)才清。

#### 2.2.3 子图产生持久实体时:回写 snapshot

Resume/JD/Artifact/Experience 每次 create/save,子图 output_node **必须同时把新 id 写回 `threads.workspace_snapshot`**。已经有 `workspace["resume_id"] = resume.id`([resume/nodes.py 附近](../app/graphs/resume/nodes.py))的地方,补一次持久化调用。

**关键**:`raw_jd_text` 若被子图消费(如 resume_generation 用它生成过简历),必须**自动升格为 `jd_records` 一行**并把 `jd_id` 写回 snapshot。这样即便前端从未主动导入 JD,thread 也不会丢。

参考 domain layer 已有的 `services.jd.create_or_update_from_raw_text`(如果没有,新增该方法);升格操作在 resume_generation 的 `persist_resume_draft_node` 或 `context_assembly` 里做,只做一次(有 `raw_jd_text` 且 `workspace.jd_id=None` 才做)。

### 2.3 具体 checklist

- [ ] 迁移 `0012_threads_workspace_snapshot.py`(加列 + 默认 `'{}'::jsonb`)
- [ ] `app/domain/thread/models.py`(如无则新建)—— `ThreadRecord` 加 `workspace_snapshot: dict`
- [ ] `app/domain/thread/repository.py` protocol —— `get_workspace_snapshot(thread_id) -> dict`, `update_workspace_snapshot(thread_id, delta: dict) -> None`(**merge-only,不覆盖**)
- [ ] `app/infra/db/repositories/thread_repo.py` 实现,用 `jsonb || $delta` 做 SQL 层 merge
- [ ] [copilot.py](../app/api/routes/copilot.py) `_workspace_from_client_state` + `_verified_workspace_from_client_state` 改造:先读 snapshot,再 merge client_state,再 merge extracted 派生 id
- [ ] `raw_jd_text → jd_records` 升格:在 resume/artifact/application_package 子图的 `context_assembly` 里,若 `extracted_params.raw_jd_text` 存在且 `workspace.jd_id` 为空,则调 `services.jd.create_or_update_from_raw_text` 创建一行,把新 id 塞回 state 与 snapshot
- [ ] 每个子图产出实体的节点(`persist_resume_draft_node`, `artifact_persist_node`, 现有 experience import 落库处),追加一行 `await thread_repo.update_workspace_snapshot(thread_id, {"<key>": new_id})`
- [ ] 单测:
  - 两轮对话,turn1 只提供 raw_jd_text,turn2 前端 clientState 完全空 → turn2 后端 state 里 `jd_text` 非空,`workspace.jd_id` 非空(说明升格 + 持久化生效)
  - turn1 建了 resume,turn2 clientState 里 `activeResumeId=None`(前端没传) → turn2 后端 workspace.resume_id 依然是 turn1 那个(说明 never drop)
  - turn1 建了 resume,turn3 clientState 明确送 `activeResumeId="another-resume-id"` → turn3 workspace 用新 id(说明 override 仍然生效)
- [ ] 138+ 全绿

### 2.4 非目标(**不要**做)

- 不要从 `rolling_summary` / `messages` 里用 LLM 去"猜"当前上下文 —— 太脏太不稳,回归价值低
- 不要在 Phase 1 里加"版本历史"、"上下文时间线可视化"这种前端能力 —— 那是 Phase 3 之后的事
- 不要动 rolling_summary 的压缩节奏 —— 与本次问题正交
- 不要动 SSE 事件类型 —— Phase 1 内部改造为主,不改对外契约

### 2.5 验收

- 上述单测全绿
- 手工跑一次:tunnel 里连真库,curl 一次 `POST /copilot/chat/stream` 建立 JD,再发一条与 JD 无关的话("你好"),然后第三条"生成简历",观察 SSE 里 resume_review interrupt 的 `resume.structured` 明显针对第一条 JD 而非空生成
- Grep 一次 `git diff` 确认没有反向 import(下层不 import 上层)

---

## 3. Phase 2 — 画布决定性 Patch(Tier 1,SECOND)

### 3.1 目标

用户在简历画布(前端)里对某条 bullet / 某个 item 做**确定性编辑**(改文字、重排、删除、新增空白项),**不进对话流**,不消耗 LLM tokens,秒改秒回。

### 3.2 契约

**新增端点**:`PATCH /product/resumes/{resume_id}/variants/{variant_id}/structured`

**Request body**:一批 op(顺序执行,任意一 op 失败整批回滚):
```jsonc
{
  "operations": [
    { "op": "replace_bullet", "bullet_id": "bul-xxx", "text": "新文本" },
    { "op": "delete_bullet",  "bullet_id": "bul-yyy" },
    { "op": "add_bullet",     "item_id": "item-xxx", "text": "新增 bullet 文本", "after_bullet_id": "bul-zzz" | null },
    { "op": "reorder_bullets", "item_id": "item-xxx", "bullet_ids": ["bul-a", "bul-b", "bul-c"] },
    { "op": "replace_item_field", "item_id": "item-xxx", "field": "title" | "organization" | "role" | "start_date" | "end_date" | "raw_text", "value": "..." },
    { "op": "delete_item",    "item_id": "item-xxx" },
    { "op": "add_item",       "section_id": "sec-xxx", "item": {...}, "after_item_id": "item-yyy" | null },
    { "op": "reorder_items",  "section_id": "sec-xxx", "item_ids": ["item-a", ...] },
    { "op": "replace_section_field", "section_id": "sec-xxx", "field": "heading", "value": "..." },
    { "op": "reorder_sections", "section_ids": ["sec-a", "sec-b", ...] }
  ]
}
```

**Response**:整份新 `structured` + 新渲染的 `content` markdown,以及一个自增 `version` 供 optimistic update 对齐。

```jsonc
{
  "success": true,
  "data": {
    "variant_id": "variant-xxx",
    "structured": { ... },
    "content": "...",
    "version": 3
  }
}
```

### 3.3 关键实现点

- **id 稳定**:所有 op 只按 id 定位,不做名称/文本匹配。新增 bullet/item 分配新 `bul-<uuid>` / `item-<uuid>`,其他 id 一律**保持原样不动**。
- **ownership 校验**:通过 `services.resume.get_variant(user_id, variant_id)` 拉数据,拒绝跨 user 访问。
- **原子性**:操作在内存里对 structured 做完整批修改,全成功才 UPDATE 数据库;任何一 op 报错整体 409 或 422,不落 partial。
- **markdown 派生**:复用 [resume/nodes.py:_render_structured_to_markdown](../app/graphs/resume/nodes.py) 生成新 `content`,不要写第二套渲染器。
- **不重跑 fact_check / coverage_check**:用户手动改,后果自负;这些校验只在生成时跑。
- **不发 SSE**:REST 请求,同步返回,不走 SSE。前端要 broadcast 到多设备可以后续加,不属于 Phase 2 scope。
- **版本历史**:每次 PATCH 追加一条 `resume_variants` 新行,`parent_variant_id` 指向本次修改的 variant。**需要在 `resume_variants` 加一列 `parent_variant_id TEXT NULL REFERENCES resume_variants(id) ON DELETE SET NULL`**(迁移 `0013`)。

### 3.4 具体 checklist

- [ ] 迁移 `0013_resume_variants_parent.py`:加 `parent_variant_id` 列
- [ ] `app/domain/resume/models.py`:`ResumeVariant` 加 `parent_variant_id: str | None = None`
- [ ] `app/infra/db/repositories/resume_repo.py`:读写新列
- [ ] `app/domain/resume/service.py`:新方法 `patch_variant(user_id, variant_id, operations) -> ResumeVariant`
- [ ] `app/domain/resume/patch.py`(新建):**纯函数**,输入 `structured + operations`,输出 `structured'`,domain 层零框架依赖
- [ ] 路由:`app/api/routes/product/resume.py`(或对应位置)新加 `PATCH /variants/{variant_id}/structured` 端点
- [ ] 单测(domain 层):
  - 每个 op 类型的 happy path
  - 未知 bullet_id / item_id / section_id → 明确 error
  - `reorder_bullets` 若 `bullet_ids` 与实际集合不一致(缺 id / 多 id / 重复 id)→ error
  - id 稳定性:改 1 条 bullet 文本,其他 20 个 id 全部保持原值
- [ ] API 层测试:ownership 拒绝 + 原子性(mid-batch 失败不 partial)

### 3.5 非目标

- 不加"多人协作"、CRDT、乐观锁冲突 UI —— 单人使用够用
- 不加 SSE 广播 —— 用户在同一 tab 编辑,response 直接更新
- 不加 undo/redo 端点 —— 前端可以自己在本地实现历史堆栈,或者用 `parent_variant_id` 链做回退,不需要 dedicated 端点

### 3.6 验收

- 单测全绿
- 手工:先跑一次简历生成 → interrupt payload 里拿到 `variant_id` → 挑一个 `bul-xxx` → curl PATCH → 断言响应 `structured` 里指定 bullet 的 `text` 变了、id 没变、其他 id 一个不缺

---

## 4. Phase 3 — 对话式编辑(Tier 2 + Tier 3,THIRD)

### 4.1 目标

用户在对话里说自然语言的编辑指令,后端识别意图 → 定位目标 → 修改 → 回画布。

- **Tier 2(小改)**:"把 WEEX 那条第二个 bullet 改得更强调 SQL 脚本量" → LLM 只定位 `bul-xxx` + 生成新文本,后端复用 Phase 2 的 patch 引擎落地
- **Tier 3(大改)**:"整体语气改得更正式"、"缩短到一页"、"加一个 leadership section" → 走既有 resume_generation 子图,但把当前 `structured` 作为 grounding 传入 draft prompt

### 4.2 契约

**不新增对外端点**,复用 `POST /copilot/chat/stream`。Router 新增意图 `edit_resume`,新增子图 `resume_edit`。

`agent.interrupt` 载荷类型新增:
```jsonc
{
  "type": "resume_edit_review",       // Tier 3 触发;Tier 2 可选择直出无 interrupt
  "resume": { ... 完整 structured + content },
  "diff": {
    "changed_bullet_ids": ["bul-xxx", ...],
    "changed_item_ids": [...],
    "changed_section_ids": [...],
    "added_ids": [...],
    "removed_ids": [...]
  },
  "action_options": [...]
}
```

### 4.3 关键实现点

**Router 判定**([router.py](../app/graphs/router.py)):
- `workspace.resume_id` 非空 + 用户消息含"改"、"换"、"再加一条"、"侧重"、"更…"、"缩短"、"精简"等词汇 → `edit_resume`
- 前端也可以显式在 clientState 加 `editingScope: "bullet"|"section"|"global"` 直接强路由

**Tier 判定(在 `resume_edit` 子图的第一个节点 `edit_classify_node`)**:
- 小 LLM 输出 `{tier: 1|2|3, target_kind: "bullet"|"item"|"section"|"global", target_id?: string}`
- Tier 1(明确 id + 明确改动)→ 直接调 Phase 2 patch 引擎,不再走 LLM 生成新文本 — 常见于前端把某个 bullet 高亮 + 说"改这条"
- Tier 2 → `locate_node` 输出精确 target_id + 新内容 → `apply_node` 调 patch 引擎
- Tier 3 → 打包"用户指令 + 当前 structured"作为 `revision_instruction`,走一遍 `resume_generation` 主链(复用 fact_check / coverage_check / self_review)

**id 稳定策略(Tier 3 关键)**:
- 在 `_assign_structure_ids` 里增加"若 item 有 `source_experience_id` 且旧 structured 有同 `source_experience_id` 的 item,复用旧 item id 与其 bullet id"
- 新增 bullet 走新 uuid
- 前端做 diff 高亮就靠这套 id 稳定性

**Tier 2 是否走 interrupt**:
- 默认**不走 interrupt**:改动小、可回滚(通过 Phase 2 的 parent_variant_id)、增加对话延迟无益
- 前端可以在 clientState 里加 `requireReviewBeforeApply: true` 强制走 interrupt
- Tier 3 **强制走 interrupt**,因为改动面大

### 4.4 具体 checklist

- [ ] `app/graphs/resume/edit/` 新目录:`graph.py` + `nodes.py` + `state.py`
- [ ] `edit_classify_node` — chat_structured,schema `EditClassification`
- [ ] `locate_node` — chat_structured,schema `EditLocation`(必须验证 target_id 存在于当前 structured)
- [ ] `apply_node` — 调 Phase 2 的纯函数 patch 引擎
- [ ] Tier 3 分支 — 复用 `resume_generation` 图但传入 `previous_structured` + `edit_instruction`
- [ ] [graphs/main.py](../app/graphs/main.py) 挂载 `resume_edit` 子图
- [ ] Router 新增意图 `edit_resume`([graphs/router.py](../app/graphs/router.py))
- [ ] `AgentInterruptEvent` 新增 `"resume_edit_review"` 类型
- [ ] `_assign_structure_ids` id 复用逻辑
- [ ] 单测:
  - Tier 1 一键改 bullet(前端直接给 id + text)→ 直路径,无 LLM 调用
  - Tier 2 "把 WEEX 那条第 2 条改成 X" → locate 命中真实 bullet_id + 应用后其他 id 全稳
  - Tier 3 "整体语气更正式" → 走 resume_generation,产出新 structured,fact_check/coverage_check 都跑过,大量 id 复用
  - 边界:workspace.resume_id 为空却触发 edit_resume 意图 → 明确 error,不生成 phantom variant

### 4.5 非目标

- 不做"多份简历并行编辑"、tab 切换 —— 一个 thread 只对应一份 active resume
- 不做 collaborative editing / OT / CRDT
- 不做 "AI 建议修改" 主动 push —— 只响应用户请求

### 4.6 验收

- 单测全绿
- 手工:
  1. 生成一份简历 → interrupt accept → 拿到 resume_id
  2. 对话说"把 WEEX 那条的第二个 bullet 改成强调 SQL 脚本数量" → SSE 里应出现 `content.diff.*` 或 `resume_edit_review` interrupt,新 structured 里 WEEX 那条第 2 bullet 文本变了,其他 id 全稳
  3. 对话说"整体太长了,砍到一页" → 走 Tier 3,interrupt 载荷有 `diff.removed_ids`,accept 后 `resume_variants` 新增一行 `parent_variant_id=上一版`

---

## 5. 已完成的相关工作(供参考,别重做)

本次会话已经完成的、下游工作应该**假设已存在**的改动:

- 实习/项目 各类 category 至少 1 条 + 教育穷尽 + section 内按 end_date DESC + bullet 数按 JD-match tier 分档 → 见 [resume/nodes.py:R1–R4 硬规则](../app/graphs/resume/nodes.py) 与 `_check_experience_composition`、`_item_recency_key`
- 经历数据链路补全:RAG SQL 补 `category`/`role`/`start_date`/`end_date`/`tags` 字段,新增 `retrieve_by_category` 用于教育无 top_k 全量捞
- Context 装配放宽:`top_k=8→20`,教育独立并入,`_trim_context` 的 `limit=8→25`;`_trim_dict_items` 从贪心改为按长度 ASC 公平分配
- `context_token_budget: 6000→16000`([config.py](../app/core/config.py))
- **DeepSeek 兼容**:`OpenAIFormatProvider.chat_structured` 三层阶梯(json_mode → json_schema → prompt-fallback),`_chat_structured_via_json_prompt` 去掉 `max_tokens=2000` 硬帽

这些改动的完整背景在 [docs/backend-interface-changes-2026-07-14.md Part 5 之后的对话记录](backend-interface-changes-2026-07-14.md)(未持久化,以本次 git log 与代码为准)。

---

## 6. 开始下一段对话时,请复述以下承诺后再动手

1. "我理解 phase 1 → phase 2 → phase 3 顺序推进,不并行,不跨阶段乱改"
2. "我不会破坏 `sec-*/item-*/bul-*` id 的跨编辑稳定性"
3. "我不会做本文件 §2.4 / §3.5 / §4.5 明确列为非目标的事"
4. "我每阶段结束都跑 `.venv/bin/pytest tests/unit/ -q` 并保持全绿"
5. "我不会 `git commit --no-verify`,遇到 pre-commit 失败就 fix underlying"

准备好后再动手。祝顺利。
