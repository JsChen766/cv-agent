import { createHash, randomUUID } from "node:crypto";
import { ApiError, ErrorCodes } from "../api/errors.js";
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

export class InMemoryPlatformServices implements PlatformServices {
  public readonly idempotency = new InMemoryIdempotencyService();
  public readonly sessionLocks = new InMemorySessionLockService();
  public readonly usage = new InMemoryUsageService();
  public readonly agentRuns = new InMemoryAgentRunService();
  public readonly backgroundJobs = new InMemoryBackgroundJobService();
}

class InMemoryIdempotencyService {
  private readonly entries = new Map<string, IdempotencyEntry>();

  public async begin(input: {
    userId: string;
    key: string;
    requestMethod: string;
    requestPath: string;
    requestHash: string;
    ttlMs?: number;
  }): Promise<IdempotencyBeginResult> {
    const mapKey = `${input.userId}:${input.key}`;
    const existing = this.entries.get(mapKey);
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
    this.entries.set(mapKey, entry);
    return { type: "started", entry };
  }

  public async complete(userId: string, key: string, responseStatus: number, responseBody: unknown): Promise<void> {
    const entry = this.entries.get(`${userId}:${key}`);
    if (!entry) return;
    this.entries.set(`${userId}:${key}`, {
      ...entry,
      status: "completed",
      responseStatus,
      responseBody,
      updatedAt: new Date().toISOString(),
    });
  }

  public async fail(userId: string, key: string): Promise<void> {
    const entry = this.entries.get(`${userId}:${key}`);
    if (!entry) return;
    this.entries.set(`${userId}:${key}`, { ...entry, status: "failed", updatedAt: new Date().toISOString() });
  }
}

class InMemorySessionLockService {
  private readonly locks = new Map<string, { userId: string; ownerRequestId: string; lockedUntil: string; createdAt: string; updatedAt: string }>();

  public async acquire(input: { userId: string; sessionId: string; ownerRequestId: string; ttlMs?: number }): Promise<boolean> {
    const now = new Date();
    const existing = this.locks.get(input.sessionId);
    if (existing && existing.userId === input.userId && new Date(existing.lockedUntil).getTime() > now.getTime()) {
      return existing.ownerRequestId === input.ownerRequestId;
    }
    const lockedUntil = new Date(now.getTime() + (input.ttlMs ?? readPlatformConfig().sessionLockTtlMs)).toISOString();
    this.locks.set(input.sessionId, {
      userId: input.userId,
      ownerRequestId: input.ownerRequestId,
      lockedUntil,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    });
    return true;
  }

  public async release(input: { userId: string; sessionId: string; ownerRequestId: string }): Promise<void> {
    const existing = this.locks.get(input.sessionId);
    if (existing?.userId === input.userId && existing.ownerRequestId === input.ownerRequestId) {
      this.locks.delete(input.sessionId);
    }
  }
}

class InMemoryUsageService {
  private readonly counters = new Map<string, { count: number; resetAt: number }>();

  public async checkRequest(input: { userId?: string; ip?: string }): Promise<void> {
    const config = readPlatformConfig();
    if (!config.rateLimitEnabled) return;
    if (input.userId) await this.increment(`user:${input.userId}:request:minute`, config.perUserPerMinute, 60_000);
    if (input.ip) await this.increment(`ip:${input.ip}:request:minute`, config.perIpPerMinute, 60_000);
  }

  public async consume(input: { userId: string; metric: UsageMetric; amount?: number }): Promise<void> {
    const config = readPlatformConfig();
    if (input.metric === "message") {
      await this.increment(`user:${input.userId}:message:day`, config.dailyMessageQuota, 24 * 60 * 60 * 1000, input.amount);
    }
    if (input.metric === "tool_call") {
      await this.increment(`user:${input.userId}:tool_call:day`, config.dailyToolCallQuota, 24 * 60 * 60 * 1000, input.amount);
    }
    if (input.metric === "generation") {
      await this.increment(`user:${input.userId}:generation:day`, config.dailyGenerationQuota, 24 * 60 * 60 * 1000, input.amount);
    }
  }

  private async increment(key: string, limit: number, windowMs: number, amount = 1): Promise<void> {
    const now = Date.now();
    const current = this.counters.get(key);
    const next = !current || current.resetAt <= now
      ? { count: amount, resetAt: now + windowMs }
      : { count: current.count + amount, resetAt: current.resetAt };
    if (next.count > limit) {
      throw new ApiError(key.includes(":request:") ? ErrorCodes.RATE_LIMITED : ErrorCodes.QUOTA_EXCEEDED, "Usage limit exceeded.", key.includes(":request:") ? 429 : 429, { retryable: true });
    }
    this.counters.set(key, next);
  }
}

class InMemoryAgentRunService {
  private readonly runs = new Map<string, AgentRun>();
  private readonly tools = new Map<string, AgentToolRun>();

  public async createRun(input: Omit<AgentRun, "status" | "toolCallCount" | "createdAt">): Promise<AgentRun> {
    const run: AgentRun = { ...input, status: "running", toolCallCount: 0, createdAt: new Date().toISOString() };
    this.runs.set(run.id, run);
    return run;
  }

  public async completeRun(id: string, patch: Partial<AgentRun>): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.set(id, { ...run, ...patch, status: "completed", completedAt: new Date().toISOString() });
  }

  public async failRun(id: string, patch: Partial<AgentRun>): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.set(id, { ...run, ...patch, status: "failed", completedAt: new Date().toISOString() });
  }

  public async createToolRun(input: Omit<AgentToolRun, "status" | "createdAt">): Promise<AgentToolRun> {
    const toolRun: AgentToolRun = { ...input, status: "running", createdAt: new Date().toISOString() };
    this.tools.set(toolRun.id, toolRun);
    const run = this.runs.get(toolRun.agentRunId);
    if (run) this.runs.set(run.id, { ...run, toolCallCount: run.toolCallCount + 1 });
    return toolRun;
  }

  public async completeToolRun(id: string, patch: Partial<AgentToolRun>): Promise<void> {
    const tool = this.tools.get(id);
    if (!tool) return;
    this.tools.set(id, { ...tool, ...patch, completedAt: new Date().toISOString() });
  }

  public async listRuns(userId: string, limit = 50): Promise<AgentRun[]> {
    return Array.from(this.runs.values())
      .filter((run) => run.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  public async getRun(userId: string, id: string): Promise<{ run: AgentRun; tools: AgentToolRun[] } | null> {
    const run = this.runs.get(id);
    if (!run || run.userId !== userId) return null;
    return {
      run,
      tools: Array.from(this.tools.values()).filter((tool) => tool.agentRunId === id && tool.userId === userId),
    };
  }
}

class InMemoryBackgroundJobService {
  private readonly jobs = new Map<string, BackgroundJob>();

  public async createJob(input: Omit<BackgroundJob, "id" | "status" | "attempts" | "createdAt" | "updatedAt">): Promise<BackgroundJob> {
    const now = new Date().toISOString();
    const job: BackgroundJob = { ...input, id: `job-${randomUUID()}`, status: "pending", attempts: 0, createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    return job;
  }

  public async getJob(userId: string, id: string): Promise<BackgroundJob | null> {
    const job = this.jobs.get(id);
    return job?.userId === userId ? job : null;
  }

  public async listJobs(userId: string, limit = 50): Promise<BackgroundJob[]> {
    return Array.from(this.jobs.values())
      .filter((job) => job.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  public async markRunning(userId: string, id: string): Promise<BackgroundJob | null> {
    return this.update(userId, id, "running", (job) => ({ attempts: job.attempts + 1 }));
  }

  public async markCompleted(userId: string, id: string, output?: Record<string, unknown>): Promise<BackgroundJob | null> {
    return this.update(userId, id, "completed", () => ({ output, completedAt: new Date().toISOString() }));
  }

  public async markFailed(userId: string, id: string, errorMessage: string): Promise<BackgroundJob | null> {
    return this.update(userId, id, "failed", () => ({ errorMessage, completedAt: new Date().toISOString() }));
  }

  public async cancelJob(userId: string, id: string): Promise<BackgroundJob | null> {
    const job = await this.getJob(userId, id);
    if (!job) return null;
    if (job.status === "completed" || job.status === "failed") {
      throw new ApiError(ErrorCodes.CONFLICT, "Completed or failed jobs cannot be cancelled.", 409);
    }
    return this.update(userId, id, "cancelled", () => ({ completedAt: new Date().toISOString() }));
  }

  private async update(
    userId: string,
    id: string,
    status: BackgroundJobStatus,
    patch: (job: BackgroundJob) => Partial<BackgroundJob>,
  ): Promise<BackgroundJob | null> {
    const job = await this.getJob(userId, id);
    if (!job) return null;
    const next = { ...job, ...patch(job), status, updatedAt: new Date().toISOString() };
    this.jobs.set(id, next);
    return next;
  }
}

export function hashBody(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}
