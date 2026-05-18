import { ModelClient } from "../../core/model/ModelClient.js";
import { DeepSeekProvider } from "../DeepSeekProvider.js";
import { MockProvider } from "../MockProvider.js";
import { OpenAICompatibleProvider } from "../OpenAICompatibleProvider.js";
import { readRuntimeMode } from "../../agents/runtime/AgentRuntimeConfig.js";
import type {
  AgentModelClientConfig,
  AgentProviderFactoryConfig,
  AgentProviderName,
  AgentProviderRuntimeMode,
} from "./types.js";

const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 0;

export class AgentProviderFactory {
  public static fromEnv(env: NodeJS.ProcessEnv = process.env): AgentProviderFactoryConfig {
    const runtimeMode = readRuntimeMode(env.NODE_ENV);
    const allowMockRuntime = readOptionalBoolean(env.ALLOW_MOCK_RUNTIME) ?? runtimeMode === "test";
    const provider = readProvider(env.AGENT_PROVIDER ?? env.TEST_MODEL_PROVIDER, runtimeMode, allowMockRuntime);

    return {
      provider,
      model: readOptionalString(env.AGENT_MODEL) ?? readOptionalString(env.DEEPSEEK_MODEL),
      baseURL: readOptionalString(env.AGENT_BASE_URL),
      apiKey: readOptionalString(env.AGENT_API_KEY) ?? readOptionalString(env.DEEPSEEK_API_KEY) ?? readOptionalString(env.OPENAI_API_KEY),
      temperature: readOptionalNumber(env.AGENT_TEMPERATURE, "AGENT_TEMPERATURE"),
      maxTokens: readOptionalNumber(env.AGENT_MAX_TOKENS, "AGENT_MAX_TOKENS"),
      timeoutMs: readOptionalNumber(env.AGENT_TIMEOUT_MS, "AGENT_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS,
      maxRetries: readOptionalNumber(env.AGENT_MAX_RETRIES, "AGENT_MAX_RETRIES") ?? DEFAULT_MAX_RETRIES,
      allowMockFallback: readOptionalBoolean(env.ALLOW_MOCK_FALLBACK) ?? false,
      allowMockRuntime,
      runtimeMode,
    };
  }

  public static create(config: AgentProviderFactoryConfig): AgentModelClientConfig {
    if (config.provider === "mock") {
      assertMockAllowed(config);
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
            provider: new DeepSeekProvider({ apiKey: config.apiKey, baseURL: config.baseURL }),
            defaultModel: model,
            timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
          }),
          warnings: [],
        };
      }

      if (config.allowMockFallback) {
        assertMockAllowed(config);
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

    if (config.provider === "openai" || config.provider === "compatible") {
      if (!config.apiKey) {
        throw new Error(`AGENT_API_KEY is required when AGENT_PROVIDER=${config.provider}.`);
      }
      const model = config.model ?? (config.provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_DEEPSEEK_MODEL);
      const baseURL = config.baseURL ?? (config.provider === "openai" ? "https://api.openai.com/v1" : "https://api.deepseek.com");
      return {
        providerName: config.provider,
        model,
        modelClient: new ModelClient({
          provider: new OpenAICompatibleProvider({ name: config.provider, apiKey: config.apiKey, baseURL }),
          defaultModel: model,
          timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
        }),
        warnings: [],
      };
    }

    throw new Error(`Unknown AGENT_PROVIDER "${String(config.provider)}". Supported values are deepseek, openai, compatible, mock.`);
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

function readProvider(
  value: string | undefined,
  runtimeMode: AgentProviderRuntimeMode,
  allowMockRuntime: boolean,
): AgentProviderName {
  const configuredProvider = readOptionalString(value);
  if (!configuredProvider) {
    return runtimeMode === "test" && allowMockRuntime ? "mock" : "deepseek";
  }
  if (configuredProvider === "fake") return "mock";
  if (configuredProvider === "mock" || configuredProvider === "deepseek" || configuredProvider === "openai" || configuredProvider === "compatible") {
    return configuredProvider;
  }
  throw new Error(`Unknown AGENT_PROVIDER "${configuredProvider}". Supported values are deepseek, openai, compatible, mock.`);
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
  throw new Error("Boolean env values must be true, false, 1, or 0.");
}

function assertMockAllowed(config: AgentProviderFactoryConfig): void {
  if (config.runtimeMode === undefined || config.runtimeMode === "test" || config.allowMockRuntime === true) return;
  throw new Error("MockProvider is only allowed when NODE_ENV=test or ALLOW_MOCK_RUNTIME=true.");
}
