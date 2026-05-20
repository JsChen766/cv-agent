import type { AgentProviderName, AgentProviderRuntimeMode } from "../../providers/factory/types.js";

export type FrontDeskAgentMode = "llm" | "fake" | "mock";

export type AgentRuntimeConfig = {
  provider: AgentProviderName;
  model: string;
  baseURL?: string;
  temperature: number;
  maxTokens: number;
  frontDeskAgentMode: FrontDeskAgentMode;
  toolCallingMode: "json_decision";
  allowMockRuntime: boolean;
  allowDeterministicRouter: boolean;
  hasApiKey: boolean;
  runtimeMode: AgentProviderRuntimeMode;
  warnings: string[];
};

const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 2000;

export function readAgentRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AgentRuntimeConfig {
  const runtimeMode = readRuntimeMode(env.NODE_ENV);
  const allowMockRuntime = readBoolean(env.ALLOW_MOCK_RUNTIME) ?? runtimeMode === "test";
  const allowDeterministicRouter = readBoolean(env.ALLOW_DETERMINISTIC_ROUTER) ?? false;
  const provider = readProvider(env.AGENT_PROVIDER, env.TEST_MODEL_PROVIDER, runtimeMode, allowMockRuntime);
  const model = readString(env.FRONTDESK_AGENT_MODEL) ??
    readString(env.AGENT_MODEL) ??
    readString(env.DEEPSEEK_MODEL) ??
    (provider === "mock" ? "mock" : DEFAULT_MODEL);
  const apiKey = readString(env.AGENT_API_KEY) ??
    readString(env.DEEPSEEK_API_KEY) ??
    readString(env.OPENAI_API_KEY);
  const mode = readFrontDeskMode(env.FRONTDESK_AGENT_MODE ?? env.TEST_AGENT_MODE, runtimeMode);
  const warnings: string[] = [];

  if ((provider === "mock" || mode === "mock" || mode === "fake") && !allowMockRuntime) {
    throw new Error("Mock/fake Agent runtime is only allowed when NODE_ENV=test or ALLOW_MOCK_RUNTIME=true.");
  }
  if (mode === "llm" && provider !== "mock" && !apiKey) {
    throw new Error("AGENT_API_KEY is required when FRONTDESK_AGENT_MODE=llm.");
  }
  if (provider !== "mock" && !apiKey) {
    warnings.push("AGENT_API_KEY/DEEPSEEK_API_KEY is missing for the configured Agent provider.");
  }
  if (allowDeterministicRouter) {
    warnings.push("Deterministic router fallback is explicitly enabled. Do not use this as the default product brain.");
  }
  if (provider === "mock") {
    warnings.push("Agent provider is mock/fake. This is intended for tests or explicit local fallback only.");
  }

  return {
    provider,
    model,
    baseURL: readString(env.AGENT_BASE_URL),
    temperature: readNumber(env.AGENT_TEMPERATURE, "AGENT_TEMPERATURE") ?? DEFAULT_TEMPERATURE,
    maxTokens: readNumber(env.AGENT_MAX_TOKENS, "AGENT_MAX_TOKENS") ?? DEFAULT_MAX_TOKENS,
    frontDeskAgentMode: mode,
    toolCallingMode: "json_decision",
    allowMockRuntime,
    allowDeterministicRouter,
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

function readProvider(
  configured: string | undefined,
  testProvider: string | undefined,
  runtimeMode: AgentProviderRuntimeMode,
  allowMockRuntime: boolean,
): AgentProviderName {
  const value = readString(runtimeMode === "test" ? configured ?? testProvider : configured);
  if (!value) return runtimeMode === "test" && allowMockRuntime ? "mock" : "deepseek";
  if (value === "fake") return "mock";
  if (value === "mock" || value === "deepseek" || value === "openai" || value === "compatible") return value;
  throw new Error(`Unknown AGENT_PROVIDER "${value}". Supported values are deepseek, openai, compatible, mock.`);
}

function readFrontDeskMode(value: string | undefined, runtimeMode: AgentProviderRuntimeMode): FrontDeskAgentMode {
  const mode = readString(value);
  if (!mode) return runtimeMode === "test" ? "fake" : "llm";
  if (mode === "fake" || mode === "mock" || mode === "llm") return mode;
  throw new Error("FRONTDESK_AGENT_MODE must be one of: llm, fake, mock.");
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

function readBoolean(value: string | undefined): boolean | undefined {
  const text = readString(value)?.toLowerCase();
  if (!text) return undefined;
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  throw new Error("Boolean env values must be true, false, 1, or 0.");
}
