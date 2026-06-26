import { randomUUID } from "node:crypto";

type ApiEnvelope<T> =
  | { ok: true; data: T; meta?: Record<string, unknown> }
  | { ok: false; error?: { message?: string }; meta?: Record<string, unknown> };

type JsonRecord = Record<string, unknown>;

type Scenario = {
  id: "data_bi" | "ml_data" | "ai_product";
  targetRole: string;
  expectation: string;
  jd: string;
};

type VariantSummary = {
  id?: string;
  variantName?: string;
  recommended?: boolean;
  scores?: unknown;
  summary?: string;
  content?: string;
  sourceExperienceIds?: unknown;
  sourceEvidenceIds?: unknown;
  evidenceSummary?: unknown;
  riskSummary?: unknown;
  missingInfo?: unknown;
  resumeDocument?: unknown;
  qualitySignals: ReturnType<typeof assessContent>;
};

const baseUrl = (process.env.PHASE2_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const userId = process.env.PHASE2_USER_ID || "dev-user";
const timeoutMs = Number(process.env.PHASE2_TIMEOUT_MS || 180_000);
const pollIntervalMs = Number(process.env.PHASE2_POLL_INTERVAL_MS || 1500);
const shouldAcceptVariant = process.env.PHASE2_ACCEPT_VARIANT !== "0";

const scenarios: Scenario[] = [
  {
    id: "data_bi",
    targetRole: "金融科技数据分析师 / BI Analyst",
    expectation: "Should produce a dense data analyst resume emphasizing WEEX SQL, BI dashboards, trading/user metrics, and business collaboration.",
    jd: [
      "岗位：金融科技数据分析师 / BI Analyst",
      "团队负责交易平台的活动增长、用户生命周期和经营指标分析。候选人需要熟练使用 SQL 完成多表关联、窗口函数、自动化数据处理，能够搭建 Power BI、Datawind 或类似 BI 看板，沉淀活动投放、入金、交易量、留存、ARPU、DAU 等指标口径，并向运营、产品、风控团队输出可执行洞察。",
      "我们看重候选人能否把复杂数据转化为业务团队可用的分析资产，能否在指标口径混乱、数据查询效率低的环境中推动标准化。加分项包括交易所、金融科技、互联网运营分析经验，以及 Spark、Hadoop 或 Python 数据处理能力。",
    ].join("\n"),
  },
  {
    id: "ml_data",
    targetRole: "机器学习数据工程实习生",
    expectation: "Should target AI data processing, corpus governance, labeling quality, Spark/Hadoop large-scale data, and conservative ML support wording.",
    jd: [
      "岗位：机器学习数据工程实习生",
      "团队主要处理大规模文本、用户行为和多模态传感器数据，为模型训练、评估和数据质量治理提供支持。候选人需要能够使用 Python 或类似工具完成数据清洗、异常值处理、标签体系建设、特征工程和质量评估，理解机器学习基本流程，并能和算法工程师一起准备训练样本与评测数据。",
      "加分项：有语料库治理、标注规范、大模型备案、Spark/Hadoop 大数据处理、时间序列特征或深度学习项目经验。该岗位不要求独立上线模型，但要求数据处理过程严谨、文档清晰、能解释质量指标变化。",
    ].join("\n"),
  },
  {
    id: "ai_product",
    targetRole: "AI 产品数据分析实习生",
    expectation: "Should blend AI/data evidence with product analytics, documentation, requirement translation, and not overstate product ownership.",
    jd: [
      "岗位：AI 产品数据分析实习生",
      "我们在搭建面向企业客户的 AI 产品能力，需要候选人支持产品经理完成需求调研、数据分析、模型效果跟踪、用户反馈整理和功能迭代复盘。候选人需要理解 AI 或数据产品的基本工作流，能用 SQL/Python 做分析，能把算法、运营和客户反馈整理成清晰的产品文档与指标看板。",
      "优先考虑做过大模型备案、数据标注规范、AI 项目文档、BI 看板或用户行为分析的人选。该岗位不是纯算法岗，也不是纯运营岗，希望候选人能在技术证据和产品表达之间建立桥梁。",
    ].join("\n"),
  },
];

async function main() {
  const health = await getJson<JsonRecord>("/health");
  const experiences = await getJson<unknown[]>("/product/experiences");
  const results: unknown[] = [];

  for (const scenario of scenarios) {
    const session = await postJson<JsonRecord>("/copilot/chat", {
      message: [
        "请先理解下面这份 JD，并准备为我生成一份有针对性的中文简历。",
        "要求内容像正式投递简历，而不是泛泛总结。",
        "",
        scenario.jd,
      ].join("\n"),
      jdText: scenario.jd,
      targetRole: scenario.targetRole,
    });
    const sessionId = readString(session, "sessionId");

    const matchResponse = await postJson<JsonRecord>("/copilot/chat", {
      sessionId,
      message: [
        "先基于这份 JD 对我的经历库做一次匹配分析，给出证据和缺口。",
        "",
        scenario.jd,
      ].join("\n"),
      jdText: scenario.jd,
      targetRole: scenario.targetRole,
    });

    const actionResponse = await postJson<JsonRecord>("/copilot/actions", {
      sessionId,
      action: {
        type: "generate_from_jd",
        payload: {
          jdText: scenario.jd,
          targetRole: scenario.targetRole,
        },
      },
      clientState: {},
    });
    const pendingActionId = extractPendingActionId(actionResponse);
    if (!pendingActionId) throw new Error(`${scenario.id}: generate_from_jd did not create a pending action`);

    const confirmResponse = await postJson<JsonRecord>(`/copilot/pending-actions/${pendingActionId}/confirm`, {});
    const jobId = extractGenerationJobId(confirmResponse);
    if (!jobId) throw new Error(`${scenario.id}: confirm response did not include generation jobId`);

    const job = await pollJob(jobId);
    if (readString(job, "status") !== "completed") {
      throw new Error(`${scenario.id}: generation job ended as ${readString(job, "status")} ${readString(job, "errorMessage") ?? ""}`);
    }
    const output = isRecord(job.output) ? job.output : {};
    const generationId = readString(output, "generationId");
    if (!generationId) throw new Error(`${scenario.id}: completed job did not include generationId`);

    const generation = await getJson<JsonRecord>(`/product/generations/${generationId}`);
    const variants = (Array.isArray(generation.variants) ? generation.variants : [])
      .filter(isRecord)
      .map(toVariantSummary);
    const recommended = variants.find((variant) => variant.recommended) ?? variants[0];
    let accepted: unknown;
    if (shouldAcceptVariant && recommended?.id) {
      accepted = await postJson<JsonRecord>(`/product/generations/${generationId}/accept-variant`, {
        variantId: recommended.id,
      });
    }

    results.push({
      scenarioId: scenario.id,
      targetRole: scenario.targetRole,
      expectation: scenario.expectation,
      jd: scenario.jd,
      sessionId,
      pendingActionId,
      jobId,
      generationId,
      matchSummary: summarizeMatch(matchResponse),
      generationMetadata: generation.metadata,
      comparisonMatrix: generation.comparisonMatrix,
      variantCount: variants.length,
      variants,
      acceptedSummary: summarizeAccepted(accepted),
    });
  }

  console.log("PHASE2_RESUME_GENERATION_SMOKE_RESULT_START");
  console.log(JSON.stringify({
    baseUrl,
    userId,
    health,
    experienceCount: experiences.length,
    acceptedVariant: shouldAcceptVariant,
    results,
  }, null, 2));
  console.log("PHASE2_RESUME_GENERATION_SMOKE_RESULT_END");
}

function toVariantSummary(variant: JsonRecord): VariantSummary {
  const content = readString(variant, "content");
  const id = readString(variant, "id");
  const variantName = readString(variant, "variantName");
  const recommended = typeof variant.recommended === "boolean" ? variant.recommended : undefined;
  const summary = readString(variant, "summary");
  const sourceExperienceIds = variant.sourceExperienceIds;
  const sourceEvidenceIds = variant.sourceEvidenceIds;
  const resumeDocument = variant.resumeDocument;
  return {
    id,
    variantName,
    recommended,
    scores: variant.scores,
    summary,
    content,
    sourceExperienceIds,
    sourceEvidenceIds,
    evidenceSummary: variant.evidenceSummary,
    riskSummary: variant.riskSummary,
    missingInfo: variant.missingInfo,
    resumeDocument,
    qualitySignals: assessContent(content ?? "", resumeDocument),
  };
}

function assessContent(content: string, resumeDocument: unknown) {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bulletCount = lines.filter((line) => /^[-*•]/.test(line)).length;
  const sectionCount = lines.filter((line) => /^(教育经历|实习经历|项目经历|技能|技能与兴趣|个人总结|求职亮点|工作经历|校园经历|荣誉)/.test(line)).length;
  const metricCount = (content.match(/\d+(?:\.\d+)?\s*(?:%|\+|万|余|个|条|次|人|份|字|GB|ms|行|项|周|月)/gi) ?? []).length;
  const actionVerbCount = (content.match(/(处理|构建|搭建|设计|优化|沉淀|交付|支持|协同|提取|分析|主导|参与|撰写|定位|修复|提升|降低|覆盖|推动)/g) ?? []).length;
  const aiFlavorCount = (content.match(/(具备较强|良好的|丰富的|扎实的|熟悉相关|能够快速|具有一定|积极主动|学习能力强|团队合作精神)/g) ?? []).length;
  const docSections = isRecord(resumeDocument) && Array.isArray(resumeDocument.sections)
    ? resumeDocument.sections.length
    : 0;
  const docBullets = isRecord(resumeDocument) && Array.isArray(resumeDocument.sections)
    ? resumeDocument.sections.filter(isRecord).flatMap((section) => Array.isArray(section.items) ? section.items : [])
        .filter(isRecord).flatMap((item) => Array.isArray(item.bullets) ? item.bullets : []).length
    : 0;
  return {
    charLength: content.length,
    lineCount: lines.length,
    bulletCount,
    sectionCount,
    metricCount,
    actionVerbCount,
    aiFlavorCount,
    resumeDocumentSections: docSections,
    resumeDocumentBullets: docBullets,
  };
}

function summarizeMatch(response: JsonRecord) {
  const raw = isRecord(response.raw) ? response.raw : {};
  const toolResults = Array.isArray(raw.toolResults) ? raw.toolResults.filter(isRecord) : [];
  const match = toolResults.find((item) => {
    const actionResult = isRecord(item.actionResult) ? item.actionResult : {};
    return readString(actionResult, "actionType") === "match_experiences_against_jd";
  });
  const data = isRecord(match?.data) ? match.data : {};
  return {
    scoreDistribution: data.scoreDistribution,
    jdAnalysis: data.jdAnalysis,
    summaryFacts: Array.isArray(match?.summaryFacts) ? match.summaryFacts : undefined,
  };
}

function summarizeAccepted(value: unknown) {
  if (!isRecord(value)) return undefined;
  const resume = isRecord(value.resume) ? value.resume : {};
  return {
    resumeId: readString(value, "resumeId") ?? readString(resume, "id"),
    itemCount: Array.isArray(value.items) ? value.items.length : undefined,
  };
}

async function pollJob(jobId: string): Promise<JsonRecord> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJson<JsonRecord>(`/jobs/${jobId}`);
    const status = readString(job, "status");
    if (status === "completed" || status === "failed" || status === "cancelled") return job;
    await sleep(pollIntervalMs);
  }
  throw new Error(`job ${jobId} timed out after ${timeoutMs}ms`);
}

async function getJson<T>(path: string): Promise<T> {
  return requestJson<T>(path, { method: "GET" });
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `phase2-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  });
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-user-id", userId);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
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
  if (isRecord(envelope) && envelope.ok === true) return envelope.data;
  if (isRecord(envelope) && envelope.ok === false) {
    throw new Error(`${init.method || "GET"} ${path} failed: ${envelope.error?.message ?? text.slice(0, 1000)}`);
  }
  return parsed as T;
}

function extractPendingActionId(response: JsonRecord): string | undefined {
  const raw = isRecord(response.raw) ? response.raw : {};
  const pendingActions = Array.isArray(raw.pendingActions) ? raw.pendingActions.filter(isRecord) : [];
  for (const action of pendingActions) {
    if (readString(action, "toolName") === "generate_resume_from_jd") {
      return readString(action, "id") || readString(action, "pendingActionId");
    }
  }
  return findStringByKey(response, "pendingActionId");
}

function extractGenerationJobId(response: JsonRecord): string | undefined {
  const raw = isRecord(response.raw) ? response.raw : {};
  const actionResults = Array.isArray(raw.actionResults) ? raw.actionResults.filter(isRecord) : [];
  for (const result of actionResults) {
    if (readString(result, "actionType") !== "generate_resume_from_jd") continue;
    const metadata = isRecord(result.metadata) ? result.metadata : {};
    const jobId = readString(metadata, "jobId");
    if (jobId) return jobId;
  }
  return findStringByKey(response, "jobId");
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
