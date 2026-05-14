import "dotenv/config";
import { ModelClient } from "../../core/model/ModelClient.js";
import { DeepSeekProvider } from "../../providers/DeepSeekProvider.js";
import { MockProvider } from "../../providers/MockProvider.js";
import { OpenRouterProvider } from "../../providers/OpenRouterProvider.js";
import type { LLMProvider } from "../../core/model/LLMProvider.js";

export type DemoModelClientConfig = {
  providerName: "mock" | "deepseek" | "openrouter";
  model: string;
};

export function createDemoModelClient(): {
  modelClient: ModelClient;
  config: DemoModelClientConfig;
} {
  const providerName = parseProviderName(process.env.DEFAULT_PROVIDER);
  const model = process.env.DEFAULT_MODEL ?? defaultModelFor(providerName);
  const provider = createProvider(providerName);

  return {
    modelClient: new ModelClient({ provider, defaultModel: model }),
    config: { providerName, model },
  };
}

function parseProviderName(value: string | undefined): DemoModelClientConfig["providerName"] {
  if (value === "deepseek" || value === "openrouter" || value === "mock") {
    return value;
  }
  return "mock";
}

function defaultModelFor(providerName: DemoModelClientConfig["providerName"]): string {
  if (providerName === "deepseek") {
    return "deepseek-v4-pro";
  }
  if (providerName === "openrouter") {
    return "openai/gpt-4o-mini";
  }
  return "mock-model";
}

function createProvider(providerName: DemoModelClientConfig["providerName"]): LLMProvider {
  if (providerName === "deepseek") {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error("DEFAULT_PROVIDER=deepseek requires DEEPSEEK_API_KEY.");
    }
    return new DeepSeekProvider({ apiKey });
  }

  if (providerName === "openrouter") {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("DEFAULT_PROVIDER=openrouter requires OPENROUTER_API_KEY.");
    }
    return new OpenRouterProvider({ apiKey });
  }

  return new MockProvider();
}
