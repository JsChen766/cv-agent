export type AgentProviderName = "deepseek" | "openai" | "compatible";
export type AgentProviderRuntimeMode = "production" | "development" | "test";

export type AgentRuntimeConfig = {
  provider: AgentProviderName;
  model: string;
  baseURL?: string;
  temperature: number;
  maxTokens: number;
  hasApiKey: boolean;
  runtimeMode: AgentProviderRuntimeMode;
  warnings: string[];
};

const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 2000;

export function readAgentRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AgentRuntimeConfig {
  const runtimeMode = readRuntimeMode(env.NODE_ENV);
  const provider = readProvider(env.AGENT_MODEL_PROVIDER);
  const model = readString(env.AGENT_MODEL) ?? readString(env.DEEPSEEK_MODEL) ?? DEFAULT_MODEL;
  const apiKey = readString(env.AGENT_MODEL_API_KEY) ?? readString(env.DEEPSEEK_API_KEY) ?? readString(env.OPENAI_API_KEY);
  const warnings: string[] = [];
  if (!apiKey) warnings.push("Agent model API key is missing. Agent model calls are disabled.");
  return {
    provider,
    model,
    baseURL: readString(env.AGENT_MODEL_BASE_URL) ?? readString(env.DEEPSEEK_BASE_URL) ?? readString(env.OPENAI_BASE_URL),
    temperature: readNumber(env.AGENT_TEMPERATURE, "AGENT_TEMPERATURE") ?? DEFAULT_TEMPERATURE,
    maxTokens: readNumber(env.AGENT_MAX_TOKENS, "AGENT_MAX_TOKENS") ?? DEFAULT_MAX_TOKENS,
    hasApiKey: Boolean(apiKey),
    runtimeMode,
    warnings,
  };
}

export function readRuntimeMode(nodeEnv: string | undefined): AgentProviderRuntimeMode {
  if (nodeEnv === "production") return "production";
  if (nodeEnv === "test") return "test";
  return "development";
}

function readProvider(configured: string | undefined): AgentProviderName {
  const value = readString(configured);
  if (!value) return "deepseek";
  if (value === "deepseek" || value === "openai" || value === "compatible") return value;
  throw new Error(`Unknown AGENT_MODEL_PROVIDER "${value}". Supported values are deepseek, openai, compatible.`);
}

function readString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readNumber(value: string | undefined, name: string): number | undefined {
  const text = readString(value);
  if (!text) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number.`);
  return parsed;
}
