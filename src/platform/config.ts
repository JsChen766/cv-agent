export type PlatformConfig = {
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
};

export function readPlatformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  return {
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

function readBoolean(value: string | undefined): boolean | undefined {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  throw new Error("Boolean env values must be true, false, 1, or 0.");
}
