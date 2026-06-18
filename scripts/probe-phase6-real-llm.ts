import { randomUUID } from "node:crypto";

const baseUrl = (process.env.PHASE6_API_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const userId = process.env.PHASE6_USER_ID || `phase6-real-llm-${Date.now()}`;
const timeoutMs = Number(process.env.PHASE6_TIMEOUT_MS || 180_000);
const pollIntervalMs = Number(process.env.PHASE6_POLL_INTERVAL_MS || 2_000);

type JsonRecord = Record<string, unknown>;
type ApiEnvelope<T> =
  | { ok: true; data: T; meta?: Record<string, unknown> }
  | { ok: false; error?: { message?: string }; meta?: Record<string, unknown> };

const jdText = [
  "岗位名称：AI 产品前端工程师",
  "我们正在招聘一位熟悉 Vue 3、TypeScript 和前端工程化的工程师，负责 AI Copilot 产品的对话工作台、简历编辑器、导出流程和数据看板。",
  "你需要和后端、算法、设计协作，把 Agent 流式输出、结构化卡片、PDF 导出、性能优化和可观测性落到稳定的用户体验里。",
  "要求：3 年以上前端经验，熟悉 Vue 3 / TypeScript / Pinia / Vite，理解 Fastify 或 Node.js API 协作，能编写 Vitest 或 Playwright 测试。",
  "加分：做过 LLM / Copilot 产品、简历或文档生成、Playwright PDF 导出、数据分析看板，能把用户行为数据转成产品改进。",
].join("\n");

const experiences = [
  {
    title: "WEEX 数据分析实习",
    organization: "WEEX 国际交易所",
    role: "数据分析实习生",
    category: "internship",
    startDate: "2025-01",
    endDate: "2025-05",
    tags: ["SQL", "Power BI", "用户漏斗", "交易数据"],
    content: "在 WEEX 实习期间，我使用 SQL 清洗交易与活动数据，用 Power BI 搭建增长仪表盘，跟踪注册、入金、交易转化等用户漏斗指标，并为运营活动复盘提供数据结论。",
  },
  {
    title: "求职 Copilot 简历工作台",
    organization: "个人项目",
    role: "全栈开发者",
    category: "project",
    startDate: "2025-06",
    endDate: "2026-02",
    tags: ["Vue 3", "TypeScript", "Pinia", "Fastify", "Playwright", "PDF"],
    content: "设计并实现面向求职者的 AI 简历工作台，包含 Agent 对话、结构化信息卡片、简历版本对比、接受版本、HTML/PDF 导出和端到端测试链路。",
  },
  {
    title: "校园任务管理系统",
    organization: "复旦大学课程项目",
    role: "前端负责人",
    category: "project",
    startDate: "2024-03",
    endDate: "2024-07",
    tags: ["Vue 3", "Vite", "Vitest", "组件库"],
    content: "负责 Vue 3 + Vite 前端架构，沉淀表单、弹窗、状态列表等组件，并用 Vitest 覆盖任务筛选、编辑和权限状态。",
  },
  {
    title: "前端工程化技能栈",
    role: "技能盘点",
    category: "skill",
    tags: ["TypeScript", "Vue 3", "React", "Node.js", "PostgreSQL", "Playwright"],
    content: "熟悉 TypeScript、Vue 3 Composition API、Pinia、Vite、React 基础、Fastify API 协作、PostgreSQL 基础、Vitest 单测和 Playwright E2E。",
  },
];

const caseDefinitions = [
  {
    id: "case1_self_intro",
    message: "根据我的经历帮我写一条 1 分钟中文自我介绍",
    expectedIntent: "asset_grounded.write",
    expectedTool: "compose_career_text",
    forbiddenTools: ["match_experiences_against_jd", "generate_resume_from_jd", "export_resume", "save_experience_from_text", "update_experience"],
  },
  {
    id: "case2_weex_project_intro",
    message: "根据 WEEX 实习经历帮我写一段面试项目介绍",
    expectedIntent: "asset_grounded.write",
    expectedTool: "compose_career_text",
    forbiddenTools: ["save_experience_from_text", "update_experience", "delete_experience"],
  },
  {
    id: "case3_jd_self_intro",
    message: `根据这份 JD 写一段自我介绍：\n${jdText}`,
    expectedIntent: "asset_grounded.write",
    expectedTool: "compose_career_text",
    forbiddenTools: ["match_experiences_against_jd", "generate_resume_from_jd", "export_resume"],
  },
  {
    id: "case4_jd_match_regression",
    message: `帮我看哪些经历最匹配这份 JD：\n${jdText}`,
    expectedIntent: "experience.match_against_jd",
    expectedTool: "match_experiences_against_jd",
    forbiddenTools: ["compose_career_text", "generate_resume_from_jd"],
  },
  {
    id: "case5_resume_generation_regression",
    message: `基于这个 JD 生成简历：\n${jdText}`,
    expectedIntent: "resume.generate_from_jd",
    expectedTool: "generate_resume_from_jd",
    forbiddenTools: ["compose_career_text"],
  },
];

async function main() {
  console.log("[phase6-probe] start", { baseUrl, userId, timeoutMs });
  const health = await getJson<JsonRecord>("/health");
  console.log("[phase6-probe] health", health);

  const seededExperienceIds: string[] = [];
  for (const exp of experiences) {
    const created = await postJson<JsonRecord>("/product/experiences", exp);
    const record = isRecord(created.experience) ? created.experience : created;
    const id = readString(record, "id");
    if (id) seededExperienceIds.push(id);
  }
  const jd = await postJson<JsonRecord>("/product/jds", {
    rawText: jdText,
    title: "AI 产品前端工程师",
    company: "Phase 6 Probe",
    targetRole: "AI 产品前端工程师",
  });
  console.log("[phase6-probe] seeded", {
    experienceIds: seededExperienceIds,
    jdId: readString(isRecord(jd.jd) ? jd.jd : jd, "id"),
  });

  const summaries: JsonRecord[] = [];
  let sessionId: string | undefined;
  let case5Response: JsonRecord | undefined;

  for (const definition of caseDefinitions) {
    const response = await postJson<JsonRecord>("/copilot/chat", {
      ...(sessionId ? { sessionId } : {}),
      message: definition.message,
      clientState: { locale: "zh-CN" },
    });
    sessionId = readString(response, "sessionId") || sessionId;
    if (definition.id === "case5_resume_generation_regression") case5Response = response;
    const summary = summarizeCase(definition, response);
    summaries.push(summary);
    console.log("[phase6-probe] case", JSON.stringify(summary, null, 2));
    assert(summary.passed === true, `${definition.id} failed assertions: ${JSON.stringify(summary.assertions)}`);
  }

  assert(case5Response, "case5 response missing");
  const pendingActionId = findPendingActionId(case5Response, "generate_resume_from_jd");
  assert(pendingActionId, "case5 did not create generate_resume_from_jd pending action");
  const confirmed = await postJson<JsonRecord>(`/copilot/pending-actions/${pendingActionId}/confirm`, {});
  console.log("[phase6-probe] case5 confirmed", summarizeToolEnvelope(confirmed));
  const generationJobId = findStringByKey(confirmed, "jobId");
  assert(generationJobId, "confirmed generation did not return jobId");
  const generationJob = await pollJob(generationJobId);
  assert(readString(generationJob, "status") === "completed", `generation job did not complete: ${JSON.stringify(generationJob)}`);
  const generationId = readString(isRecord(generationJob.output) ? generationJob.output : {}, "generationId") || findStringByKey(confirmed, "generationId");
  assert(generationId, "generationId missing after generation job");
  const generation = await getJson<JsonRecord>(`/product/generations/${generationId}`);
  const variants = Array.isArray(generation.variants) ? generation.variants.filter(isRecord) : [];
  assert(variants.length > 0, "generation has no variants");
  const recommendedVariantId = readString(generation, "recommendedVariantId");
  const selectedVariant = variants.find((variant) => readString(variant, "id") === recommendedVariantId) || variants[0];
  const variantId = readString(selectedVariant, "id");
  assert(variantId, "variant id missing");

  const accepted = await postJson<JsonRecord>(`/product/generations/${generationId}/accept-variant`, { variantId });
  const resumeId = readString(accepted, "resumeId") || readString(isRecord(accepted.resume) ? accepted.resume : {}, "id");
  assert(resumeId, "accept variant did not return resumeId");

  const exportCreated = await postJson<JsonRecord>(`/exports/resumes/${resumeId}`, { format: "pdf" });
  const exportRecord = isRecord(exportCreated.exportRecord) ? exportCreated.exportRecord : exportCreated;
  const exportId = readString(exportRecord, "id");
  const exportJobId = readString(isRecord(exportCreated.job) ? exportCreated.job : {}, "id") || readString(exportRecord, "jobId");
  assert(exportId, "PDF export id missing");
  assert(exportJobId, "PDF export job id missing");
  const completedExport = await pollExport(exportId, exportJobId);
  assert(readString(completedExport, "status") === "completed", `PDF export did not complete: ${JSON.stringify(completedExport)}`);
  const download = await request(`/exports/${exportId}/download`, { method: "GET" });
  const contentType = download.response.headers.get("content-type") || "";
  const pdfBytes = Buffer.byteLength(download.buffer);
  assert(download.response.status === 200, `PDF download HTTP ${download.response.status}`);
  assert(contentType.includes("application/pdf"), `PDF content-type mismatch: ${contentType}`);
  assert(download.buffer.subarray(0, 4).toString("utf8") === "%PDF", "PDF download does not start with %PDF");

  const finalReport = {
    userId,
    sessionId,
    health,
    seededExperienceIds,
    jdId: readString(isRecord(jd.jd) ? jd.jd : jd, "id"),
    cases: summaries,
    generationRegression: {
      pendingActionId,
      generationJobId,
      generationId,
      variantCount: variants.length,
      recommendedVariantId,
      comparisonMatrixPresent: Array.isArray(generation.comparisonMatrix) && generation.comparisonMatrix.length > 0,
      acceptedVariantId: variantId,
      resumeId,
    },
    pdfExport: {
      exportId,
      exportJobId,
      status: readString(completedExport, "status"),
      contentType,
      pdfBytes,
    },
  };
  console.log("PHASE6_RESULT_JSON_START");
  console.log(JSON.stringify(finalReport, null, 2));
  console.log("PHASE6_RESULT_JSON_END");
}

function summarizeCase(definition: typeof caseDefinitions[number], response: JsonRecord): JsonRecord {
  const toolResults = extractToolResults(response);
  const actionResults = extractActionResults(response);
  const pendingActions = extractPendingActions(response);
  const events = extractAgentRoomEvents(response);
  const productBlocks = extractProductBlocks(response);
  const toolNames = unique([
    ...toolResults.map((item) => readString(isRecord(item.actionResult) ? item.actionResult : {}, "actionType")).filter(isString),
    ...actionResults.map((item) => readString(item, "actionType")).filter(isString),
    ...pendingActions.map((item) => readString(item, "toolName")).filter(isString),
    ...events.map((item) => readString(item, "relatedToolName")).filter(isString),
  ]);
  const intent = findLatestIntent(response);
  const compose = toolResults.find((item) => readString(isRecord(item.actionResult) ? item.actionResult : {}, "actionType") === "compose_career_text");
  const composeData = isRecord(compose?.data) ? compose.data : {};
  const writingEvents = events.filter((item) => {
    const specialInfo = isRecord(item.specialInfo) ? item.specialInfo : {};
    return readString(specialInfo, "kind") === "writing_result";
  });
  const specialKinds = events
    .map((item) => readString(isRecord(item.specialInfo) ? item.specialInfo : {}, "kind"))
    .filter(isString);
  const blockTypes = productBlocks.map((item) => readString(item, "type")).filter(isString);
  const forbiddenHits = definition.forbiddenTools.filter((tool) => toolNames.includes(tool));
  const assertions: JsonRecord = {
    expectedIntent: intent === definition.expectedIntent,
    expectedTool: toolNames.includes(definition.expectedTool),
    noForbiddenTools: forbiddenHits.length === 0,
  };

  if (definition.expectedTool === "compose_career_text") {
    assertions.composeMethodLlm = readString(composeData, "composeMethod") === "llm";
    assertions.noFallbackWarning = !JSON.stringify(compose ?? {}).includes("deterministic_test_fallback");
    assertions.writingResultEvent = writingEvents.length > 0;
    assertions.usedExperienceIds = stringArray(composeData.usedExperienceIds).length > 0;
    assertions.groundingNotes = stringArray(composeData.groundingNotes).length > 0;
    assertions.noPendingAction = pendingActions.length === 0;
    assertions.noMatchMatrix = !specialKinds.includes("match_matrix") && !blockTypes.includes("experience_match_results");
    assertions.noResumeVariants = !JSON.stringify(response.workspace ?? {}).includes("variants_generated") && !toolNames.includes("generate_resume_from_jd");
    assertions.noExport = !toolNames.includes("export_resume") && !JSON.stringify(response.workspace ?? {}).includes("export-");
  }

  if (definition.id === "case2_weex_project_intro") {
    const usedExperienceIds = stringArray(composeData.usedExperienceIds);
    const dataText = JSON.stringify(composeData);
    assertions.weexExperienceUsed = usedExperienceIds.length > 0 && dataText.toUpperCase().includes("WEEX");
    assertions.noPendingAction = pendingActions.length === 0;
  }

  if (definition.id === "case3_jd_self_intro") {
    assertions.writingResultEvent = writingEvents.length > 0;
    assertions.groundingDiagnostics = isRecord(composeData.groundingDiagnostics);
  }

  if (definition.expectedTool === "match_experiences_against_jd") {
    assertions.matchMatrix = specialKinds.includes("match_matrix") || blockTypes.includes("experience_match_results");
    assertions.notCompose = !toolNames.includes("compose_career_text");
  }

  if (definition.expectedTool === "generate_resume_from_jd") {
    assertions.pendingAction = pendingActions.some((item) => readString(item, "toolName") === "generate_resume_from_jd");
    assertions.notCompose = !toolNames.includes("compose_career_text");
  }

  const passed = Object.values(assertions).every((value) => value === true);
  return {
    id: definition.id,
    inputPreview: definition.message.slice(0, 160),
    intent,
    toolNames,
    forbiddenHits,
    pendingActionCount: pendingActions.length,
    specialKinds,
    productBlockTypes: blockTypes,
    compose: compose
      ? {
          status: readString(compose, "status"),
          resultKind: readString(compose, "resultKind"),
          composeMethod: readString(composeData, "composeMethod"),
          usedExperienceIds: stringArray(composeData.usedExperienceIds),
          usedEvidenceIds: stringArray(composeData.usedEvidenceIds),
          groundingNotesCount: stringArray(composeData.groundingNotes).length,
          groundingDiagnosticsPresent: isRecord(composeData.groundingDiagnostics),
          warnings: Array.isArray(compose.warnings) ? compose.warnings : [],
          contentPreview: readString(composeData, "content")?.slice(0, 220),
        }
      : undefined,
    assertions,
    passed,
  };
}

function summarizeToolEnvelope(response: JsonRecord): JsonRecord {
  return {
    sessionId: readString(response, "sessionId"),
    turnId: readString(response, "turnId"),
    toolNames: extractToolResults(response)
      .map((item) => readString(isRecord(item.actionResult) ? item.actionResult : {}, "actionType"))
      .filter(isString),
    pendingActions: extractPendingActions(response).map((item) => ({
      id: readString(item, "id"),
      toolName: readString(item, "toolName"),
      status: readString(item, "status"),
    })),
    jobId: findStringByKey(response, "jobId"),
  };
}

function extractToolResults(response: JsonRecord): JsonRecord[] {
  const raw = isRecord(response.raw) ? response.raw : {};
  const direct = Array.isArray(raw.toolResults) ? raw.toolResults.filter(isRecord) : [];
  const metadata = isRecord(response.assistantMessage) && isRecord(response.assistantMessage.metadata)
    ? response.assistantMessage.metadata
    : {};
  const displaySnapshot = isRecord(metadata.displaySnapshot) ? metadata.displaySnapshot : {};
  const fromSnapshot = Array.isArray(displaySnapshot.toolResults) ? displaySnapshot.toolResults.filter(isRecord) : [];
  return [...direct, ...fromSnapshot];
}

function extractActionResults(response: JsonRecord): JsonRecord[] {
  const raw = isRecord(response.raw) ? response.raw : {};
  return Array.isArray(raw.actionResults) ? raw.actionResults.filter(isRecord) : [];
}

function extractPendingActions(response: JsonRecord): JsonRecord[] {
  const raw = isRecord(response.raw) ? response.raw : {};
  return Array.isArray(raw.pendingActions) ? raw.pendingActions.filter(isRecord) : [];
}

function extractAgentRoomEvents(response: JsonRecord): JsonRecord[] {
  const top = Array.isArray(response.agentRoomEvents) ? response.agentRoomEvents.filter(isRecord) : [];
  const metadata = isRecord(response.assistantMessage) && isRecord(response.assistantMessage.metadata)
    ? response.assistantMessage.metadata
    : {};
  const metaEvents = Array.isArray(metadata.agentRoomEvents) ? metadata.agentRoomEvents.filter(isRecord) : [];
  const displaySnapshot = isRecord(metadata.displaySnapshot) ? metadata.displaySnapshot : {};
  const snapshotEvents = Array.isArray(displaySnapshot.agentRoomEvents) ? displaySnapshot.agentRoomEvents.filter(isRecord) : [];
  return [...top, ...metaEvents, ...snapshotEvents];
}

function extractProductBlocks(response: JsonRecord): JsonRecord[] {
  const metadata = isRecord(response.assistantMessage) && isRecord(response.assistantMessage.metadata)
    ? response.assistantMessage.metadata
    : {};
  const metaBlocks = Array.isArray(metadata.productBlocks) ? metadata.productBlocks.filter(isRecord) : [];
  const displaySnapshot = isRecord(metadata.displaySnapshot) ? metadata.displaySnapshot : {};
  const snapshotBlocks = Array.isArray(displaySnapshot.productBlocks) ? displaySnapshot.productBlocks.filter(isRecord) : [];
  return [...metaBlocks, ...snapshotBlocks];
}

function findLatestIntent(response: JsonRecord): string | undefined {
  const workspace = isRecord(response.workspace) ? response.workspace : {};
  const handoffs = Array.isArray(workspace.handoffs) ? workspace.handoffs.filter(isRecord) : [];
  for (let index = handoffs.length - 1; index >= 0; index -= 1) {
    const intent = readString(handoffs[index], "intent");
    if (intent) return intent;
  }
  return findStringByKey(response, "intent");
}

function findPendingActionId(response: JsonRecord, toolName: string): string | undefined {
  for (const action of extractPendingActions(response)) {
    if (readString(action, "toolName") === toolName) return readString(action, "id");
  }
  return findStringByKey(response, "pendingActionId");
}

async function pollJob(jobId: string): Promise<JsonRecord> {
  return poll(`job ${jobId}`, async () => {
    const job = await getJson<JsonRecord>(`/jobs/${jobId}`);
    console.log("[phase6-probe] job poll", {
      jobId,
      status: readString(job, "status"),
      errorMessage: readString(job, "errorMessage"),
    });
    const status = readString(job, "status");
    if (status === "completed" || status === "failed" || status === "cancelled") return job;
    return undefined;
  });
}

async function pollExport(exportId: string, jobId: string): Promise<JsonRecord> {
  return poll(`export ${exportId}`, async () => {
    const [exportRecord, job] = await Promise.all([
      getJson<JsonRecord>(`/exports/${exportId}`),
      getJson<JsonRecord>(`/jobs/${jobId}`).catch((error) => ({ errorMessage: error instanceof Error ? error.message : String(error) })),
    ]);
    console.log("[phase6-probe] export poll", {
      exportId,
      exportStatus: readString(exportRecord, "status"),
      jobId,
      jobStatus: readString(job, "status"),
      jobErrorMessage: readString(job, "errorMessage"),
    });
    const exportStatus = readString(exportRecord, "status");
    const jobStatus = readString(job, "status");
    if (exportStatus === "completed" || exportStatus === "failed" || jobStatus === "failed" || jobStatus === "cancelled") return exportRecord;
    return undefined;
  });
}

async function poll<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function getJson<T extends JsonRecord>(path: string): Promise<T> {
  return requestJson<T>(path, { method: "GET" });
}

async function postJson<T extends JsonRecord>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "idempotency-key": `phase6-${randomUUID()}`,
    },
  });
}

async function requestJson<T extends JsonRecord>(path: string, init: RequestInit): Promise<T> {
  const { response, text } = await request(path, init);
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${init.method || "GET"} ${path} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${path} failed HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
  const envelope = parsed as ApiEnvelope<T>;
  if (isRecord(envelope) && envelope.ok === true && isRecord(envelope.data)) return envelope.data as T;
  if (isRecord(envelope) && envelope.ok === false) {
    throw new Error(`${init.method || "GET"} ${path} failed: ${envelope.error?.message ?? text.slice(0, 1000)}`);
  }
  if (isRecord(parsed)) return parsed as T;
  throw new Error(`${init.method || "GET"} ${path} returned unexpected body: ${text.slice(0, 1000)}`);
}

async function request(path: string, init: RequestInit): Promise<{ response: Response; text: string; buffer: Buffer }> {
  const headers = new Headers(init.headers);
  headers.set("x-user-id", userId);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const text = buffer.toString("utf8");
  return { response, text, buffer };
}

function findStringByKey(value: unknown, key: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, key);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const direct = readString(value, key);
  if (direct) return direct;
  for (const child of Object.values(value)) {
    const found = findStringByKey(child, key);
    if (found) return found;
  }
  return undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error("[phase6-probe] failed", error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
