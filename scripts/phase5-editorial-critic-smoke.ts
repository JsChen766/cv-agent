import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type ApiEnvelope<T> =
  | { ok: true; data: T; meta?: Record<string, unknown> }
  | { ok: false; error?: { message?: string }; meta?: Record<string, unknown> };

type JsonRecord = Record<string, unknown>;

const baseUrl = (process.env.PHASE5_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const userId = process.env.PHASE5_USER_ID || "dev-user";
const timeoutMs = Number(process.env.PHASE5_TIMEOUT_MS || 240_000);
const pollIntervalMs = Number(process.env.PHASE5_POLL_INTERVAL_MS || 1500);
const outDir = path.resolve(process.cwd(), process.env.PHASE5_OUTPUT_DIR || "docs/temp_pdf");
const existingJobId = process.env.PHASE5_EXISTING_JOB_ID;

const targetRole = "AI Product Data Analyst Intern";
const jdText = [
  "Role: AI Product Data Analyst Intern",
  "The team needs an intern who can analyze AI product usage, build SQL/Python dashboards, track model evaluation metrics, summarize customer feedback, and translate findings into product iteration recommendations.",
  "Strong candidates should show evidence of analytics delivery, cross-functional communication, AI/data project documentation, and metric-driven product decisions.",
].join("\n");

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const health = await getJson<JsonRecord>("/health");
  let experience: JsonRecord | undefined;
  let jobId = existingJobId;
  if (!jobId) {
    experience = await postJson<JsonRecord>("/product/experiences", {
      title: "AI product analytics dashboard",
      role: "Data Analyst",
      organization: "Campus AI Lab",
      content: [
        "Built a SQL and Python dashboard tracking model evaluation, feature usage, and feedback triage for an AI assistant pilot.",
        "Reduced weekly reporting time by 40% by standardizing metric definitions and automating stakeholder snapshots.",
        "Partnered with product and engineering peers to convert user feedback into prioritized iteration notes.",
      ].join("\n"),
    });

    const queued = await postJson<JsonRecord>("/product/generations/from-jd", {
      jdText,
      targetRole,
    });
    jobId = readString(queued, "jobId") ?? readString(queued.job, "id");
    if (!jobId) throw new Error("Generation job id was not returned.");
  }

  const job = await pollJob(jobId);
  if (readString(job, "status") !== "completed") {
    throw new Error(`Generation job ${jobId} ended as ${readString(job, "status")}: ${readString(job, "errorMessage") ?? ""}`);
  }
  const output = isRecord(job.output) ? job.output : {};
  const generationId = readString(output, "generationId");
  if (!generationId) throw new Error("Completed job did not expose generationId.");
  const jobReview = isRecord(output.editorialCriticReview) ? output.editorialCriticReview : {};
  const jobPatchSuggestions = Array.isArray(output.criticPatchSuggestions)
    ? output.criticPatchSuggestions.filter(isRecord)
    : [];

  const generation = await getJson<JsonRecord>(`/product/generations/${generationId}`);
  const outputSnapshot = isRecord(generation.outputSnapshot) ? generation.outputSnapshot : {};
  const review = isRecord(outputSnapshot.editorialCriticReview) ? outputSnapshot.editorialCriticReview : {};
  const patchSuggestions = Array.isArray(outputSnapshot.criticPatchSuggestions)
    ? outputSnapshot.criticPatchSuggestions.filter(isRecord)
    : [];
  const snapshots = Array.isArray(outputSnapshot.resumePreviewSnapshots)
    ? outputSnapshot.resumePreviewSnapshots.filter(isRecord)
    : [];
  const workflow = isRecord(outputSnapshot.resumeOptimizationRun) ? outputSnapshot.resumeOptimizationRun : {};

  const items = Array.isArray(review.items) ? review.items.filter(isRecord) : [];
  const reviewSummary = isRecord(review.summary) ? review.summary : {};
  const criticStage = Array.isArray(workflow.stages)
    ? workflow.stages.filter(isRecord).find((stage) => readString(stage, "stage") === "critic_review")
    : undefined;
  const beforeAfterPatch = patchSuggestions.find((suggestion) => {
    const patch = isRecord(suggestion.patch) ? suggestion.patch : {};
    const before = readString(patch, "before");
    const after = readString(patch, "after");
    return Boolean(before && after && before !== after);
  });
  const repairedSnapshot = snapshots.find((snapshot) => readString(snapshot, "stage") === "critic_repaired_draft");

  assert(readString(jobReview, "reviewId"), "job output is missing editorialCriticReview");
  assert(jobPatchSuggestions.length > 0, "job output is missing criticPatchSuggestions");
  assert(Number(reviewSummary.totalItems) > 0, "editorial critic produced no review items");
  assert(items.length > 0, "review.items is empty");
  assert(patchSuggestions.length > 0, "criticPatchSuggestions is empty");
  assert(Boolean(beforeAfterPatch), "no patch suggestion contained a before/after delta");
  assert(Boolean(repairedSnapshot), "critic_repaired_draft snapshot is missing");
  assert(readString(criticStage, "status") === "completed", "critic_review workflow stage is not completed");

  const result = {
    baseUrl,
    userId,
    health,
    experienceId: readString(experience, "id"),
    jobId,
    generationId,
    criticReviewId: readString(review, "reviewId"),
    criticStatus: readString(review, "status"),
    criticItemCount: items.length,
    patchSuggestionCount: patchSuggestions.length,
    categories: items.map((item) => readString(item, "category")).filter(Boolean),
    snapshotStages: snapshots.map((snapshot) => readString(snapshot, "stage")).filter(Boolean),
    criticStage,
  };
  const resultPath = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_phase5_editorial_critic_smoke.json`);
  await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");

  console.log("PHASE5_EDITORIAL_CRITIC_SMOKE_RESULT_START");
  console.log(JSON.stringify({ ...result, resultPath }, null, 2));
  console.log("PHASE5_EDITORIAL_CRITIC_SMOKE_RESULT_END");
  console.log("PHASE5_EDITORIAL_CRITIC_SMOKE_PASS");
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
      "idempotency-key": `phase5-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  });
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

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
