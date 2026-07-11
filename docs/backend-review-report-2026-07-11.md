# 后端 Review 与修复报告（2026-07-11）

## 范围与约束

本轮覆盖 LLM Provider、意图路由、自由工具调用、上下文装配、滚动记忆、经历库、JD 库、Evidence/Guideline RAG、LangGraph 状态与中断、SSE、Repository 分页、鉴权边界、文件上传安全、分层依赖和静态质量。

所有现有 HTTP 请求/响应字段及 SSE 事件名称保持不变。行为层面的安全修正包括：跨用户 workspace 引用现在会被已有的 403/404 错误 Contract 拒绝；缺少正文的“保存 JD/经历”会进入澄清，而不会保存一条无效记录。

## 本轮已修复

### LLM、意图识别与回复自主性

- Router 仍以当前消息为最高优先级，但现在会利用历史消息解析“改成英文版”等省略式追问，不再机械忽略前文。
- 明确区分 JD 入库流和 JD 查询流；“列出我的 JD”等请求由 open-ended Agent 调用只读工具，“保存 JD”才进入 JD 子图。
- 对只有“帮我保存一个 JD/经历”而没有正文的请求直接澄清，避免制造垃圾数据和无意义确认中断。
- Router 的 0.55/0.70 confidence 阈值从 prompt 建议变为代码级约束，低置信专业路由会稳定降级到 clarify/open-ended。
- open-ended Agent 改为标准 `assistant(tool_calls) -> tool(tool_call_id) -> assistant` 消息链，工具结果不再伪装成 user 消息，提升多轮工具调用稳定性。
- OpenAI/Anthropic structured output 现在实际应用调用方传入的 temperature；流式调用中的迟发异常统一包装为外部服务错误。
- Provider 层不再反向依赖 tools 层；工具 schema 序列化下沉到 Provider 自身模块，并增加架构边界测试。
- 增加独立 `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` 配置，解决 Anthropic 聊天 + OpenAI-compatible embedding 混用时误用 Anthropic key 的问题。
- 显式 Artifact Action 和 Resume-from-JD Tool 现在会装配当前用户的 JD、经历、偏好、语言等上下文，不再只凭一句 instruction 生成。

### 上下文拼接与长对话记忆

- `context_token_budget` 从“读取但不执行”改为在写入图状态前做确定性裁剪，所有下游 prompt 都受预算约束。
- Guideline RAG 从固定返回空列表改为真实向量检索，并在无向量/无结果时使用安全的 `plainto_tsquery` 全文回退。
- 上下文中的 JD、Profile、Preference 全部通过 Domain Service 获取；JD workspace ID 会执行用户所有权校验。
- 新增长对话增量滚动摘要：只压缩尚未总结的旧消息，持久化 summary、已总结消息数和 turn count；摘要失败时保留最近 20 条原始消息，不再丢上下文。
- 新增迁移 `0009_thread_rolling_memory.py`。

### 经历库、Evidence RAG 与简历 Grounding

- 创建经历和新增 revision 后自动触发向量与 claim 索引；索引失败不会回滚已经成功的业务写入，并会留下 warning。
- claim 持久化到 `experience_revisions.claims`，旧数据在第一次检索时按需补齐且不会反复抽取空 claim。
- Evidence RAG 在无 pgvector/无向量结果时回退到当前用户最近经历，始终带 `user_id` 过滤。
- requirement-to-claim 匹配按真实余弦相似度排序并计算分数，不再用“命中条数/3”冒充相似度。
- 简历生成 prompt 显式注入 verified evidence mapping，并把 evidence summary、coverage score 和 missing-evidence risk 写入 Resume Variant。
- 经历搜索现在同时覆盖 title、organization、role 和当前 revision content。
- 经历确认后先校验全部日期再开始任何写入，避免第二条数据非法时第一条已被部分保存。
- discard/空候选会直接结束子图，不再被后续 save 节点覆盖成 “Saved 0 experiences”。
- 新增迁移 `0008_experience_revision_claims.py`。

### JD/经历/简历/Artifact 获取与分页

- `list_jds` 工具原有的 `q`、`company` 参数不再被忽略，已贯通 Tool → Service → Repository。
- 修复四类 Repository 的 cursor 条件与排序不一致问题；cursor 字符串 Contract 保持原样，内部改为基于 `(timestamp, id)` 的稳定分页。

### LangGraph 状态、中断与 SSE

- Resume 重生成不再把 `review_iteration` 重置为 0，Self-Review 的三轮上限现在真实生效，不会无限循环。
- Resume Review 的 `revise` 决策现在会把用户反馈接回生成、自审、持久化和下一次 Review interrupt，不再只回复“已收到”后结束。
- Resume 写 variant 前再次校验 workspace resume 的用户所有权，防止客户端伪造 `activeResumeId` 写入他人简历。
- 聊天和 Product Action 入口实际接入已有 `workspace_builder`，所有 JD/Resume/Artifact/Experience 引用先校验归属。
- SSE 对节点累计返回的 `pending_sse_events` 只发送新增后缀，修复 route/tool/message 事件重复推送。
- 增加主图到子图的参数保真测试，覆盖 `extracted_params`、workspace 和 assistant output 的往返。
- 修复中断 ID 的严格类型收窄，mypy 不再依赖无效 ignore。

### 安全、可靠性与代码质量

- 修复上传文件名路径穿越；存储层同时净化 Windows/Unix 路径分隔符并校验最终路径不越界。
- 上传接口最多读取 `MAX_FILE_SIZE + 1`，不再先把任意大文件全部载入内存。
- DOCX 增加成员数和解压后总体积限制，降低 zip bomb 风险。
- 生产环境启动时强制要求有效 `SECRET_KEY`、数据库连接、持久化 checkpointer，并拒绝 credentials + wildcard CORS。
- 登录 Cookie 的 `Secure` 和有效期与环境/config 对齐，注册与登录共用一处 Cookie 设置逻辑。
- 工具注册表拒绝静默覆盖同名工具，避免扩展时出现不可见行为替换。
- 新增自动化架构测试：core 不依赖上层、domain 无框架/infra 依赖、graphs/tools 不直连 infra、providers 不反向依赖 tools。
- 清理 Ruff/Mypy 已发现的问题；删除过期 ignore，修复 Provider 构造参数类型。
- 删除 Compose 已废弃的顶层 `version` 字段。

## 验证结果

- `pytest`: **253 passed**（修复前 222 passed）
- `ruff check app tests`：通过
- `mypy app --strict`：通过，137 个源码文件 0 error
- 覆盖率采样：约 **58%**；新增关键回归覆盖 Router、滚动摘要、上下文预算、RAG、经历导入、主/子图状态、工具消息链、workspace 所有权、文件路径安全和显式 Action grounding
- Alembic：单一 head `0009`
- `git diff --check`：通过
- 外部 Contract 测试、安全矩阵测试、OpenAPI 测试全部随全量测试通过

## 部署要求

部署本轮代码前必须执行：

```bash
alembic upgrade head
```

本机 Docker daemon 未运行，因此本轮没有对真实 PostgreSQL/pgvector 和真实 LLM Provider 做在线集成验证；迁移链、Repository 行为和 Provider 行为已通过静态检查与 mock 回归验证。

## 保留的技术债与建议顺序

1. `app/api/routes/copilot.py` 与 `threads.py` 仍然过大且包含较多 SQL/编排逻辑。为避免本轮扩大 Contract 风险，只抽离了 Provider schema 和上下文职责；下一轮应建立 Thread/Message Domain Service + Repository 后再瘦身路由。
2. 总覆盖率约 58%，主要缺口集中在 PostgreSQL Repository、真实 Provider、checkpointer 和 API 中断并发路径。建议增加 Testcontainers/PostgreSQL + pgvector 集成测试，并把核心模块门槛逐步提升到 80%。
3. 项目历史文件尚未统一采用 `ruff format`；全仓检查会重排约 89 个文件。建议单独做纯格式化提交，避免与功能修复混合。
4. 测试栈仍有 Starlette `TestClient` / `httpx` 弃用 warning，建议按依赖兼容矩阵迁移到 `httpx2`。
5. 旧经历的 claim/embedding 当前采用懒回填。数据量增大后应增加一次性后台 backfill 命令和可观测进度。
6. 登录、注册和高成本 LLM 端点尚无跨实例限流；生产环境应在网关或 Redis-backed limiter 中补齐，而不是使用不一致的进程内计数器。
