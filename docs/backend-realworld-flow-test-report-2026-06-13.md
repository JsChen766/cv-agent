# 后端真实链路实测报告（2026-06-13）

## 1. 测试环境

- 后端地址：`http://localhost:3000`
- 测试用户：`test-realworld-20260613114517`
- Docker：脚本运行前由当前 shell 确认并使用运行中的 `coolto-agent-api` / `coolto-postgres` 服务；若服务未运行，需要先在 `E:\vsProjects\cv-agent` 执行 `docker compose up -d postgres api`。
- Auth：后端 Docker env 为 dev header 模式，脚本使用 `x-user-id`，未写入或展示密钥。
- Provider：使用后端当前配置；报告不包含 API key / DB URL。
- 开始/结束：`2026-06-13T03:45:17.691414+00:00` / `2026-06-13T03:45:59.678765+00:00`

## 2. 前端接口地图

| 区域 | 前端调用位置 | Method | URL | Payload | Response | 流式 | 特殊信息/任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chat | `src/services/copilotApi.ts; src/stores/chat.ts` | POST | `/copilot/chat` | CopilotChatInput: { sessionId?, message, resumeText?, jdText?, targetRole?, clientState? } | ApiEnvelope<CopilotChatResponse> | no | assistantMessage, workspace, nextActions, raw.pendingActions/actionResults/toolResults, agentRoomEvents |
| chat-stream | `src/services/copilotStreamApi.ts; src/stores/chat.ts` | POST | `/copilot/chat/stream` | CopilotChatInput; Accept: text/event-stream; frontend sends no Idempotency-Key | SSE events: agent.* plus completed CopilotChatResponse | yes | pending_action_created, workspace_updated, tool_result_summary, completed response |
| copilot-action | `src/services/copilotApi.ts; src/stores/chat.ts; src/features/actions/*Handlers.ts` | POST | `/copilot/actions` | CopilotActionInput: { sessionId, turnId?, action: { type, variantId?, payload? }, clientState? } | ApiEnvelope<CopilotChatResponse> | no | actionResult, pending action, variant/resume/export workspace changes |
| pending-action | `src/services/pendingActionApi.ts; src/stores/chat.ts; PendingActionCard/DecisionPanel` | GET/POST | `/copilot/pending-actions, /copilot/pending-actions/:id, /confirm, /cancel` | confirm/cancel body: {} | PendingAction[] \| PendingAction \| CopilotChatResponse with meta.confirmStatus | no | confirmation card lifecycle, pendingActionId, confirmStatus |
| experience | `src/services/productApi.ts; ExperienceLibraryView.vue; ExperienceDetailView.vue` | GET/POST/PATCH | `/product/experiences, /product/experiences/:id, /revisions, /variants` | title/content/category/organization/role/dates/tags/structured; revisionId/content/variantType | ProductExperience \| { experience, revision } \| ProductExperienceDetail | no | experience asset ids; can feed special decision cards through copilot save flow |
| jd | `src/services/productApi.ts; JDLibraryView.vue; JDDetailView.vue` | GET/POST | `/product/jds, /product/jds/:id` | { rawText, title?, company?, targetRole? } | ProductJDRecord | no | jdId for generation and workspace state |
| resume-generation | `src/services/productApi.ts; chat store pollGenerationJobUntilReady` | GET/POST | `/product/generations/from-jd, /product/generations/:id, /accept-variant` | from-jd: { jdId? jdText? targetRole? }; accept: { variantId, resumeId? } | { generationId, jd, variants, generation } \| ProductGenerationDetail \| AcceptVariantResponse | no | generationId, variants, accepted resumeId |
| jobs | `src/services/jobApi.ts; src/stores/chat.ts` | GET/POST | `/jobs, /jobs/:id, /jobs/:id/cancel` | create: { type, input?, runAfter? }; poll: none | BackgroundJob | no | jobId, status, progress, output.generationId |
| exports | `src/services/exportApi.ts; src/stores/chat.ts; ExportReceipt.vue` | GET/POST/DELETE | `/exports/resumes/:resumeId, /exports/:id, /exports/:id/render, /exports/:id/download` | create: { format, templateId? }; render body: {}; download raw arraybuffer | CreateExportResponse \| ResumeExport \| binary/html raw response | no | export_receipt, job_status_strip, exportId, jobId, downloadUrl |

### pendingActionId / 生成按钮获取路径

- 前端不会只从首次 `/copilot/chat` 响应里等 `pendingActionId`。JD 分析卡片会先读取 `nextActions`，把 `actionType=generate_resume` 转成 `ProductAction(type=generate_from_jd)`，然后通过 `chat.runAction()` 调 `/copilot/actions`。
- `pendingActionId` 的主要来源顺序按前端实现对齐：`raw.pendingActions[].id`、`raw.primaryActionResult.pendingActionId`、`raw.actionResults[].pendingActionId`，再补读 assistant metadata / displaySnapshot / productBlocks 中的 pending action。
- 因此链路 3 的测试序列是：`POST /copilot/chat` 获取 JD 分析/按钮 -> `POST /copilot/actions` 点击生成 -> `POST /copilot/pending-actions/:id/confirm` 确认。链路 4 复用链路 3 的真实 pendingActionId 做重复确认。

## 3. 测试链路结果

| 链路 | 结果 | 失败/告警 | 关键步骤摘要 |
| --- | --- | --- | --- |
| 环境探测：health/docs/root | WARN/FAIL | GET /docs: Route GET:/docs not found; GET /: Route GET:/ not found | GET /health: HTTP 200; status=ok<br>GET /docs: HTTP 404; {"error": "Not Found", "message": "Route GET:/docs not found", "statusCode": 404}<br>GET /: HTTP 404; {"error": "Not Found", "message": "Route GET:/ not found", "statusCode": 404} |
| SSE 探测：/copilot/chat/stream | PASS | - | POST /copilot/chat/stream: HTTP 200; SSE events: agent.completed=1, agent.message.completed=1, agent.reasoning.snapshot=1, agent.route.completed=1, agent.route.started=1, agent.thinking=2, agent.turn.started=1, agent.workspace.updated=1 |
| 链路 1：普通聊天链路 | PASS | - | 普通问候: HTTP 200; sessionId=cs-2b12e6ff-d39b-482a-9f66-0a9f4ecaf2df; turnId=ct-0c30ea88-d415-4e2a-a8be-c26f5f780fce; assistant=我是你的求职经历 Copilot，可以帮你整理经历、分析 JD、生成和修改简历。; workspace.status=empty; variants=0 |
| 链路 2：没有 JD 但要求生成简历 | PASS | - | 无 JD 请求生成: HTTP 200; sessionId=cs-9d3b6296-4ef9-4146-8dde-a3707e24c157; turnId=ct-844ea880-2240-4d97-a82a-0759b25218aa; assistant=请问你想基于什么来生成简历？你可以提供一份 JD，或者指定已有的经历。; workspace.status=empty; variants=0<br>补充 JD: HTTP 200; sessionId=cs-9d3b6296-4ef9-4146-8dde-a3707e24c157; turnId=ct-96b2d66f-c1f6-430b-adc5-972ae1c94bc3; assistant=我已准备好保存这份 JD，请确认后写入 JD 库。; workspace.status=empty; variants=0 |
| 链路 3：提供 JD 后要求生成简历 | PASS | - | 明确 JD 请求生成: HTTP 200; sessionId=cs-b9c09a8d-3810-4417-a0c9-0f6ca88ac7e3; turnId=ct-c7d0da18-2aba-4c5d-8b84-dc18186ef053; assistant=我已识别到这是一份【数据分析实习生】相关 JD。你可以让我保存到 JD 库、分析岗位要求，或基于它生成定制简历。; workspace.status=empty; variants=0<br>前端点击生成简历 action (jdAnalysis.nextActions.generate_resume): HTTP 200; sessionId=cs-b9c09a8d-3810-4417-a0c9-0f6ca88ac7e3; turnId=ct-b428842a-44ce-473a-8941-d7cf87ef3d3c; assistant=我已准备好基于这份 JD 生成简历版本，请确认后开始。; workspace.status=empty; variants=0<br>确认生成: HTTP 200; sessionId=cs-b9c09a8d-3810-4417-a0c9-0f6ca88ac7e3; turnId=ct-b428842a-44ce-473a-8941-d7cf87ef3d3c; assistant=Resume generation has started. I will update the result when the background job completes.; workspace.status=generating; variants=0 |
| 链路 4：确认按钮重复点击 / 幂等性 | PASS | - | 重复确认前查询 pending action: HTTP 200; sessionId=cs-b9c09a8d-3810-4417-a0c9-0f6ca88ac7e3; turnId=ct-b428842a-44ce-473a-8941-d7cf87ef3d3c; id=pa-076a8250-0d25-4b45-885d-fa36581a03f9; status=confirmed; title=Generate resume from JD after confirmation.<br>同一 Idempotency-Key 第一次 confirm: HTTP 200; sessionId=cs-b9c09a8d-3810-4417-a0c9-0f6ca88ac7e3; turnId=ct-b428842a-44ce-473a-8941-d7cf87ef3d3c; assistant=Resume generation has started. I will update the result when the background job completes.; workspace.status=generating; variants=0<br>同一 Idempotency-Key 第二次 confirm: HTTP 200; sessionId=cs-b9c09a8d-3810-4417-a0c9-0f6ca88ac7e3; turnId=ct-b428842a-44ce-473a-8941-d7cf87ef3d3c; assistant=Resume generation has started. I will update the result when the background job completes.; workspace.status=generating; variants=0<br>新 Idempotency-Key 重复 confirm: HTTP 200; sessionId=cs-b9c09a8d-3810-4417-a0c9-0f6ca88ac7e3; turnId=ct-b428842a-44ce-473a-8941-d7cf87ef3d3c; assistant=Resume generation has started. I will update the result when the background job completes.; workspace.status=generating; variants=0<br>重复确认后查询 pending action: HTTP 200; sessionId=cs-b9c09a8d-3810-4417-a0c9-0f6ca88ac7e3; turnId=ct-b428842a-44ce-473a-8941-d7cf87ef3d3c; id=pa-076a8250-0d25-4b45-885d-fa36581a03f9; status=confirmed; title=Generate resume from JD after confirmation. |
| 链路 5：Variant 生成与选择链路 | PASS | - | 直连生成 Variant: HTTP 200; variants=1<br>选择 Variant: HTTP 200; {"generation": {"createdAt": "2026-06-13T03:45:55.684Z", "id": "pgen-acf19205-1dd6-47ab-925e-92aeae0ac568", "inputSnapshot": {"jdId": "pjd-079968cc-8d27-4c24-a520-8d104cd5501e", "sourceExperienceIds": [], "targetRole"...<br>重复选择同一 Variant: HTTP 200; {"generation": {"createdAt": "2026-06-13T03:45:55.684Z", "id": "pgen-acf19205-1dd6-47ab-925e-92aeae0ac568", "inputSnapshot": {"jdId": "pjd-079968cc-8d27-4c24-a520-8d104cd5501e", "sourceExperienceIds": [], "targetRole"...<br>前端 action 形态选择 Variant: HTTP 200; sessionId=cs-b9c09a8d-3810-4417-a0c9-0f6ca88ac7e3; turnId=ct-5b1fd43e-d6a6-4df1-bcb4-aeb71160c065; assistant=The selected asset conflicts with the active workspace. Please choose the target again.; workspace.status=ready; generationId=pgen-148eea9c-6b2d-4685-b3af-34c812746726; variants=1<br>重复前端 action 形态选择 Variant: HTTP 200; sessionId=cs-b9c09a8d-3810-4417-a0c9-0f6ca88ac7e3; turnId=ct-3e511e77-3df6-4211-9827-2afc050fc203; assistant=The selected asset conflicts with the active workspace. Please choose the target again.; workspace.status=ready; generationId=pgen-148eea9c-6b2d-4685-b3af-34c812746726; variants=1 |
| 链路 6：经历导入 / 经历入库链路 | PASS | - | 聊天提交经历: HTTP 200; sessionId=cs-9968a9df-76d4-4350-93b5-38cc1e469c91; turnId=ct-a32d1f2e-0515-4c98-acd7-acaf4b2ffa01; assistant=我是你的求职经历 Copilot，可以帮你整理经历、分析 JD、生成和修改简历。有什么我可以帮你的？; workspace.status=empty; variants=0<br>直连创建 test 经历: HTTP 200; {"experience": {"category": "internship", "createdAt": "2026-06-13T03:45:58.262Z", "currentRevisionId": "pexprev-9cfde36a-ca8a-4e07-9612-a9cfe035d8bc", "endDate": "2026-04", "id": "pexp-19e8f9c5-db65-4fcf-81aa-3995723...<br>确认经历可查: HTTP 200; variants=0 |
| 链路 7：经历库查看 / 编辑链路 | PASS | - | 经历列表: HTTP 200; list[1]<br>经历详情: HTTP 200; variants=0<br>编辑保存经历: HTTP 200; {"experience": {"category": "internship", "createdAt": "2026-06-13T03:45:58.262Z", "currentRevisionId": "pexprev-6efdb857-1700-449c-bbcc-525d901f5f5f", "endDate": "2026-04", "id": "pexp-19e8f9c5-db65-4fcf-81aa-3995723...<br>保存后再次查询: HTTP 200; variants=0 |
| 链路 8：简历生成后的轮询与下载链路 | PASS | - | 查询生成详情: HTTP 200; id=pgen-acf19205-1dd6-47ab-925e-92aeae0ac568; targetRole=数据分析实习生; variants=1<br>导出前 jobs 列表: HTTP 200; list[1]<br>创建 HTML 导出: HTTP 200; job=job-216e291f-c399-4e89-80e0-f599bb8c81a2:pending; export=export-4154fdac-0091-4738-9f79-673446e1e338:pending<br>轮询导出 job #1: HTTP 200; id=job-216e291f-c399-4e89-80e0-f599bb8c81a2; status=pending<br>轮询导出 job #2: HTTP 200; id=job-216e291f-c399-4e89-80e0-f599bb8c81a2; status=completed<br>查询导出记录: HTTP 200; id=export-4154fdac-0091-4738-9f79-673446e1e338; status=completed<br>... +3 steps |

## 4. 重复问题清单

- 未发现脚本规则可判定的重复确认 / 重复 Variant / 重复任务。

## 5. 最小复现请求序列

### 环境探测：health/docs/root

1. `GET /health`
   - response: HTTP `200`; status=ok
1. `GET /docs`
   - response: HTTP `404`; {"error": "Not Found", "message": "Route GET:/docs not found", "statusCode": 404}
1. `GET /`
   - response: HTTP `404`; {"error": "Not Found", "message": "Route GET:/ not found", "statusCode": 404}

## 6. 根因初步判断

- 前端真实调用入口集中在 `src/services/*Api.ts`，其中聊天和 action 的状态推进依赖 `src/stores/chat.ts` 的 `applyCopilotResponse`、`confirmPendingAction`、`pollGenerationJobUntilReady`、`exportResume`。
- 后端可能相关模块：`src/api/routes/copilot.ts`、`src/api/routes/pendingActions.ts`、`src/api/idempotency.ts`、`src/api/sessionLock.ts`、`src/agent-core/confirmation/PendingActionService.ts`、`src/agent-core/events/AgentRoomEventProjector.ts`、`src/copilot/CopilotOrchestrator.ts`、`src/api/routes/product/generationRoutes.ts`、`src/api/routes/exports.ts`、`src/exports/ResumeExportService.ts`。
- 若同一 pendingAction 在确认后仍回到 `needs_confirmation` 或 pending card，优先查 `PendingActionService.confirm()` 的 terminal result 缓存、`runtimeConfirm` 的 response projection，以及 frontend `finalizeConfirmedPendingAction()` 是否收到旧 pendingActions。
- 若 Variant 选择后同一组 variants 重复出现，优先查 `accept_generation_variant` 工具输出、workspace selected/accepted 状态持久化、`AgentRoomEventProjector` 对 `variant_compare_board` 的投影条件。
- 若 polling/download 创建新 job，优先查 `ResumeExportService.createExport()` 与 `/exports/:id/download`、`/jobs/:id` 的职责分离；poll/download 理应只读现有记录。

## 7. 修复建议 / TODO

1. 为保存、确认、选择类业务动作保留业务级 processed action 记录：key 建议包含 `userId + sessionId + pendingActionId/action.type + canonical resource id`，重复提交返回当前状态或 lastResult。
2. `confirm card` 只在 pending action 状态为 `pending` 时投影；`confirmed/executed/failed` 应投影为 actionResult 或状态条，不再生成可点击确认卡。
3. Variant 接受后持久化 `selectedVariantId/acceptedVariantId`，`variant_compare_board` 投影层应检查已 accepted 状态，避免再次要求选择。
4. special message 统一生成稳定 `id`，建议使用 `sourceType:resourceId:eventKind` 指纹，方便前端去重。
5. `task create`、`job poll`、`download` 三类接口继续保持职责分离，并为 poll/download 加回归测试，确保不会调用 create path。
6. 对 `/copilot/actions` 的 `accept`/`prefer`/`show_evidence` 增加重复提交测试，覆盖不同 Idempotency-Key 下的业务幂等。

