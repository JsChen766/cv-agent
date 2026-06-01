import { randomUUID } from "node:crypto";

const baseUrl = (process.env.DEBUG_FLOW_API_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const userId = process.env.DEBUG_FLOW_USER_ID || "debug-flow-user";
const timeoutMs = Number(process.env.DEBUG_FLOW_TIMEOUT_MS || 120_000);
const pollIntervalMs = Number(process.env.DEBUG_FLOW_POLL_INTERVAL_MS || 1500);
let sessionCookie = process.env.DEBUG_FLOW_COOKIE || "";
const bearerToken = process.env.DEBUG_FLOW_BEARER_TOKEN || "";

type ApiEnvelope<T> = { ok: true; data: T; meta?: Record<string, unknown> } | { ok: false; error?: { message?: string }; meta?: Record<string, unknown> };
type JsonRecord = Record<string, unknown>;

const jdText = [
  "Senior Frontend Engineer",
  "We need a Vue and TypeScript engineer to build reliable product dashboards, improve performance, own export flows,",
  "collaborate with backend engineers, and ship tested user-facing workflows.",
].join("\n");

async function main() {
  console.log("[debug-flow] start", { baseUrl, userId, timeoutMs });
  await ensureAuth();

  const chat = await postJson<JsonRecord>("/copilot/chat", {
    message: "Create a debug session for resume generation.",
  });
  const sessionId = readString(chat, "sessionId");
  assert(sessionId, "copilot chat did not return sessionId");
  console.log("[debug-flow] session", { sessionId });

  const actionResponse = await postJson<JsonRecord>("/copilot/actions", {
    sessionId,
    action: {
      type: "generate_from_jd",
      payload: {
        jdText,
        targetRole: "Senior Frontend Engineer",
      },
    },
    clientState: {},
  });
  const pendingActionId = extractPendingActionId(actionResponse);
  assert(pendingActionId, "generate_from_jd did not create a pending action");
  console.log("[debug-flow] pending action", { pendingActionId });

  const confirmResponse = await postJson<JsonRecord>(`/copilot/pending-actions/${pendingActionId}/confirm`, {});
  const jobId = extractGenerationJobId(confirmResponse);
  assert(jobId, "confirm response did not include generation jobId");
  console.log("[debug-flow] generation job", { jobId });

  const generationJob = await pollJob(jobId);
  assert(generationJob.status === "completed", `generation job did not complete: ${generationJob.status} ${generationJob.errorMessage ?? ""}`);
  const generationId = readString(generationJob.output, "generationId");
  assert(generationId, "generation job completed but output.generationId is missing");
  console.log("[debug-flow] generation completed", {
    generationId,
    output: generationJob.output,
  });

  const generation = await getJson<JsonRecord>(`/product/generations/${generationId}`);
  const variants = Array.isArray(generation.variants) ? generation.variants : [];
  assert(variants.length > 0, "GET /product/generations/:id returned no variants");
  const firstVariant = variants[0];
  assert(isRecord(firstVariant), "first variant is not an object");
  const variantId = readString(firstVariant, "id");
  assert(variantId, "first variant has no id");
  console.log("[debug-flow] generation detail", { generationId, variantCount: variants.length, variantId });

  const accepted = await postJson<JsonRecord>(`/product/generations/${generationId}/accept-variant`, { variantId });
  const resume = isRecord(accepted.resume) ? accepted.resume : undefined;
  const resumeId = readString(accepted, "resumeId") || readString(resume, "id");
  assert(resumeId, "accept-variant did not return resumeId/resume.id");
  console.log("[debug-flow] accepted variant", { resumeId });

  const exportCreated = await postJson<JsonRecord>(`/exports/resumes/${resumeId}`, { format: "html" });
  const exportRecord = isRecord(exportCreated.exportRecord) ? exportCreated.exportRecord : exportCreated;
  const exportId = readString(exportRecord, "id");
  const exportJobId = readString(exportCreated.job, "id") || readString(exportRecord, "jobId");
  assert(exportId, "create export did not return exportRecord.id");
  assert(exportJobId, "create export did not return export job id");
  console.log("[debug-flow] export created", {
    exportId,
    exportJobId,
    status: readString(exportRecord, "status"),
  });

  const completedExport = await pollExport(exportId, exportJobId);
  assert(readString(completedExport, "status") === "completed", `export did not complete: ${readString(completedExport, "status")}`);
  assert(readString(completedExport, "fileId"), "completed export is missing fileId");

  const download = await request(`/exports/${exportId}/download`, { method: "GET" });
  assert(download.response.status === 200, `download returned HTTP ${download.response.status}`);
  assert(download.text.length > 0, "download response body is empty");
  console.log("[debug-flow] success", {
    sessionId,
    pendingActionId,
    jobId,
    generationId,
    variantCount: variants.length,
    resumeId,
    exportId,
    fileId: readString(completedExport, "fileId"),
    downloadBytes: Buffer.byteLength(download.text),
  });
}

async function pollJob(jobId: string): Promise<JsonRecord> {
  return poll(`job ${jobId}`, async () => {
    const job = await getJson<JsonRecord>(`/jobs/${jobId}`);
    console.log("[debug-flow] job poll", {
      jobId,
      status: job.status,
      output: job.output,
      errorMessage: job.errorMessage,
    });
    const status = String(job.status || "");
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
    console.log("[debug-flow] export poll", {
      exportId,
      exportStatus: exportRecord.status,
      fileId: exportRecord.fileId,
      jobId,
      jobStatus: job.status,
      jobErrorMessage: job.errorMessage,
    });
    const exportStatus = String(exportRecord.status || "");
    const jobStatus = String(job.status || "");
    if (exportStatus === "completed" || exportStatus === "failed" || jobStatus === "failed" || jobStatus === "cancelled") return exportRecord;
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

async function getJson<T extends JsonRecord>(path: string): Promise<T> {
  return requestJson<T>(path, { method: "GET" });
}

async function postJson<T extends JsonRecord>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "idempotency-key": `debug-flow-${randomUUID()}`,
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

async function request(path: string, init: RequestInit): Promise<{ response: Response; text: string }> {
  const headers = new Headers(init.headers);
  headers.set("x-user-id", userId);
  if (sessionCookie) headers.set("cookie", sessionCookie);
  if (bearerToken) headers.set("authorization", `Bearer ${bearerToken}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    sessionCookie = setCookie.split(";")[0] || sessionCookie;
  }
  const text = await response.text();
  return { response, text };
}

async function ensureAuth(): Promise<void> {
  if (sessionCookie || bearerToken) {
    console.log("[debug-flow] auth", {
      mode: sessionCookie ? "cookie" : "bearer",
    });
    return;
  }
  try {
    const login = await request("/auth/dev-login", {
      method: "POST",
      body: JSON.stringify({
        email: `${userId}@example.test`,
        displayName: "Debug Flow User",
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": `debug-login-${randomUUID()}`,
      },
    });
    if (login.response.ok && sessionCookie) {
      console.log("[debug-flow] auth", { mode: "dev-login", userId });
      return;
    }
    console.warn("[debug-flow] dev-login unavailable", {
      status: login.response.status,
      body: login.text.slice(0, 300),
    });
  } catch (error) {
    console.warn("[debug-flow] dev-login failed", error instanceof Error ? error.message : error);
  }
  console.log("[debug-flow] continuing with x-user-id header only; set DEBUG_FLOW_COOKIE or DEBUG_FLOW_BEARER_TOKEN if the API uses session auth.");
}

function extractPendingActionId(response: JsonRecord): string | undefined {
  const raw = isRecord(response.raw) ? response.raw : {};
  const pendingActions = Array.isArray(raw.pendingActions) ? raw.pendingActions : [];
  for (const action of pendingActions) {
    if (!isRecord(action)) continue;
    if (readString(action, "toolName") === "generate_resume_from_jd" || readString(action, "tool") === "generate_resume_from_jd") {
      return readString(action, "id") || readString(action, "pendingActionId");
    }
  }
  return findStringByKey(response, "pendingActionId");
}

function extractGenerationJobId(response: JsonRecord): string | undefined {
  const roots: unknown[] = [response];
  if (isRecord(response.raw)) {
    roots.push(response.raw);
    const actionResults = Array.isArray(response.raw.actionResults) ? response.raw.actionResults : [];
    for (const result of actionResults) {
      if (!isRecord(result)) continue;
      const metadata = isRecord(result.metadata) ? result.metadata : {};
      const jobId = readString(metadata, "jobId");
      if (jobId) return jobId;
    }
    const toolResults = Array.isArray(response.raw.toolResults) ? response.raw.toolResults : [];
    for (const result of toolResults) {
      if (!isRecord(result)) continue;
      const data = isRecord(result.data) ? result.data : {};
      const jobId = readString(data, "jobId");
      if (jobId) return jobId;
    }
  }
  return findStringByKey(roots, "jobId");
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
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
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
  console.error("[debug-flow] failed", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
