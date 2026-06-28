import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

type Scenario = {
  id: "data_bi" | "ml_data" | "ai_product";
  targetRole: string;
  jd: string;
};

const baseUrl = (process.env.PHASE3_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const userId = process.env.PHASE3_USER_ID || "dev-user";
const timeoutMs = Number(process.env.PHASE3_TIMEOUT_MS || 240_000);
const pollIntervalMs = Number(process.env.PHASE3_POLL_INTERVAL_MS || 1500);
const outDir = path.resolve(process.cwd(), process.env.PHASE3_OUTPUT_DIR || "docs/temp_pdf");
const scenarioFilter = process.env.PHASE3_SCENARIO;

const scenarios: Scenario[] = [
  {
    id: "data_bi",
    targetRole: "金融科技数据分析师 / BI Analyst",
    jd: [
      "岗位：金融科技数据分析师 / BI Analyst",
      "团队负责交易平台增长、用户生命周期、活动投放和经营分析。候选人需要熟练使用 SQL 完成多表关联、窗口函数和自动化数据处理，能够搭建 Power BI、Datawind 或类似 BI 看板，沉淀入金、交易量、留存、ARPU、DAU 等指标口径，并向运营、产品、风控团队输出可执行洞察。",
      "加分项包括交易所、金融科技、互联网运营分析经验，以及 Spark、Hadoop 或 Python 数据处理能力。我们希望简历能体现指标标准化、业务协作、数据资产沉淀和复盘分析能力。",
    ].join("\n"),
  },
  {
    id: "ml_data",
    targetRole: "机器学习数据工程实习生",
    jd: [
      "岗位：机器学习数据工程实习生",
      "团队处理大规模文本、用户行为和多模态传感器数据，为模型训练、评估和数据质量治理提供支持。候选人需要使用 Python 或类似工具完成数据清洗、异常处理、标签体系建设、特征工程和质量评估，能和算法工程师一起准备训练样本与评测数据。",
      "加分项包括语料库治理、标注规范、大模型备案、Spark/Hadoop 大数据处理、时间序列特征或深度学习项目。岗位不要求独立上线模型，但要求过程严谨、文档清晰、能解释质量指标变化。",
    ].join("\n"),
  },
  {
    id: "ai_product",
    targetRole: "AI 产品数据分析实习生",
    jd: [
      "岗位：AI 产品数据分析实习生",
      "我们正在搭建面向企业客户的 AI 产品能力，需要候选人支持产品经理完成需求调研、数据分析、模型效果跟踪、用户反馈整理和功能迭代复盘。候选人需要理解 AI 或数据产品基本工作流，能用 SQL/Python 做分析，能把算法、运营和客户反馈整理成清晰的产品文档与指标看板。",
      "优先考虑做过大模型备案、数据标注规范、AI 项目文档、BI 看板或用户行为分析的人选。该岗位不是纯算法岗，也不是纯运营岗，希望候选人能在技术证据和产品表达之间建立桥梁。",
    ].join("\n"),
  },
];

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const health = await getJson<JsonRecord>("/health");
  const results: JsonRecord[] = [];

  const activeScenarios = scenarioFilter
    ? scenarios.filter((scenario) => scenario.id === scenarioFilter)
    : scenarios;
  if (activeScenarios.length === 0) throw new Error(`No scenario matched PHASE3_SCENARIO=${scenarioFilter}`);

  for (const [index, scenario] of activeScenarios.entries()) {
    console.log("[phase3] scenario start", { scenario: scenario.id, targetRole: scenario.targetRole });
    const startedAt = new Date().toISOString();
    const session = await postJson<JsonRecord>("/copilot/chat", {
      message: [
        "请根据下面 JD 生成一份可投递的一页中文 PDF 简历。",
        "要求内容专业、量化、贴合 JD，并最终导出 PDF。",
        "",
        scenario.jd,
      ].join("\n"),
      jdText: scenario.jd,
      targetRole: scenario.targetRole,
    });
    const sessionId = readString(session, "sessionId");

    const actionResponse = await postJson<JsonRecord>("/copilot/actions", {
      sessionId,
      action: {
        type: "generate_from_jd",
        payload: { jdText: scenario.jd, targetRole: scenario.targetRole },
      },
      clientState: {},
    });
    const pendingActionId = extractPendingActionId(actionResponse);
    if (!pendingActionId) throw new Error(`${scenario.id}: generate_from_jd did not create pending action`);
    console.log("[phase3] pending action", { scenario: scenario.id, pendingActionId });

    const confirmResponse = await postJson<JsonRecord>(`/copilot/pending-actions/${pendingActionId}/confirm`, {});
    const generationJobId = extractGenerationJobId(confirmResponse);
    if (!generationJobId) throw new Error(`${scenario.id}: confirm did not return generation job id`);
    console.log("[phase3] generation job", { scenario: scenario.id, generationJobId });

    const generationJob = await pollJob(generationJobId);
    if (readString(generationJob, "status") !== "completed") {
      throw new Error(`${scenario.id}: generation job ${generationJobId} ended as ${readString(generationJob, "status")}`);
    }
    const generationId = readString(generationJob.output, "generationId");
    if (!generationId) throw new Error(`${scenario.id}: generation job missing generationId`);
    console.log("[phase3] generation completed", { scenario: scenario.id, generationId });

    const generation = await getJson<JsonRecord>(`/product/generations/${generationId}`);
    const variants = Array.isArray(generation.variants) ? generation.variants.filter(isRecord) : [];
    const recommended = variants.find((variant) => variant.recommended === true) ?? variants[0];
    const variantId = readString(recommended, "id");
    if (!variantId) throw new Error(`${scenario.id}: no variant id`);

    const accepted = await postJson<JsonRecord>(`/product/generations/${generationId}/accept-variant`, { variantId });
    const resume = isRecord(accepted.resume) ? accepted.resume : {};
    const resumeId = readString(accepted, "resumeId") ?? readString(resume, "id");
    if (!resumeId) throw new Error(`${scenario.id}: accept-variant missing resumeId`);
    console.log("[phase3] variant accepted", { scenario: scenario.id, resumeId, variantId });

    const exportCreated = await postJson<JsonRecord>(`/exports/resumes/${resumeId}`, {
      format: "pdf",
      templateId: "one-page-modern",
    });
    const exportRecord = isRecord(exportCreated.exportRecord) ? exportCreated.exportRecord : exportCreated;
    const exportId = readString(exportRecord, "id");
    const exportJobId = readString(exportCreated.job, "id") ?? readString(exportRecord, "jobId");
    if (!exportId || !exportJobId) throw new Error(`${scenario.id}: export creation missing ids`);
    console.log("[phase3] export created", { scenario: scenario.id, exportId, exportJobId });

    const completedExport = await pollExport(exportId, exportJobId);
    if (readString(completedExport, "status") !== "completed") {
      throw new Error(`${scenario.id}: export ${exportId} ended as ${readString(completedExport, "status")}`);
    }

    const pdf = await downloadBuffer(`/exports/${exportId}/download`);
    const pdfInfo = await extractPdfInfo(pdf.buffer);
    const layoutReport = readLayoutReport(completedExport);
    const quality = assessPdf({ pdfInfo, layoutReport, exportRecord: completedExport });
    const safeStartedAt = startedAt.replace(/[:.]/g, "-");
    const status = quality.pass ? "pass" : "fail";
    const stem = `${safeStartedAt}_${String(index + 1).padStart(2, "0")}_${scenario.id}_${status}_${generationId}_${exportId}`;
    const pdfPath = path.join(outDir, `${stem}.pdf`);
    const jsonPath = path.join(outDir, `${stem}.json`);
    await writeFile(pdfPath, pdf.buffer);
    const result = {
      scenarioId: scenario.id,
      targetRole: scenario.targetRole,
      jd: scenario.jd,
      sessionId,
      pendingActionId,
      generationJobId,
      generationId,
      variantId,
      resumeId,
      exportId,
      exportJobId,
      pdfPath,
      jsonPath,
      contentType: pdf.contentType,
      pdfInfo,
      layoutReport,
      fitReport: completedExport.fitReport,
      compressionReport: completedExport.compressionReport,
      qualityReport: completedExport.qualityReport,
      quality,
    };
    await writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
    console.log("[phase3] scenario done", {
      scenario: scenario.id,
      pass: quality.pass,
      pdfPath,
      reasons: quality.reasons,
      pageCount: pdfInfo.pageCount,
      layout: layoutReport ? {
        fitsPage: layoutReport.fitsPage,
        invalidBullets: Array.isArray(layoutReport.invalidBullets) ? layoutReport.invalidBullets.length : undefined,
        contentHeightPx: layoutReport.contentHeightPx,
        usableHeightPx: layoutReport.usableHeightPx,
      } : undefined,
    });
    results.push(result);
  }

  const pass = results.every((item) => isRecord(item.quality) && item.quality.pass === true);
  const summary = { baseUrl, userId, health, outDir, pass, results };
  const summaryPath = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_phase3_summary_${pass ? "pass" : "fail"}.json`);
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  console.log("PHASE3_PDF_LAYOUT_SMOKE_RESULT_START");
  console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));
  console.log("PHASE3_PDF_LAYOUT_SMOKE_RESULT_END");

  if (!pass) process.exitCode = 1;
}

function assessPdf(input: { pdfInfo: JsonRecord; layoutReport?: JsonRecord; exportRecord: JsonRecord }): JsonRecord {
  const layout = input.layoutReport;
  const invalidBullets = Array.isArray(layout?.invalidBullets) ? layout.invalidBullets : [];
  const contentHeightPx = typeof layout?.contentHeightPx === "number" ? layout.contentHeightPx : undefined;
  const usableHeightPx = typeof layout?.usableHeightPx === "number" ? layout.usableHeightPx : undefined;
  const fitsPage = layout?.fitsPage === true && (contentHeightPx == null || usableHeightPx == null || contentHeightPx <= usableHeightPx);
  const bulletWidthPass = layout?.passesBulletWidthRule !== false;
  const bulletLayouts = Array.isArray(layout?.bulletLayouts) ? layout.bulletLayouts : [];
  const danglingBullets = bulletLayouts.filter((item) => isRecord(item) && hasDanglingBulletEnding(readString(item, "text") ?? ""));
  const naturalBulletEndingsPass = danglingBullets.length === 0;
  const enoughCoreBullets = bulletLayouts.length >= 14;
  const enoughPageUsage = contentHeightPx != null && usableHeightPx != null && contentHeightPx / usableHeightPx >= 0.83;
  const qualityReport = isRecord(input.exportRecord.qualityReport) ? input.exportRecord.qualityReport : {};
  const criticReview = isRecord(qualityReport.criticReview) ? qualityReport.criticReview : {};
  const semanticScore = typeof criticReview.semanticJdMatchScore === "number" ? criticReview.semanticJdMatchScore : undefined;
  const semanticPass = semanticScore == null || semanticScore >= 70;
  const pageCountPass = input.pdfInfo.pageCount === 1;
  const text = readString(input.pdfInfo, "text") ?? "";
  const normalizedText = text.replace(/\s+/g, "");
  const hasSections = /Experience|Projects|Education|Skills/i.test(text)
    || /实习|项目|教育|技能/.test(normalizedText);
  const pass = pageCountPass && fitsPage && bulletWidthPass && naturalBulletEndingsPass && enoughCoreBullets && enoughPageUsage && semanticPass && hasSections;
  return {
    pass,
    pageCountPass,
    fitsPage,
    bulletWidthPass,
    naturalBulletEndingsPass,
    danglingBullets,
    enoughCoreBullets,
    enoughPageUsage,
    semanticPass,
    semanticScore,
    hasSections,
    reasons: [
      pageCountPass ? undefined : `pageCount=${String(input.pdfInfo.pageCount)}`,
      fitsPage ? undefined : "layout does not fit one page or layoutReport missing",
      bulletWidthPass ? undefined : `bulletLineCountInvalid=${invalidBullets.length}`,
      naturalBulletEndingsPass ? undefined : `danglingBulletEndings=${danglingBullets.length}`,
      enoughCoreBullets ? undefined : `bulletLayouts=${bulletLayouts.length}`,
      enoughPageUsage ? undefined : `pageUsage=${contentHeightPx ?? "unknown"}/${usableHeightPx ?? "unknown"}`,
      semanticPass ? undefined : `semanticJdMatchScore=${semanticScore}`,
      hasSections ? undefined : "section text not found in PDF",
    ].filter(Boolean),
  };
}

function hasDanglingBulletEnding(text: string): boolean {
  const cleaned = stripBulletEnding(text);
  if (!cleaned) return true;
  const finalSegment = stripBulletEnding(cleaned.split(/[，。；;、,]/u).pop() ?? cleaned);
  return isDanglingBulletSegment(cleaned) || (finalSegment !== cleaned && isDanglingBulletSegment(finalSegment));
}

function isDanglingBulletSegment(text: string): boolean {
  const cleaned = stripBulletEnding(text);
  if (!cleaned) return true;
  if (/[（(][^）)]*$/u.test(cleaned) || /[《“"'][^》”"']*$/u.test(cleaned)) return true;
  if (/[A-Za-z]+-$/u.test(cleaned)) return true;
  if (/[:：]\s*[^，。；;、,]{0,8}$/u.test(cleaned)) return true;
  if (/^(支持|用于|基于|围绕|通过|使用|采用|覆盖|实现|提升|处理|构建|设计|主导|负责|参与|协同|优化|提取).{0,6}$/u.test(cleaned)) return true;
  if (/(基于|围绕|通过|使用|采用|覆盖|支持|用于|实现|提升|处理|构建|设计|主导|负责|参与|协同|以及|包括|例如|如|与|和|及|或|并|为|将|在|中|的)$/u.test(cleaned)) return true;
  if (/处理\d{1,2}$/u.test(cleaned)) return true;
  if (/智能监$/u.test(cleaned)) return true;
  if (/^在.+(?:中|下|里|内|上|前|后|阶段|项目|系统|实习生|工程师|负责人)?$/u.test(cleaned) && !/[，。；;]/u.test(cleaned)) return true;
  return false;
}

function stripBulletEnding(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[。！？!?；;，、,.\s]+$/u, "").trim();
}

function readLayoutReport(exportRecord: JsonRecord): JsonRecord | undefined {
  const quality = isRecord(exportRecord.qualityReport) ? exportRecord.qualityReport : undefined;
  return isRecord(quality?.layoutReport) ? quality.layoutReport : undefined;
}

async function extractPdfInfo(buffer: Buffer): Promise<JsonRecord> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.js");
  const data = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;
  const texts: string[] = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    const text = content.items
      .map((item: unknown) => isRecord(item) && typeof item.str === "string" ? item.str : "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    texts.push(text);
  }
  return {
    pageCount: doc.numPages,
    text: texts.join("\n"),
    textLength: texts.join("\n").length,
    header: buffer.subarray(0, 5).toString("utf8"),
    bytes: buffer.length,
  };
}

async function pollJob(jobId: string): Promise<JsonRecord> {
  return poll(`job ${jobId}`, async () => {
    const job = await getJson<JsonRecord>(`/jobs/${jobId}`);
    const status = readString(job, "status");
    if (status === "completed" || status === "failed" || status === "cancelled") return job;
    return undefined;
  });
}

async function pollExport(exportId: string, jobId: string): Promise<JsonRecord> {
  return poll(`export ${exportId}`, async () => {
    const exportRecord = await getJson<JsonRecord>(`/exports/${exportId}`);
    const status = readString(exportRecord, "status");
    if (status === "completed" || status === "failed") return exportRecord;
    const job = await getJson<JsonRecord>(`/jobs/${jobId}`).catch(() => undefined);
    const jobStatus = isRecord(job) ? readString(job, "status") : undefined;
    if (jobStatus === "failed" || jobStatus === "cancelled") return exportRecord;
    if (process.env.PHASE3_RENDER_FALLBACK === "1") {
      await postJson<JsonRecord>(`/exports/${exportId}/render`, {}).catch(() => undefined);
    }
    return undefined;
  });
}

async function poll<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await read();
    if (result) return result;
    await sleep(pollIntervalMs);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function getJson<T>(path: string): Promise<T> {
  return requestJson<T>(path, { method: "GET" });
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function requestJson<T>(pathName: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers: {
      "x-user-id": userId,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${init.method ?? "GET"} ${pathName} returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${pathName} HTTP ${response.status}: ${JSON.stringify(parsed).slice(0, 500)}`);
  }
  if (isRecord(parsed) && parsed.ok === true && "data" in parsed) return parsed.data as T;
  if (isRecord(parsed) && parsed.ok === false) throw new Error(`${init.method ?? "GET"} ${pathName}: ${JSON.stringify(parsed.error ?? parsed)}`);
  return parsed as T;
}

async function downloadBuffer(pathName: string): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await fetch(`${baseUrl}${pathName}`, { headers: { "x-user-id": userId } });
  const arrayBuffer = await response.arrayBuffer();
  if (!response.ok) throw new Error(`download ${pathName} HTTP ${response.status}: ${Buffer.from(arrayBuffer).toString("utf8").slice(0, 300)}`);
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get("content-type") ?? "",
  };
}

function extractPendingActionId(response: JsonRecord): string | undefined {
  return readString(response, "pendingActionId")
    ?? readString(response, "pendingAction.id")
    ?? readString(response, "action.id")
    ?? findStringByKey(response, "pendingActionId");
}

function extractGenerationJobId(response: JsonRecord): string | undefined {
  return readString(response, "jobId")
    ?? readString(response, "job.id")
    ?? readString(response, "backgroundJob.id")
    ?? findStringByKey(response, "jobId")
    ?? findStringByKey(response, "backgroundJobId");
}

function findStringByKey(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key && typeof entryValue === "string") return entryValue;
    if (isRecord(entryValue)) {
      const found = findStringByKey(entryValue, key);
      if (found) return found;
    }
    if (Array.isArray(entryValue)) {
      for (const item of entryValue) {
        const found = findStringByKey(item, key);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function readString(value: unknown, pathName: string): string | undefined {
  const valueAtPath = pathName.split(".").reduce<unknown>((current, key) => {
    if (!isRecord(current)) return undefined;
    return current[key];
  }, value);
  return typeof valueAtPath === "string" && valueAtPath.trim() ? valueAtPath : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
