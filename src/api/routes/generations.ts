import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { ApiKernel, GenerateJsonBody } from "../types.js";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { success } from "../response.js";

export async function registerGenerationRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  app.post("/generations", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const body = parseGenerateBody(request.body);
    const result = await kernel.cvAgentKernel.generations.create(ctx, {
      jdText: body.jdText,
      targetRole: body.targetRole,
    });

    return success(result, {
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
      mode: kernel.mode,
      ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
    });
  });
}

function parseGenerateBody(body: unknown): GenerateJsonBody {
  if (!isRecord(body)) {
    throw new ApiError("INVALID_BODY", "Request body must be a JSON object.", 400);
  }
  if (typeof body.jdText !== "string" || !body.jdText.trim()) {
    throw new ApiError("INVALID_BODY", "jdText is required.", 400);
  }
  if (typeof body.targetRole !== "string" || !body.targetRole.trim()) {
    throw new ApiError("INVALID_BODY", "targetRole is required.", 400);
  }
  return {
    jdText: body.jdText,
    targetRole: body.targetRole,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
