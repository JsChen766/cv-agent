import type { ModelClient } from "../../core/model/ModelClient.js";

export type AgentProviderName = "mock" | "deepseek";

export type AgentProviderRuntimeMode = "test" | "development" | "production";

export type AgentProviderFactoryConfig = {
  provider: AgentProviderName;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  allowMockFallback?: boolean;
  runtimeMode?: AgentProviderRuntimeMode;
};

export type AgentModelClientConfig = {
  providerName: AgentProviderName;
  model: string;
  modelClient: ModelClient;
  warnings: string[];
};
