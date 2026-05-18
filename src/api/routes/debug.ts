import type { FastifyInstance, FastifyRequest } from "fastify";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError, ErrorCodes } from "../errors.js";
import { readAgentModeConfig } from "../../providers/factory/agentModes.js";
import { AgentProviderFactory } from "../../providers/factory/AgentProviderFactory.js";
import type { AgentProviderFactoryConfig } from "../../providers/factory/types.js";
import { readAgentRuntimeConfig } from "../../agents/runtime/AgentRuntimeConfig.js";
import {
  DETERMINISTIC_RUNTIME_WARNING,
  readAllowDeterministicRuntime,
} from "../../agents/runtime/AgentRuntimeGuards.js";

export async function registerDebugRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver?: AuthResolver<FastifyRequest>,
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

  app.get("/debug/agent-runs", async (request) => {
    assertDebugRunsEnabled();
    if (!authResolver) throw new ApiError(ErrorCodes.UNAUTHORIZED, "Authentication is required.", 401);
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const data = await kernel.platformServices.agentRuns.listRuns(ctx.user.id, readLimit(request.query));
    return success(data, {
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
      mode: kernel.mode,
    });
  });

  app.get("/debug/agent-runs/:id", async (request) => {
    assertDebugRunsEnabled();
    if (!authResolver) throw new ApiError(ErrorCodes.UNAUTHORIZED, "Authentication is required.", 401);
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const id = (request.params as Record<string, unknown>).id;
    if (typeof id !== "string" || !id.trim()) throw new ApiError(ErrorCodes.INVALID_BODY, "id is required.", 400);
    const data = await kernel.platformServices.agentRuns.getRun(ctx.user.id, id);
    if (!data) throw new ApiError(ErrorCodes.NOT_FOUND, "Agent run not found.", 404);
    return success(data, {
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
      mode: kernel.mode,
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
  allowDeterministicRuntime: boolean;
  hasApiKey: boolean;
  agentRuntime: {
    provider: string;
    model: string;
    frontDeskAgentMode: string;
    toolCallingMode: string;
    allowMockRuntime: boolean;
    allowDeterministicRouter: boolean;
    allowDeterministicRuntime: boolean;
    hasApiKey: boolean;
  };
  legacyKernelAgents: {
    legacyFrontDeskPresent: boolean;
    legacyFrontDeskInUseByCopilot: false;
    legacyFrontDeskUsedByCopilot: false;
    legacyFrontDeskUsedByDocuments: false;
    experienceExtractorMode: string;
    artifactGeneratorMode: string;
    criticAgentMode: string;
    revisionAgentMode: string;
  };
  database: {
    mode: string;
    hasDatabaseUrl: boolean;
  };
  safety: {
    mockRuntimeAllowed: boolean;
    deterministicRuntimeAllowed: boolean;
    warnings: string[];
  };
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
  const allowDeterministicRuntime = readAllowDeterministicRuntime();

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

  const databaseMode = kernel.mode ?? "in_memory";

  if (provider === "mock") {
    warnings.push("Provider is in mock mode. LLM features are not live.");
  }
  if (allowDeterministicRuntime && process.env.NODE_ENV !== "test") {
    warnings.push(DETERMINISTIC_RUNTIME_WARNING);
  }
  const uniqueWarnings = [...new Set(warnings)];
  const agentRuntime = {
    provider,
    model,
    frontDeskAgentMode: runtimeConfig.frontDeskAgentMode,
    toolCallingMode: runtimeConfig.toolCallingMode,
    allowMockRuntime: runtimeConfig.allowMockRuntime,
    allowDeterministicRouter: runtimeConfig.allowDeterministicRouter,
    allowDeterministicRuntime,
    hasApiKey: runtimeConfig.hasApiKey,
  };
  const legacyKernelAgents = {
    legacyFrontDeskPresent: false,
    legacyFrontDeskInUseByCopilot: false as const,
    legacyFrontDeskUsedByCopilot: false as const,
    legacyFrontDeskUsedByDocuments: false as const,
    experienceExtractorMode: agentModes.experienceExtractorMode,
    artifactGeneratorMode: agentModes.artifactGeneratorMode,
    criticAgentMode: agentModes.criticAgentMode,
    revisionAgentMode: agentModes.revisionAgentMode,
  };
  const database = {
    mode: databaseMode,
    hasDatabaseUrl,
  };
  const safety = {
    mockRuntimeAllowed: runtimeConfig.allowMockRuntime,
    deterministicRuntimeAllowed: allowDeterministicRuntime,
    warnings: uniqueWarnings,
  };

  return {
    provider,
    model,
    frontDeskAgentMode: runtimeConfig.frontDeskAgentMode,
    toolCallingMode: runtimeConfig.toolCallingMode,
    allowMockRuntime: runtimeConfig.allowMockRuntime,
    allowDeterministicRouter: runtimeConfig.allowDeterministicRouter,
    allowDeterministicRuntime,
    hasApiKey: runtimeConfig.hasApiKey,
    agentRuntime,
    legacyKernelAgents,
    database,
    safety,
    runtimeMode: kernel.mode,
    nodeEnv: process.env.NODE_ENV ?? "development",
    dbMode: databaseMode,
    frontDeskMode: agentModes.frontDeskAgentMode,
    experienceExtractorMode: agentModes.experienceExtractorMode,
    artifactGeneratorMode: agentModes.artifactGeneratorMode,
    criticAgentMode: agentModes.criticAgentMode,
    revisionAgentMode: agentModes.revisionAgentMode,
    allowMockFallback,
    hasDatabaseUrl,
    hasDeepSeekApiKey,
    warnings: uniqueWarnings,
  };
}

function assertDebugRunsEnabled(): void {
  if (process.env.NODE_ENV === "production" && process.env.DEBUG_ROUTES_ENABLED !== "true") {
    throw new ApiError(ErrorCodes.FORBIDDEN, "Debug agent run routes are disabled in production.", 403);
  }
}

function readLimit(query: unknown): number | undefined {
  if (typeof query !== "object" || query === null) return undefined;
  const value = (query as Record<string, unknown>).limit;
  const parsed = typeof value === "string" ? Number(value) : undefined;
  return Number.isFinite(parsed) ? parsed : undefined;
}
