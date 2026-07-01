import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, ErrorCodes } from "../../errors.js";
import type { ApiKernel } from "../../types.js";
import type { AuthResolver } from "../../auth/index.js";
import { withIdempotency } from "../../idempotency.js";
import {
  productSuccess,
  requireRecord,
  requiredString,
  optionalString,
  param,
  readLimit,
  type ProductRouteContextFn,
} from "./productRouteHelpers.js";
import { extractVariantsFromOutputSnapshot, convertToWorkspaceVariants } from "./productDto.js";

export function registerGenerationRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  contextFor: ProductRouteContextFn,
  _authResolver: AuthResolver<FastifyRequest>,
): void {
  app.get("/product/dashboard", async (request) => {
    const ctx = await contextFor(request);
    return productSuccess(await kernel.copilotServices.workspaceService.getDashboard(ctx.user.id), kernel, ctx);
  });

  app.get("/product/generations", async (request) => {
    const ctx = await contextFor(request);
    return productSuccess(await kernel.productServices.generationProductService.listGenerations(ctx.user.id, readLimit(request.query)), kernel, ctx);
  });

  app.get("/product/generations/:id", async (request) => {
    const ctx = await contextFor(request);
    const generation = await kernel.productServices.generationProductService.getGeneration(ctx.user.id, param(request, "id"));
    if (!generation) throw new ApiError(ErrorCodes.NOT_FOUND, "Generation not found.", 404);
    const rawVariants = extractVariantsFromOutputSnapshot(generation.outputSnapshot);
    const variants = await convertToWorkspaceVariants(rawVariants, generation, ctx.user.id, kernel);
    const recommendedVariantId = generation.outputSnapshot?.recommendedVariantId as string | undefined;
    const comparisonMatrix = generation.outputSnapshot?.comparisonMatrix;
    return productSuccess({
      ...generation,
      variants,
      ...(recommendedVariantId ? { recommendedVariantId } : {}),
      ...(comparisonMatrix && Array.isArray(comparisonMatrix) && comparisonMatrix.length > 0 ? { comparisonMatrix } : {}),
    }, kernel, ctx);
  });

  app.post("/product/generations/from-jd", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    const jdId = optionalString(body.jdId);
    const jdText = optionalString(body.jdText ?? body.rawText ?? body.text);
    if (!jdId && !jdText) {
      throw new ApiError(ErrorCodes.INVALID_BODY, "jdText or jdId is required.", 400);
    }
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      await kernel.platformServices.usage.consume({ userId: ctx.user.id, metric: "generation" });
      const job = await kernel.platformServices.backgroundJobs.enqueue({
        userId: ctx.user.id,
        type: "long_generation",
        input: {
          actionType: "generate_resume_from_jd",
          toolArguments: {
            ...(jdId ? { jdId } : {}),
            ...(jdText ? { jdText } : {}),
            ...(optionalString(body.targetRole) ? { targetRole: optionalString(body.targetRole) } : {}),
          },
        },
        progress: 0,
        priority: 0,
        maxAttempts: 3,
      });
      return productSuccess({ job, jobId: job.id, actionType: "generate_resume_from_jd" }, kernel, ctx);
    });
  });

  app.post("/product/generations/:id/accept-variant", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => productSuccess(await kernel.productServices.generationProductService.saveAcceptedVariantToResume(ctx.user.id, {
        generationId: param(request, "id"),
        variantId: requiredString(body.variantId, "variantId"),
        resumeId: optionalString(body.resumeId),
      }), kernel, ctx));
  });
}
