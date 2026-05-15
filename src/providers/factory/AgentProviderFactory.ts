import { ModelClient } from "../../core/model/ModelClient.js";
import { DeepSeekProvider } from "../DeepSeekProvider.js";
import { MockProvider } from "../MockProvider.js";
import type {
  AgentModelClientConfig,
  AgentProviderFactoryConfig,
  AgentProviderName,
  AgentProviderRuntimeMode,
} from "./types.js";

const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 0;

export class AgentProviderFactory {
  public static fromEnv(env: NodeJS.ProcessEnv = process.env): AgentProviderFactoryConfig {
    const runtimeMode = readRuntimeMode(env.NODE_ENV);
    const provider = readProvider(env.AGENT_PROVIDER, runtimeMode);

    return {
      provider,
      model: readOptionalString(env.DEEPSEEK_MODEL),
      apiKey: readOptionalString(env.DEEPSEEK_API_KEY),
      timeoutMs: readOptionalNumber(env.AGENT_TIMEOUT_MS, "AGENT_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS,
      maxRetries: readOptionalNumber(env.AGENT_MAX_RETRIES, "AGENT_MAX_RETRIES") ?? DEFAULT_MAX_RETRIES,
      allowMockFallback: readOptionalBoolean(env.ALLOW_MOCK_FALLBACK) ?? runtimeMode !== "production",
      runtimeMode,
    };
  }

  public static create(config: AgentProviderFactoryConfig): AgentModelClientConfig {
    if (config.provider === "mock") {
      return createMockConfig({
        warnings: [],
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
      });
    }

    if (config.provider === "deepseek") {
      const model = config.model ?? DEFAULT_DEEPSEEK_MODEL;
      if (config.apiKey) {
        return {
          providerName: "deepseek",
          model,
          modelClient: new ModelClient({
            provider: new DeepSeekProvider({ apiKey: config.apiKey }),
            defaultModel: model,
            timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
          }),
          warnings: [],
        };
      }

      if (config.allowMockFallback) {
        return createMockConfig({
          warnings: [
            "DEEPSEEK_API_KEY is missing. Falling back to MockProvider because allowMockFallback is enabled.",
          ],
          timeoutMs: config.timeoutMs,
          maxRetries: config.maxRetries,
        });
      }

      throw new Error("DEEPSEEK_API_KEY is required when AGENT_PROVIDER=deepseek.");
    }

    throw new Error(`Unknown AGENT_PROVIDER "${String(config.provider)}". Supported values are mock and deepseek.`);
  }
}

function createMockConfig(input: {
  warnings: string[];
  timeoutMs?: number;
  maxRetries?: number;
}): AgentModelClientConfig {
  return {
    providerName: "mock",
    model: "mock",
    modelClient: new ModelClient({
      provider: new MockProvider(),
      defaultModel: "mock",
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
    }),
    warnings: input.warnings,
  };
}

function readRuntimeMode(nodeEnv: string | undefined): AgentProviderRuntimeMode {
  if (nodeEnv === "production") {
    return "production";
  }
  if (nodeEnv === "test") {
    return "test";
  }
  return "development";
}

function readProvider(
  value: string | undefined,
  runtimeMode: AgentProviderRuntimeMode,
): AgentProviderName {
  const configuredProvider = readOptionalString(value);
  if (!configuredProvider) {
    return runtimeMode === "production" ? "deepseek" : "mock";
  }
  if (configuredProvider === "mock" || configuredProvider === "deepseek") {
    return configuredProvider;
  }
  throw new Error(`Unknown AGENT_PROVIDER "${configuredProvider}". Supported values are mock and deepseek.`);
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalNumber(value: string | undefined, name: string): number | undefined {
  const trimmed = readOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return parsed;
}

function readOptionalBoolean(value: string | undefined): boolean | undefined {
  const trimmed = readOptionalString(value)?.toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "true" || trimmed === "1") {
    return true;
  }
  if (trimmed === "false" || trimmed === "0") {
    return false;
  }
  throw new Error("ALLOW_MOCK_FALLBACK must be true, false, 1, or 0.");
}
