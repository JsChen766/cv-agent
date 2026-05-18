import type { FastifyInstance } from "fastify";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import { readAgentModeConfig } from "../../providers/factory/agentModes.js";
import { AgentProviderFactory } from "../../providers/factory/AgentProviderFactory.js";
import type { AgentProviderFactoryConfig } from "../../providers/factory/types.js";
import { readAgentRuntimeConfig } from "../../agents/runtime/AgentRuntimeConfig.js";

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
  model: string;
  frontDeskAgentMode: string;
  toolCallingMode: string;
  allowMockRuntime: boolean;
  allowDeterministicRouter: boolean;
  hasApiKey: boolean;
  database: string;
  runtimeMode: string;
  nodeEnv: string;
  dbMode: string;
  frontDeskMode: string;
  experienceExtractorMode: string;
  artifactGeneratorMode: string;
  criticAgentMode: string;
  revisionAgentMode: string;
  allowMockFallback: boolean;
  hasDatabaseUrl: boolean;
  hasDeepSeekApiKey: boolean;
  warnings: string[];
} {
  const agentModes = readAgentModeConfig();
  const warnings: string[] = [...kernel.warnings];
  const runtimeConfig = readAgentRuntimeConfig();
  warnings.push(...runtimeConfig.warnings);

  let providerConfig: AgentProviderFactoryConfig | null = null;
  let provider: string = runtimeConfig.provider;
  let model = runtimeConfig.model;
  let allowMockFallback = false;
  let hasDeepSeekApiKey = runtimeConfig.hasApiKey;

  try {
    providerConfig = AgentProviderFactory.fromEnv();
    provider = providerConfig.provider;
    model = providerConfig.model ?? runtimeConfig.model;
    allowMockFallback = providerConfig.allowMockFallback ?? false;
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
    model,
    frontDeskAgentMode: runtimeConfig.frontDeskAgentMode,
    toolCallingMode: runtimeConfig.toolCallingMode,
    allowMockRuntime: runtimeConfig.allowMockRuntime,
    allowDeterministicRouter: runtimeConfig.allowDeterministicRouter,
    hasApiKey: runtimeConfig.hasApiKey,
    database,
    runtimeMode: kernel.mode,
    nodeEnv: process.env.NODE_ENV ?? "development",
    dbMode: database,
    frontDeskMode: agentModes.frontDeskAgentMode,
    experienceExtractorMode: agentModes.experienceExtractorMode,
    artifactGeneratorMode: agentModes.artifactGeneratorMode,
    criticAgentMode: agentModes.criticAgentMode,
    revisionAgentMode: agentModes.revisionAgentMode,
    allowMockFallback,
    hasDatabaseUrl,
    hasDeepSeekApiKey,
    warnings,
  };
}
