import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { ApiKernel } from "../types.js";
import type { GraphScopeType } from "../../application/query/index.js";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { success } from "../response.js";

export async function registerEvidenceRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  app.get<{ Params: { sessionId: string } }>("/generations/:sessionId/evidence-chains", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const result = await kernel.cvAgentKernel.generations.getEvidenceChains(ctx, {
      sessionId: request.params.sessionId,
    });
    return success(result, {
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
      mode: kernel.mode,
      ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
    });
  });

  app.get<{ Params: { scopeType: string; scopeId: string } }>("/graphs/:scopeType/:scopeId", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const scopeType = parseScopeType(request.params.scopeType);
    const result = await kernel.cvAgentKernel.generations.getGraph(ctx, {
      scopeType,
      scopeId: request.params.scopeId,
    });
    return success(result, {
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
      mode: kernel.mode,
      ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
    });
  });
}

function parseScopeType(value: string): GraphScopeType {
  if (value === "user" || value === "experience" || value === "generation" || value === "artifact") {
    return value;
  }
  throw new ApiError("INVALID_SCOPE_TYPE", "scopeType must be user, experience, generation, or artifact.", 400);
}
