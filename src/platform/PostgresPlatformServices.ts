import { randomUUID } from "node:crypto";
import { ApiError, ErrorCodes } from "../api/errors.js";
import type { PostgresQueryable } from "../persistence/postgres/PostgresDatabase.js";
import { readPlatformConfig } from "./config.js";
import type {
  AgentRun,
  AgentToolRun,
  BackgroundJob,
  BackgroundJobStatus,
  IdempotencyBeginResult,
  IdempotencyEntry,
  PlatformServices,
  UsageMetric,
} from "./types.js";

export class PostgresPlatformServices implements PlatformServices {
  public readonly idempotency: PlatformServices["idempotency"];
  public readonly sessionLocks: PlatformServices["sessionLocks"];
  public readonly usage: PlatformServices["usage"];
  public readonly agentRuns: PlatformServices["agentRuns"];
  public readonly backgroundJobs: PlatformServices["backgroundJobs"];

  public constructor(private readonly database: PostgresQueryable) {
    this.idempotency = new PostgresIdempotencyService(database);
    this.sessionLocks = new PostgresSessionLockService(database);
    this.usage = new PostgresUsageService(database);
    this.agentRuns = new PostgresAgentRunService(database);
    this.backgroundJobs = new PostgresBackgroundJobService(database);
  }
}

class PostgresIdempotencyService {
  public constructor(private readonly database: PostgresQueryable) {}

  public async begin(input: {
    userId: string;
    key: string;
    requestMethod: string;
    requestPath: string;
    requestHash: string;
    ttlMs?: number;
  }): Promise<IdempotencyBeginResult> {
    const existing = await this.find(input.userId, input.key);
    const now = new Date();
    if (existing && new Date(existing.expiresAt).getTime() > now.getTime()) {
      if (existing.requestHash !== input.requestHash) return { type: "conflict", entry: existing, reason: "hash_mismatch" };
      if (existing.status === "completed") return { type: "replay", entry: existing };
      return { type: "conflict", entry: existing, reason: "pending" };
    }
    const entry: IdempotencyEntry = {
      id: `idem-${randomUUID()}`,
      userId: input.userId,
      key: input.key,
      requestMethod: input.requestMethod,
      requestPath: input.requestPath,
      requestHash: input.requestHash,
      status: "pending",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 24 * 60 * 60 * 1000)).toISOString(),
    };
    await this.database.query(
      `INSERT INTO api_idempotency_key (id, user_id, key, request_method, request_path, request_hash, status, created_at, updated_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [entry.id, entry.userId, entry.key, entry.requestMethod, entry.requestPath, entry.requestHash, entry.status, entry.createdAt, entry.updatedAt, entry.expiresAt],
    );
    return { type: "started", entry };
  }

  public async complete(userId: string, key: string, responseStatus: number, responseBody: unknown): Promise<void> {
    await this.database.query(
      `UPDATE api_idempotency_key SET status='completed', response_status=$3, response_body_json=$4, updated_at=$5 WHERE user_id=$1 AND key=$2`,
      [userId, key, responseStatus, JSON.stringify(responseBody), new Date().toISOString()],
    );
  }

  public async fail(userId: string, key: string): Promise<void> {
    await this.database.query(`UPDATE api_idempotency_key SET status='failed', updated_at=$3 WHERE user_id=$1 AND key=$2`, [userId, key, new Date().toISOString()]);
  }

  private async find(userId: string, key: string): Promise<IdempotencyEntry | null> {
    const result = await this.database.query<any>(`SELECT * FROM api_idempotency_key WHERE user_id=$1 AND key=$2 ORDER BY created_at DESC LIMIT 1`, [userId, key]);
    const row = result.rows[0];
    return row ? mapIdempotency(row) : null;
  }
}

class PostgresSessionLockService {
  public constructor(private readonly database: PostgresQueryable) {}

  public async acquire(input: { userId: string; sessionId: string; ownerRequestId: string; ttlMs?: number }): Promise<boolean> {
    const now = new Date();
    const existing = await this.database.query<any>(`SELECT * FROM copilot_session_lock WHERE session_id=$1`, [input.sessionId]);
    const row = existing.rows[0];
    if (row && row.user_id === input.userId && new Date(row.locked_until).getTime() > now.getTime()) {
      return row.owner_request_id === input.ownerRequestId;
    }
    await this.database.query(`DELETE FROM copilot_session_lock WHERE session_id=$1`, [input.sessionId]);
    await this.database.query(
      `INSERT INTO copilot_session_lock (session_id, user_id, owner_request_id, locked_until, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.sessionId, input.userId, input.ownerRequestId, new Date(now.getTime() + (input.ttlMs ?? readPlatformConfig().sessionLockTtlMs)).toISOString(), now.toISOString(), now.toISOString()],
    );
    return true;
  }

  public async release(input: { userId: string; sessionId: string; ownerRequestId: string }): Promise<void> {
    await this.database.query(`DELETE FROM copilot_session_lock WHERE session_id=$1 AND user_id=$2 AND owner_request_id=$3`, [input.sessionId, input.userId, input.ownerRequestId]);
  }
}

class PostgresUsageService {
  public constructor(private readonly database: PostgresQueryable) {}

  public async checkRequest(input: { userId?: string; ip?: string }): Promise<void> {
    const config = readPlatformConfig();
    if (!config.rateLimitEnabled) return;
    if (input.userId) await this.increment({ userId: input.userId, bucket: "per_minute", metric: "request", limit: config.perUserPerMinute });
    if (input.ip) await this.increment({ ip: input.ip, bucket: "per_minute", metric: "request", limit: config.perIpPerMinute });
  }

  public async consume(input: { userId: string; metric: UsageMetric; amount?: number }): Promise<void> {
    const config = readPlatformConfig();
    const limit = input.metric === "message"
      ? config.dailyMessageQuota
      : input.metric === "tool_call"
        ? config.dailyToolCallQuota
        : input.metric === "generation"
          ? config.dailyGenerationQuota
          : Number.MAX_SAFE_INTEGER;
    await this.increment({ userId: input.userId, bucket: "daily", metric: input.metric, limit, amount: input.amount });
  }

  private async increment(input: { userId?: string; ip?: string; bucket: string; metric: UsageMetric; limit: number; amount?: number }): Promise<void> {
    const amount = input.amount ?? 1;
    const resetAt = new Date(Date.now() + (input.bucket === "daily" ? 24 * 60 * 60 * 1000 : 60_000)).toISOString();
    const key = `${input.userId ?? ""}:${input.ip ?? ""}:${input.bucket}:${input.metric}`;
    const existing = await this.database.query<any>(`SELECT * FROM api_usage_counter WHERE id=$1`, [key]);
    const row = existing.rows[0];
    const count = !row || new Date(row.reset_at).getTime() <= Date.now() ? amount : Number(row.count) + amount;
    if (count > input.limit) {
      throw new ApiError(input.metric === "request" ? ErrorCodes.RATE_LIMITED : ErrorCodes.QUOTA_EXCEEDED, "Usage limit exceeded.", 429, { retryable: true });
    }
    await this.database.query(
      `INSERT INTO api_usage_counter (id, user_id, ip, bucket, metric, count, reset_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
       ON CONFLICT (id) DO UPDATE SET count=$6, reset_at=$7, updated_at=$8`,
      [key, input.userId ?? null, input.ip ?? null, input.bucket, input.metric, count, row && new Date(row.reset_at).getTime() > Date.now() ? row.reset_at : resetAt, new Date().toISOString()],
    );
  }
}

class PostgresAgentRunService {
  public constructor(private readonly database: PostgresQueryable) {}

  public async createRun(input: Omit<AgentRun, "status" | "toolCallCount" | "createdAt">): Promise<AgentRun> {
    const run: AgentRun = { ...input, status: "running", toolCallCount: 0, createdAt: new Date().toISOString() };
    await this.database.query(
      `INSERT INTO agent_run (id,user_id,session_id,turn_id,request_id,mode,model,status,decision_mode,tool_call_count,error_code,error_message,latency_ms,token_usage_json,created_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [run.id, run.userId, run.sessionId ?? null, run.turnId ?? null, run.requestId, run.mode, run.model ?? null, run.status, run.decisionMode ?? null, run.toolCallCount, null, null, null, JSON.stringify(run.tokenUsage ?? {}), run.createdAt, null],
    );
    return run;
  }

  public async completeRun(id: string, patch: Partial<AgentRun>): Promise<void> {
    await this.updateRun(id, "completed", patch);
  }

  public async failRun(id: string, patch: Partial<AgentRun>): Promise<void> {
    await this.updateRun(id, "failed", patch);
  }

  public async createToolRun(input: Omit<AgentToolRun, "status" | "createdAt">): Promise<AgentToolRun> {
    const tool: AgentToolRun = { ...input, status: "running", createdAt: new Date().toISOString() };
    await this.database.query(
      `INSERT INTO agent_tool_run (id,agent_run_id,user_id,session_id,tool_name,status,latency_ms,error_code,error_message,input_summary_json,output_summary_json,created_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tool.id, tool.agentRunId, tool.userId, tool.sessionId ?? null, tool.toolName, tool.status, null, null, null, JSON.stringify(tool.inputSummary ?? {}), null, tool.createdAt, null],
    );
    await this.database.query(`UPDATE agent_run SET tool_call_count=tool_call_count+1 WHERE id=$1`, [tool.agentRunId]);
    return tool;
  }

  public async completeToolRun(id: string, patch: Partial<AgentToolRun>): Promise<void> {
    await this.database.query(
      `UPDATE agent_tool_run SET status=$2, latency_ms=$3, error_code=$4, error_message=$5, output_summary_json=$6, completed_at=$7 WHERE id=$1`,
      [id, patch.status ?? "completed", patch.latencyMs ?? null, patch.errorCode ?? null, patch.errorMessage ?? null, JSON.stringify(patch.outputSummary ?? {}), new Date().toISOString()],
    );
  }

  public async listRuns(userId: string, limit = 50): Promise<AgentRun[]> {
    const result = await this.database.query<any>(`SELECT * FROM agent_run WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
    return result.rows.map(mapAgentRun);
  }

  public async getRun(userId: string, id: string): Promise<{ run: AgentRun; tools: AgentToolRun[] } | null> {
    const runResult = await this.database.query<any>(`SELECT * FROM agent_run WHERE user_id=$1 AND id=$2`, [userId, id]);
    const row = runResult.rows[0];
    if (!row) return null;
    const tools = await this.database.query<any>(`SELECT * FROM agent_tool_run WHERE user_id=$1 AND agent_run_id=$2 ORDER BY created_at ASC`, [userId, id]);
    return { run: mapAgentRun(row), tools: tools.rows.map(mapToolRun) };
  }

  private async updateRun(id: string, status: string, patch: Partial<AgentRun>): Promise<void> {
    await this.database.query(
      `UPDATE agent_run SET status=$2, decision_mode=$3, error_code=$4, error_message=$5, latency_ms=$6, completed_at=$7 WHERE id=$1`,
      [id, status, patch.decisionMode ?? null, patch.errorCode ?? null, patch.errorMessage ?? null, patch.latencyMs ?? null, new Date().toISOString()],
    );
  }
}

class PostgresBackgroundJobService {
  public constructor(private readonly database: PostgresQueryable) {}

  public async createJob(input: Omit<BackgroundJob, "id" | "status" | "attempts" | "createdAt" | "updatedAt">): Promise<BackgroundJob> {
    const now = new Date().toISOString();
    const job: BackgroundJob = { ...input, id: `job-${randomUUID()}`, status: "pending", attempts: 0, createdAt: now, updatedAt: now };
    await this.database.query(
      `INSERT INTO background_job (id,user_id,type,status,input_json,output_json,error_message,attempts,created_at,updated_at,run_after,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [job.id, job.userId, job.type, job.status, JSON.stringify(job.input ?? {}), null, null, job.attempts, job.createdAt, job.updatedAt, job.runAfter ?? null, null],
    );
    return job;
  }

  public async getJob(userId: string, id: string): Promise<BackgroundJob | null> {
    const result = await this.database.query<any>(`SELECT * FROM background_job WHERE user_id=$1 AND id=$2`, [userId, id]);
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  public async listJobs(userId: string, limit = 50): Promise<BackgroundJob[]> {
    const result = await this.database.query<any>(`SELECT * FROM background_job WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
    return result.rows.map(mapJob);
  }

  public async markRunning(userId: string, id: string): Promise<BackgroundJob | null> {
    return this.update(userId, id, "running", { attemptsIncrement: true });
  }

  public async markCompleted(userId: string, id: string, output?: Record<string, unknown>): Promise<BackgroundJob | null> {
    return this.update(userId, id, "completed", { output, completedAt: new Date().toISOString() });
  }

  public async markFailed(userId: string, id: string, errorMessage: string): Promise<BackgroundJob | null> {
    return this.update(userId, id, "failed", { errorMessage, completedAt: new Date().toISOString() });
  }

  public async cancelJob(userId: string, id: string): Promise<BackgroundJob | null> {
    const job = await this.getJob(userId, id);
    if (!job) return null;
    if (job.status === "completed" || job.status === "failed") throw new ApiError(ErrorCodes.CONFLICT, "Completed or failed jobs cannot be cancelled.", 409);
    return this.update(userId, id, "cancelled", { completedAt: new Date().toISOString() });
  }

  private async update(userId: string, id: string, status: BackgroundJobStatus, patch: { output?: Record<string, unknown>; errorMessage?: string; completedAt?: string; attemptsIncrement?: boolean }): Promise<BackgroundJob | null> {
    const existing = await this.getJob(userId, id);
    if (!existing) return null;
    await this.database.query(
      `UPDATE background_job SET status=$3, output_json=$4, error_message=$5, attempts=attempts+$6, updated_at=$7, completed_at=$8 WHERE user_id=$1 AND id=$2`,
      [userId, id, status, patch.output ? JSON.stringify(patch.output) : null, patch.errorMessage ?? null, patch.attemptsIncrement ? 1 : 0, new Date().toISOString(), patch.completedAt ?? null],
    );
    return this.getJob(userId, id);
  }
}

function mapIdempotency(row: any): IdempotencyEntry {
  return {
    id: row.id,
    userId: row.user_id,
    key: row.key,
    requestMethod: row.request_method,
    requestPath: row.request_path,
    requestHash: row.request_hash,
    responseStatus: row.response_status ?? undefined,
    responseBody: row.response_body_json ?? undefined,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function mapAgentRun(row: any): AgentRun {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    requestId: row.request_id,
    mode: row.mode,
    model: row.model ?? undefined,
    status: row.status,
    decisionMode: row.decision_mode ?? undefined,
    toolCallCount: Number(row.tool_call_count ?? 0),
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    latencyMs: row.latency_ms ?? undefined,
    tokenUsage: row.token_usage_json ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
  };
}

function mapToolRun(row: any): AgentToolRun {
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    userId: row.user_id,
    sessionId: row.session_id ?? undefined,
    toolName: row.tool_name,
    status: row.status,
    latencyMs: row.latency_ms ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    inputSummary: row.input_summary_json ?? undefined,
    outputSummary: row.output_summary_json ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
  };
}

function mapJob(row: any): BackgroundJob {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    status: row.status,
    input: row.input_json ?? undefined,
    output: row.output_json ?? undefined,
    errorMessage: row.error_message ?? undefined,
    attempts: Number(row.attempts ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    runAfter: row.run_after ? new Date(row.run_after).toISOString() : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
  };
}
