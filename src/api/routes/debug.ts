import type { FastifyInstance } from "fastify";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import { readAgentModeConfig } from "../../providers/factory/agentModes.js";
import { AgentProviderFactory } from "../../providers/factory/AgentProviderFactory.js";
import type { AgentProviderFactoryConfig } from "../../providers/factory/types.js";

export async function registerDebugRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
): Promise<void> {
  app.get("/debug/agent-modes", async () => {
    const result = buildAgentModesReport(kernel);
    return success(result, {
      requestId: "debug",
      traceId: "debug",
      mode: kernel.mode,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    });
  });
}

function buildAgentModesReport(kernel: ApiKernel): {
  provider: string;
  database: string;
  runtimeMode: string;
  nodeEnv: string;
  frontDeskMode: string;
  experienceExtractorMode: string;
  artifactGeneratorMode: string;
  criticAgentMode: string;
  revisionAgentMode: string;
  allowMockFallback: boolean;
  model: string;
  hasDatabaseUrl: boolean;
  hasDeepSeekApiKey: boolean;
  warnings: string[];
} {
  const agentModes = readAgentModeConfig();
  const warnings: string[] = [...kernel.warnings];

  let providerConfig: AgentProviderFactoryConfig | null = null;
  let provider = "unknown";
  let model = "unknown";
  let allowMockFallback = false;
  let hasDeepSeekApiKey = false;

  try {
    providerConfig = AgentProviderFactory.fromEnv();
    provider = providerConfig.provider;
    model = providerConfig.model ?? (provider === "deepseek" ? "deepseek-chat" : "mock");
    allowMockFallback = providerConfig.allowMockFallback ?? false;
    hasDeepSeekApiKey = Boolean(providerConfig.apiKey);

    if (provider === "deepseek" && !hasDeepSeekApiKey) {
      provider = "mock";
      warnings.push("AGENT_PROVIDER is deepseek but DEEPSEEK_API_KEY is missing. Falling back to mock provider.");
    }
  } catch {
    provider = "error";
    model = "error";
    warnings.push("Failed to read provider config.");
  }

  const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
  if (hasDatabaseUrl && kernel.mode !== "postgres") {
    warnings.push("DATABASE_URL is set but kernel is not in postgres mode.");
  }

  const database = kernel.mode ?? "in_memory";

  if (provider === "mock") {
    warnings.push("Provider is in mock mode. LLM features are not live.");
  }

  return {
    provider,
    database,
    runtimeMode: kernel.mode,
    nodeEnv: process.env.NODE_ENV ?? "development",
    frontDeskMode: agentModes.frontDeskAgentMode,
    experienceExtractorMode: agentModes.experienceExtractorMode,
    artifactGeneratorMode: agentModes.artifactGeneratorMode,
    criticAgentMode: agentModes.criticAgentMode,
    revisionAgentMode: agentModes.revisionAgentMode,
    allowMockFallback,
    model,
    hasDatabaseUrl,
    hasDeepSeekApiKey,
    warnings,
  };
}
