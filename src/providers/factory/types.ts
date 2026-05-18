import type { ModelClient } from "../../core/model/ModelClient.js";

export type AgentProviderName = "mock" | "deepseek" | "openai" | "compatible";

export type AgentProviderRuntimeMode = "test" | "development" | "production";

export type AgentProviderFactoryConfig = {
  provider: AgentProviderName;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  allowMockFallback?: boolean;
  allowMockRuntime?: boolean;
  runtimeMode?: AgentProviderRuntimeMode;
};

export type AgentModelClientConfig = {
  providerName: AgentProviderName;
  model: string;
  modelClient: ModelClient;
  warnings: string[];
};
