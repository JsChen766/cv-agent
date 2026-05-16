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
      ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
    });
  });
}

function buildAgentModesReport(kernel: ApiKernel): {
  provider: {
    configured: string;
    active: string;
    model: string;
    isMock: boolean;
  };
  llm: {
    mode: string;
    isLive: boolean;
  };
  database: {
    mode: "postgres" | "in_memory";
    isPostgres: boolean;
    connection: "ok" | "not_configured" | "error";
  };
  agents: {
    experienceExtractor: string;
    artifactGenerator: string;
    criticAgent: string;
    revisionAgent: string;
    frontDeskAgent: string;
  };
  warnings: string[];
} {
  const agentModes = readAgentModeConfig();
  let providerConfig: AgentProviderFactoryConfig | null = null;
  let providerName = "unknown";
  let providerModel = "unknown";
  let isMock = false;

  try {
    providerConfig = AgentProviderFactory.fromEnv();
    providerName = providerConfig.provider;
    providerModel = providerConfig.model ?? "unknown";
    isMock = providerName === "mock";

    if (providerName === "deepseek" && !providerConfig.apiKey) {
      isMock = true; // fell back to mock
    }
  } catch {
    providerName = "error";
    providerModel = "error";
    isMock = true;
  }

  const llmAgentCount = [
    agentModes.experienceExtractorMode,
    agentModes.artifactGeneratorMode,
    agentModes.criticAgentMode,
    agentModes.revisionAgentMode,
  ].filter((m) => m === "llm").length;

  const warnings: string[] = [...kernel.warnings];

  if (isMock) {
    warnings.push("Provider is in mock mode. LLM features are not live.");
  }
  if (llmAgentCount > 0 && isMock) {
    warnings.push("LLM agents are configured but provider is mock. Agents will use deterministic/mock fallback.");
  }

  return {
    provider: {
      configured: process.env.AGENT_PROVIDER ?? "(default)",
      active: providerName,
      model: providerModel,
      isMock,
    },
    llm: {
      mode: llmAgentCount > 0 ? "llm" : "deterministic/mock",
      isLive: !isMock && llmAgentCount > 0,
    },
    database: {
      mode: kernel.mode ?? "in_memory",
      isPostgres: kernel.mode === "postgres",
      connection: kernel.mode === "postgres" ? "ok" : "not_configured",
    },
    agents: {
      experienceExtractor: agentModes.experienceExtractorMode,
      artifactGenerator: agentModes.artifactGeneratorMode,
      criticAgent: agentModes.criticAgentMode,
      revisionAgent: agentModes.revisionAgentMode,
      frontDeskAgent: agentModes.frontDeskAgentMode === "llm" ? "llm" : "mock (orchestrator)",
    },
    warnings,
  };
}
