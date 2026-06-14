export type AuthMode = "dev_header" | "disabled" | "bearer_static" | "cookie_session" | "bearer_token" | "service";

export type FileStorageProvider = "local" | "memory" | "r2" | "s3";

export type PdfRenderer = "none" | "playwright" | "external";

export type PlatformConfig = {
  // rate / quota
  rateLimitEnabled: boolean;
  perUserPerMinute: number;
  perIpPerMinute: number;
  dailyMessageQuota: number;
  dailyToolCallQuota: number;
  dailyGenerationQuota: number;
  maxPromptChars: number;
  maxToolCallsPerRun: number;
  sessionLockTtlMs: number;
  finalAnswerSynthesis: "off" | "llm";
  debugRoutesEnabled: boolean;
  jobLockTtlMs: number;

  // auth
  authMode: AuthMode;
  sessionCookieName: string;
  sessionTtlDays: number;
  allowDevHeaderAuth: boolean;
  allowInsecureAuth: boolean;
  authStaticBearerToken?: string;
  authStaticUserId?: string;

  // api boundary
  internalKernelRoutesEnabled: boolean;

  // job worker
  jobWorkerEnabled: boolean;
  jobWorkerConcurrency: number;
  jobPollIntervalMs: number;

  // file upload / storage
  fileUploadEnabled: boolean;
  fileStorageProvider: FileStorageProvider;
  fileStorageDir: string;
  fileMaxSizeMb: number;
  fileMaxParsedTextChars: number;
  fileAllowedMimeTypes: string;

  // export
  pdfRenderer: PdfRenderer;
  exportStorageDir: string;
  exportDownloadTtlMinutes: number;

  // user api key encryption
  userApiKeyEncryptionSecret?: string;
};

export function readPlatformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  return {
    // rate / quota
    rateLimitEnabled: readBoolean(env.RATE_LIMIT_ENABLED) ?? false,
    perUserPerMinute: readNumber(env.RATE_LIMIT_PER_USER_PER_MINUTE) ?? 30,
    perIpPerMinute: readNumber(env.RATE_LIMIT_PER_IP_PER_MINUTE) ?? 60,
    dailyMessageQuota: readNumber(env.AGENT_DAILY_MESSAGE_QUOTA) ?? 200,
    dailyToolCallQuota: readNumber(env.AGENT_DAILY_TOOL_CALL_QUOTA) ?? 500,
    dailyGenerationQuota: readNumber(env.AGENT_DAILY_GENERATION_QUOTA) ?? 50,
    maxPromptChars: readNumber(env.LLM_MAX_PROMPT_CHARS) ?? 50000,
    maxToolCallsPerRun: readNumber(env.LLM_MAX_TOOL_CALLS_PER_RUN) ?? 5,
    sessionLockTtlMs: readNumber(env.COPILOT_SESSION_LOCK_TTL_MS) ?? 60000,
    finalAnswerSynthesis: env.FINAL_ANSWER_SYNTHESIS === "llm" ? "llm" : "off",
    debugRoutesEnabled: readBoolean(env.DEBUG_ROUTES_ENABLED) ?? false,
    jobLockTtlMs: readNumber(env.JOB_LOCK_TTL_MS) ?? 60000,

    // auth
    authMode: readAuthMode(env, nodeEnv),
    sessionCookieName: env.SESSION_COOKIE_NAME?.trim() || "coolto_session",
    sessionTtlDays: readPositiveNumber(env.SESSION_TTL_DAYS) ?? 30,
    allowDevHeaderAuth: readBoolean(env.ALLOW_DEV_HEADER_AUTH) ?? false,
    allowInsecureAuth: readBoolean(env.ALLOW_INSECURE_AUTH) ?? false,
    authStaticBearerToken: env.AUTH_STATIC_BEARER_TOKEN?.trim() || undefined,
    authStaticUserId: env.AUTH_STATIC_USER_ID?.trim() || undefined,

    // api boundary
    internalKernelRoutesEnabled: readInternalKernelRoutesEnabled(env, nodeEnv),

    // job worker
    jobWorkerEnabled: readBoolean(env.JOB_WORKER_ENABLED) ?? nodeEnv !== "test",
    jobWorkerConcurrency: readPositiveNumber(env.JOB_WORKER_CONCURRENCY) ?? 1,
    jobPollIntervalMs: readPositiveNumber(env.JOB_POLL_INTERVAL_MS) ?? 2000,

    // file upload / storage
    fileUploadEnabled: readBoolean(env.FILE_UPLOAD_ENABLED) ?? true,
    fileStorageProvider: readFileStorageProvider(env),
    fileStorageDir: env.FILE_STORAGE_DIR?.trim() || ".data/uploads",
    fileMaxSizeMb: readPositiveNumber(env.FILE_MAX_SIZE_MB) ?? 10,
    fileMaxParsedTextChars: readPositiveNumber(env.FILE_MAX_PARSED_TEXT_CHARS) ?? 500_000,
    fileAllowedMimeTypes: env.FILE_ALLOWED_MIME_TYPES?.trim() || "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain",

    // export
    pdfRenderer: readPdfRenderer(env, nodeEnv),
    exportStorageDir: env.EXPORT_STORAGE_DIR?.trim() || ".data/exports",
    exportDownloadTtlMinutes: readPositiveNumber(env.EXPORT_DOWNLOAD_TTL_MINUTES) ?? 60,

    // user api key encryption
    userApiKeyEncryptionSecret: env.USER_API_KEY_ENCRYPTION_SECRET?.trim() || undefined,
  };
}

function readNumber(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Numeric env values must be non-negative numbers.");
  }
  return parsed;
}

function readPositiveNumber(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Numeric env values must be positive numbers.");
  }
  return parsed;
}

function readBoolean(value: string | undefined): boolean | undefined {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  throw new Error("Boolean env values must be true, false, 1, or 0.");
}

function readAuthMode(env: NodeJS.ProcessEnv, nodeEnv: string): AuthMode {
  const configured = env.AUTH_MODE?.trim();
  if (!configured) {
    if (nodeEnv === "production") {
      throw new Error("AUTH_MODE must be set in production. Supported values are dev_header, bearer_static, and cookie_session.");
    }
    return "dev_header";
  }
  const valid: AuthMode[] = ["dev_header", "disabled", "bearer_static", "cookie_session", "bearer_token", "service"];
  if ((valid as string[]).includes(configured)) return configured as AuthMode;
  throw new Error(`Unknown AUTH_MODE "${configured}". Supported values are dev_header, disabled, bearer_static, and cookie_session.`);
}

function readInternalKernelRoutesEnabled(env: NodeJS.ProcessEnv, nodeEnv: string): boolean {
  const configured = env.INTERNAL_KERNEL_ROUTES_ENABLED?.trim();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return nodeEnv === "test";
}

function readFileStorageProvider(env: NodeJS.ProcessEnv): FileStorageProvider {
  const configured = env.FILE_STORAGE_PROVIDER?.trim() || "local";
  const valid: FileStorageProvider[] = ["local", "memory", "r2", "s3"];
  if ((valid as string[]).includes(configured)) return configured as FileStorageProvider;
  return "local";
}

function readPdfRenderer(env: NodeJS.ProcessEnv, nodeEnv: string): PdfRenderer {
  const configured = env.PDF_RENDERER?.trim();
  if (configured) {
    const valid: PdfRenderer[] = ["none", "playwright", "external"];
    if ((valid as string[]).includes(configured)) return configured as PdfRenderer;
    return "none";
  }
  // No explicit value: default to playwright outside production so local
  // development can export PDFs without setting an env var, while production
  // deploys still need to opt in explicitly to avoid accidentally launching
  // chromium on bare images. Tests also default to "none" so the test bench
  // stays deterministic — tests inject their own renderer when needed.
  if (nodeEnv === "production" || nodeEnv === "test") return "none";
  return "playwright";
}
