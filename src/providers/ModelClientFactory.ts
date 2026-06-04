import { ModelClient } from "../agent-core/model/ModelClient.js";
import type { ModelRuntimeConfig } from "../api/types.js";
import type { ResolvedUserModelConfig } from "../auth/types.js";
import { DeepSeekProvider } from "./DeepSeekProvider.js";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";

export type ModelClientFactoryEnv = {
  AGENT_MODEL_PROVIDER?: string;
  AGENT_PROVIDER?: string;
  AGENT_MODEL?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AGENT_MODEL_API_KEY?: string;
  AGENT_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  OPENAI_BASE_URL?: string;
  AGENT_MODEL_BASE_URL?: string;
  AGENT_BASE_URL?: string;
  OPENAI_MODEL?: string;
};

export type ModelClientCreationResult = {
  client?: ModelClient;
  warnings: string[];
  config: ModelRuntimeConfig;
};

export class ModelClientFactory {
  private readonly env: ModelClientFactoryEnv;

  public constructor(env: ModelClientFactoryEnv = process.env as ModelClientFactoryEnv) {
    this.env = env;
  }

  /**
   * Create a default ModelClient from environment variables.
   * Behavior is identical to the former createKernel::createModelClient.
   */
  public createDefaultModelClient(): ModelClientCreationResult {
    const provider = this.env.AGENT_MODEL_PROVIDER ?? this.env.AGENT_PROVIDER ?? "deepseek";
    const model = this.env.AGENT_MODEL ?? this.env.DEEPSEEK_MODEL ?? "deepseek-chat";

    if (provider === "openai" || provider === "compatible") {
      return this.createOpenAICompatible(provider, model);
    }

    return this.createDeepSeek(provider, model);
  }

  /**
   * Create a ModelClient from user-provided configuration.
   * Falls back to defaults when user config is incomplete.
   */
  public createModelClientForUser(userConfig: ResolvedUserModelConfig): ModelClientCreationResult {
    const provider = userConfig.provider;
    if (!provider || !userConfig.apiKey) {
      // No user config — fall back to default
      const result = this.createDefaultModelClient();
      result.warnings.push("User model config is incomplete; using system default.");
      return result;
    }

    const model = userConfig.model ?? this.env.AGENT_MODEL ?? this.env.DEEPSEEK_MODEL ?? "deepseek-chat";
    const baseURL = userConfig.baseUrl;

    if (provider === "openai" || provider === "compatible") {
      const llmProvider = new OpenAICompatibleProvider({
        name: provider,
        apiKey: userConfig.apiKey,
        baseURL: baseURL ?? this.env.OPENAI_BASE_URL ?? this.env.AGENT_MODEL_BASE_URL ?? this.env.AGENT_BASE_URL ?? "https://api.openai.com/v1",
      });
      return {
        client: new ModelClient({ provider: llmProvider, defaultModel: model }),
        config: { provider, model, baseURL, apiKeyConfigured: true, apiKeyMasked: maskApiKey(userConfig.apiKey) },
        warnings: [],
      };
    }

    if (provider === "deepseek") {
      const llmProvider = new DeepSeekProvider({
        apiKey: userConfig.apiKey,
        baseURL: baseURL ?? this.env.DEEPSEEK_BASE_URL ?? this.env.AGENT_MODEL_BASE_URL ?? this.env.AGENT_BASE_URL ?? "https://api.deepseek.com",
      });
      return {
        client: new ModelClient({ provider: llmProvider, defaultModel: model }),
        config: { provider, model, baseURL, apiKeyConfigured: true, apiKeyMasked: maskApiKey(userConfig.apiKey) },
        warnings: [],
      };
    }

    // Unknown provider from user config — reject
    return {
      config: { provider, model, baseURL, apiKeyConfigured: false },
      warnings: [`Unknown provider "${provider}" from user model config. Supported: deepseek, openai, compatible.`],
    };
  }

  // ── Internal helpers ─────────────────────────────────────────────

  private createOpenAICompatible(provider: string, model: string): ModelClientCreationResult {
    const apiKey = this.env.OPENAI_API_KEY ?? this.env.AGENT_MODEL_API_KEY ?? this.env.AGENT_API_KEY;
    const baseURL =
      this.env.OPENAI_BASE_URL ??
      this.env.AGENT_MODEL_BASE_URL ??
      this.env.AGENT_BASE_URL ??
      "https://api.openai.com/v1";
    if (!apiKey) {
      return {
        config: { provider, model: this.env.OPENAI_MODEL ?? model, baseURL, apiKeyConfigured: false },
        warnings: ["OPENAI_API_KEY, AGENT_MODEL_API_KEY, or AGENT_API_KEY is not set. Agent model calls are disabled."],
      };
    }
    return {
      client: new ModelClient({
        provider: new OpenAICompatibleProvider({ name: provider as "openai" | "compatible", apiKey, baseURL }),
        defaultModel: this.env.OPENAI_MODEL ?? model,
      }),
      config: { provider, model: this.env.OPENAI_MODEL ?? model, baseURL, apiKeyConfigured: true, apiKeyMasked: maskApiKey(apiKey) },
      warnings: [],
    };
  }

  private createDeepSeek(provider: string, model: string): ModelClientCreationResult {
    const apiKey = this.env.DEEPSEEK_API_KEY ?? this.env.AGENT_MODEL_API_KEY ?? this.env.AGENT_API_KEY;
    const baseURL = this.env.DEEPSEEK_BASE_URL ?? this.env.AGENT_MODEL_BASE_URL ?? this.env.AGENT_BASE_URL ?? "https://api.deepseek.com";
    if (!apiKey) {
      return {
        config: { provider: "deepseek", model, baseURL, apiKeyConfigured: false },
        warnings: ["DEEPSEEK_API_KEY, AGENT_MODEL_API_KEY, or AGENT_API_KEY is not set. Agent model calls are disabled."],
      };
    }
    return {
      client: new ModelClient({
        provider: new DeepSeekProvider({ apiKey, baseURL }),
        defaultModel: model,
      }),
      config: { provider: "deepseek", model, baseURL, apiKeyConfigured: true, apiKeyMasked: maskApiKey(apiKey) },
      warnings: [],
    };
  }
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

export function describeModelConfig(config: ModelRuntimeConfig): string {
  const parts: string[] = [];
  parts.push(`provider=${config.provider}`);
  parts.push(`model=${config.model}`);
  parts.push(`baseURL=${config.baseURL ?? "default"}`);
  parts.push(`apiKey=${config.apiKeyConfigured ? config.apiKeyMasked ?? "configured" : "missing"}`);
  return parts.join(", ");
}

export function debugModelConfig(config: ModelRuntimeConfig): void {
  if (process.env.NODE_ENV !== "development" && process.env.DEBUG_LLM_CONFIG !== "true") return;
  if (process.env.DEBUG_LLM_CONFIG === "false") return;
  console.debug("[model] config", {
    provider: config.provider,
    model: config.model,
    baseURL: config.baseURL,
    apiKeyConfigured: config.apiKeyConfigured,
    apiKeyMasked: config.apiKeyMasked,
  });
}
