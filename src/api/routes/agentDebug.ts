import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError, ErrorCodes } from "../errors.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import { LLMGenerationService } from "../../product/LLMGenerationService.js";
import { createAgentTools } from "../../agent-tools/index.js";
import { readPlatformConfig } from "../../platform/config.js";
import { isRecord, meta, requireRecord } from "./helpers.js";

export async function registerAgentDebugRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  app.get("/copilot/agent-debug/tools", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    return success(createAgentTools().map((tool) => ({
      name: tool.name,
      ownerAgent: tool.ownerAgent,
      mutability: tool.mutability,
      requiresConfirmation: tool.requiresConfirmation,
      riskLevel: tool.riskLevel,
    })), {
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
      mode: kernel.mode,
    });
  });

  app.get("/debug/model", async (request) => {
    assertDebugRoutesEnabled();
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const config = kernel.modelRuntimeConfig;
    return success({
      provider: config?.provider,
      model: config?.model,
      baseURL: config?.baseURL,
      apiKeyConfigured: Boolean(config?.apiKeyConfigured),
      kernelWarnings: kernel.warnings,
    }, meta(kernel, ctx));
  });

  app.post("/debug/model/generate-resume-smoke", async (request) => {
    assertDebugRoutesEnabled();
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const body = requireRecord(request.body);
    const jdText = typeof body.jdText === "string" && body.jdText.trim()
      ? body.jdText
      : "Frontend Engineer role requiring Vue, TypeScript, collaboration, and product delivery.";
    const targetRole = typeof body.targetRole === "string" ? body.targetRole : undefined;

    // Resolve model client: prefer user config, fall back to default
    const resolved = await kernel.resolveUserModelClient(ctx.user.id);
    const generationService = resolved.client
      ? new LLMGenerationService(resolved.client)
      : kernel.llmGenerationService;

    if (!generationService) {
      return success({
        ok: false,
        variantCount: 0,
        error: "LLM_PROVIDER_NOT_CONFIGURED: No AI model provider is configured.",
        modelSource: resolved.source,
      }, meta(kernel, ctx));
    }
    try {
      const result = await generationService.generateVariants(ctx.user.id, jdText, targetRole, []);
      return success({
        ok: true,
        variantCount: result.variants.length,
        variants: result.variants,
        recommendedVariantId: result.recommendedVariantId,
        comparisonMatrix: result.comparisonMatrix,
        modelSource: resolved.source,
        ...(resolved.configSummary ? { modelConfig: resolved.configSummary } : {}),
      }, meta(kernel, ctx));
    } catch (error) {
      return success({
        ok: false,
        variantCount: 0,
        error: error instanceof Error ? error.message : String(error),
        details: isRecord(error) ? {
          phase: error.phase,
          providerErrorMessage: error.providerErrorMessage,
          rawContentPreview: error.rawContentPreview,
          schemaIssues: error.schemaIssues,
        } : undefined,
      }, meta(kernel, ctx));
    }
  });
}

function assertDebugRoutesEnabled(): void {
  if (!readPlatformConfig().debugRoutesEnabled) {
    throw new ApiError(ErrorCodes.NOT_FOUND, "Route not found.", 404);
  }
}
