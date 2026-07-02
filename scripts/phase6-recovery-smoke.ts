import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type ApiEnvelope<T> =
  | { ok: true; data: T; meta?: Record<string, unknown> }
  | { ok: false; error?: { message?: string }; meta?: Record<string, unknown> };

type JsonRecord = Record<string, unknown>;

const baseUrl = (process.env.PHASE6_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const userId = process.env.PHASE6_USER_ID || "dev-user";
const timeoutMs = Number(process.env.PHASE6_TIMEOUT_MS || 300_000);
const pollIntervalMs = Number(process.env.PHASE6_POLL_INTERVAL_MS || 1500);
const outDir = path.resolve(process.cwd(), process.env.PHASE6_OUTPUT_DIR || "docs/temp_pdf");

const targetRole = "AI Product Data Analyst Intern";
const jdText = [
  "Role: AI Product Data Analyst Intern",
  "The team needs an intern who can analyze AI product usage, build SQL/Python dashboards, track model evaluation metrics, summarize customer feedback, and translate findings into product iteration recommendations.",
  "Strong candidates should show analytics delivery, cross-functional communication, AI/data project documentation, and metric-driven product decisions.",
].join("\n");

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const health = await getJson<JsonRecord>("/health");

  const missingJd = await postJsonExpectError("/product/generations/from-jd", {});
  assert(missingJd.status === 400, "Missing JD request did not return HTTP 400.");
  assert((missingJd.message ?? "").includes("jdText or jdId is required"), "Missing JD error message was not actionable.");

  const experience = await postJson<JsonRecord>("/product/experiences", {
    title: "AI product analytics dashboard",
    role: "Data Analyst",
    organization: "Campus AI Lab",
    content: [
      "Built SQL and Python dashboards tracking model evaluation, feature usage, and feedback triage for an AI assistant pilot.",
      "Reduced weekly reporting time by 40% by standardizing metric definitions and automating stakeholder snapshots.",
      "Partnered with product and engineering peers to convert user feedback into prioritized iteration notes.",
    ].join("\n"),
  });

  const queued = await postJson<JsonRecord>("/product/generations/from-jd", {
    jdText,
    targetRole,
  });
  const generationJobId = readString(queued, "jobId") ?? readString(queued.job, "id");
  assert(generationJobId, "Generation job id was not returned.");

  const generationJob = await pollJob(generationJobId);
  assert(readString(generationJob, "status") === "completed", `Generation job ended as ${readString(generationJob, "status")}.`);
  const output = isRecord(generationJob.output) ? generationJob.output : {};
  const generationId = readString(output, "generationId");
  assert(generationId, "Completed generation job did not expose generationId.");

  const workflow = isRecord(output.workflowStatus) ? output.workflowStatus : {};
  assert(readString(workflow, "currentStage") === "change_set_ready", "Workflow did not reach change_set_ready.");
  assert(workflow.recoveryPlan === undefined, "Successful generation unexpectedly carried a recovery plan.");
  const variants = Array.isArray(output.variants) ? output.variants.filter(isRecord) : [];
  const variantId = readString(variants[0], "id");
  assert(variantId, "Completed generation did not expose a variant id.");

  const accepted = await postJson<JsonRecord>(`/product/generations/${generationId}/accept-variant`, {
    variantId,
  });
  const resume = isRecord(accepted.resume) ? accepted.resume : {};
  const resumeId = readString(resume, "id");
  assert(resumeId, "Accept variant did not return resume id.");

  const exportQueued = await postJson<JsonRecord>(`/exports/resumes/${resumeId}`, {
    format: "pdf",
    templateId: "one-page-modern",
  });
  const exportRecord = isRecord(exportQueued.exportRecord) ? exportQueued.exportRecord : {};
  const exportJob = isRecord(exportQueued.job) ? exportQueued.job : {};
  const exportId = readString(exportRecord, "id");
  const exportJobId = readString(exportJob, "id");
  assert(exportId, "Export id was not returned.");
  assert(exportJobId, "Export job id was not returned.");

  const completedExportJob = await pollJob(exportJobId);
  assert(readString(completedExportJob, "status") === "completed", `Export job ended as ${readString(completedExportJob, "status")}.`);
  const completedExport = await getJson<JsonRecord>(`/exports/${exportId}`);
  assert(readString(completedExport, "status") === "completed", "Export record was not completed.");

  const pdfBytes = await getBytes(`/exports/${exportId}/download`);
  assert(Buffer.from(pdfBytes.slice(0, 4)).toString("utf8") === "%PDF", "Downloaded export was not a PDF.");

  const result = {
    baseUrl,
    userId,
    health,
    missingJd,
    experienceId: readString(experience, "id"),
    generationJobId,
    generationId,
    workflowStage: readString(workflow, "currentStage"),
    workflowRecoveryPlan: workflow.recoveryPlan ?? null,
    variantId,
    resumeId,
    exportId,
    exportJobId,
    pdfBytes: pdfBytes.byteLength,
    exportQualityReportPresent: isRecord(completedExport.qualityReport),
  };
  const resultPath = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_phase6_recovery_smoke.json`);
  await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");

  console.log("PHASE6_RECOVERY_SMOKE_RESULT_START");
  console.log(JSON.stringify({ ...result, resultPath }, null, 2));
  console.log("PHASE6_RECOVERY_SMOKE_RESULT_END");
  console.log("PHASE6_RECOVERY_SMOKE_PASS");
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

async function getJson<T>(urlPath: string): Promise<T> {
  return requestJson<T>(urlPath, { method: "GET" });
}

async function postJson<T>(urlPath: string, body: unknown): Promise<T> {
  return requestJson<T>(urlPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `phase6-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  });
}

async function postJsonExpectError(urlPath: string, body: unknown): Promise<{ status: number; message?: string }> {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": userId,
      "idempotency-key": `phase6-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return { status: response.status, message: text.slice(0, 500) };
  }
  const envelope = parsed as ApiEnvelope<unknown>;
  if (isRecord(envelope) && envelope.ok === false) {
    return { status: response.status, message: envelope.error?.message };
  }
  return { status: response.status, message: text.slice(0, 500) };
}

async function requestJson<T>(urlPath: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-user-id", userId);
  const response = await fetch(`${baseUrl}${urlPath}`, { ...init, headers });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${init.method || "GET"} ${urlPath} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${urlPath} failed HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
  const envelope = parsed as ApiEnvelope<T>;
  if (isRecord(envelope) && envelope.ok === true) return envelope.data;
  if (isRecord(envelope) && envelope.ok === false) {
    throw new Error(`${init.method || "GET"} ${urlPath} failed: ${envelope.error?.message ?? text.slice(0, 1000)}`);
  }
  return parsed as T;
}

async function getBytes(urlPath: string): Promise<Uint8Array> {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: "GET",
    headers: { "x-user-id": userId },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GET ${urlPath} failed HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
