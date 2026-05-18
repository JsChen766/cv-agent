export type IdempotencyStatus = "pending" | "completed" | "failed";

export type IdempotencyEntry = {
  id: string;
  userId: string;
  key: string;
  requestMethod: string;
  requestPath: string;
  requestHash: string;
  responseStatus?: number;
  responseBody?: unknown;
  status: IdempotencyStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type IdempotencyBeginResult =
  | { type: "started"; entry: IdempotencyEntry }
  | { type: "replay"; entry: IdempotencyEntry }
  | { type: "conflict"; entry: IdempotencyEntry; reason: "hash_mismatch" | "pending" };

export type UsageMetric = "request" | "message" | "tool_call" | "generation";

export type UsageBucket = "per_minute" | "daily";

export type UsageCheckInput = {
  userId?: string;
  ip?: string;
};

export type SessionLock = {
  sessionId: string;
  userId: string;
  ownerRequestId: string;
  lockedUntil: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentRunStatus = "running" | "completed" | "failed";

export type AgentRun = {
  id: string;
  userId: string;
  sessionId?: string;
  turnId?: string;
  requestId: string;
  mode: string;
  model?: string;
  status: AgentRunStatus;
  decisionMode?: string;
  toolCallCount: number;
  errorCode?: string;
  errorMessage?: string;
  latencyMs?: number;
  tokenUsage?: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
};

export type AgentToolRunStatus = "running" | "completed" | "failed" | "needs_input";

export type AgentToolRun = {
  id: string;
  agentRunId: string;
  userId: string;
  sessionId?: string;
  toolName: string;
  status: AgentToolRunStatus;
  latencyMs?: number;
  errorCode?: string;
  errorMessage?: string;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
};

export type BackgroundJobType =
  | "import_pdf"
  | "export_pdf"
  | "rebuild_index"
  | "long_generation"
  | "parse_document"
  | "import_resume_file"
  | "export_resume_html"
  | "export_resume_pdf";

export type BackgroundJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type BackgroundJob = {
  id: string;
  userId: string;
  type: BackgroundJobType;
  status: BackgroundJobStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorMessage?: string;
  attempts: number;
  progress: number;
  progressMessage?: string;
  idempotencyKey?: string;
  priority: number;
  lockedBy?: string;
  lockedUntil?: string;
  maxAttempts: number;
  nextRetryAt?: string;
  resultRef?: string;
  createdAt: string;
  updatedAt: string;
  runAfter?: string;
  completedAt?: string;
};

export type BackgroundJobCreateInput = Omit<
  BackgroundJob,
  "id" | "status" | "attempts" | "progress" | "priority" | "maxAttempts" | "createdAt" | "updatedAt"
> & {
  progress?: number;
  priority?: number;
  maxAttempts?: number;
};

export type PlatformServices = {
  idempotency: {
    begin(input: {
      userId: string;
      key: string;
      requestMethod: string;
      requestPath: string;
      requestHash: string;
      ttlMs?: number;
    }): Promise<IdempotencyBeginResult>;
    complete(userId: string, key: string, responseStatus: number, responseBody: unknown): Promise<void>;
    fail(userId: string, key: string): Promise<void>;
  };
  sessionLocks: {
    acquire(input: { userId: string; sessionId: string; ownerRequestId: string; ttlMs?: number }): Promise<boolean>;
    release(input: { userId: string; sessionId: string; ownerRequestId: string }): Promise<void>;
  };
  usage: {
    checkRequest(input: UsageCheckInput): Promise<void>;
    consume(input: { userId: string; metric: UsageMetric; amount?: number }): Promise<void>;
  };
  agentRuns: {
    createRun(input: Omit<AgentRun, "status" | "toolCallCount" | "createdAt">): Promise<AgentRun>;
    completeRun(id: string, patch: Partial<AgentRun>): Promise<void>;
    failRun(id: string, patch: Partial<AgentRun>): Promise<void>;
    createToolRun(input: Omit<AgentToolRun, "status" | "createdAt">): Promise<AgentToolRun>;
    completeToolRun(id: string, patch: Partial<AgentToolRun>): Promise<void>;
    listRuns(userId: string, limit?: number): Promise<AgentRun[]>;
    getRun(userId: string, id: string): Promise<{ run: AgentRun; tools: AgentToolRun[] } | null>;
  };
  backgroundJobs: {
    createJob(input: BackgroundJobCreateInput): Promise<BackgroundJob>;
    enqueue(input: BackgroundJobCreateInput): Promise<BackgroundJob>;
    getJob(userId: string, id: string): Promise<BackgroundJob | null>;
    listJobs(userId: string, limit?: number): Promise<BackgroundJob[]>;
    claimNextJob(workerId: string, types?: BackgroundJobType[]): Promise<BackgroundJob | null>;
    markRunning(userId: string, id: string): Promise<BackgroundJob | null>;
    markProgress(userId: string, id: string, progress: number, message?: string): Promise<BackgroundJob | null>;
    markCompleted(userId: string, id: string, output?: Record<string, unknown>): Promise<BackgroundJob | null>;
    markFailed(userId: string, id: string, errorMessage: string): Promise<BackgroundJob | null>;
    scheduleRetry(userId: string, id: string, errorMessage: string, nextRetryAt: string): Promise<BackgroundJob | null>;
    cancelJob(userId: string, id: string): Promise<BackgroundJob | null>;
    markCancelled(userId: string, id: string): Promise<BackgroundJob | null>;
    heartbeat(userId: string, id: string, workerId: string): Promise<BackgroundJob | null>;
  };
};
