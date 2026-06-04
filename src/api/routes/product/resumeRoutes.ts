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
  stringArray,
  readSectionType,
  param,
  readLimit,
  type ProductRouteContextFn,
} from "./productRouteHelpers.js";

export function registerResumeRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  contextFor: ProductRouteContextFn,
  _authResolver: AuthResolver<FastifyRequest>,
): void {
  app.get("/product/resumes", async (request) => {
    const ctx = await contextFor(request);
    return productSuccess(await kernel.productServices.resumeService.listResumes(ctx.user.id, readLimit(request.query)), kernel, ctx);
  });

  app.post("/product/resumes", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => productSuccess(await kernel.productServices.resumeService.createResume(ctx.user.id, {
        title: optionalString(body.title),
        targetRole: optionalString(body.targetRole),
        jdId: optionalString(body.jdId),
      }), kernel, ctx));
  });

  app.get("/product/resumes/:id", async (request) => {
    const ctx = await contextFor(request);
    const resume = await kernel.productServices.resumeService.getResume(ctx.user.id, param(request, "id"));
    if (!resume) throw new ApiError(ErrorCodes.NOT_FOUND, "Resume not found.", 404);
    return productSuccess(resume, kernel, ctx);
  });

  app.post("/product/resumes/:id/items", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const item = await kernel.productServices.resumeService.addResumeItem(ctx.user.id, param(request, "id"), {
        title: requiredString(body.title, "title"),
        contentSnapshot: requiredString(body.contentSnapshot, "contentSnapshot"),
        sectionType: readSectionType(body.sectionType),
        sourceExperienceId: optionalString(body.sourceExperienceId),
        sourceVariantId: optionalString(body.sourceVariantId),
        sourceArtifactId: optionalString(body.sourceArtifactId),
      });
      return productSuccess(item, kernel, ctx);
    });
  });

  app.patch("/product/resume-items/:id", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const item = await kernel.productServices.resumeService.updateResumeItem(ctx.user.id, param(request, "id"), {
        title: optionalString(body.title),
        contentSnapshot: optionalString(body.contentSnapshot),
        hidden: typeof body.hidden === "boolean" ? body.hidden : undefined,
        pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
      });
      if (!item) throw new ApiError(ErrorCodes.NOT_FOUND, "Resume item not found.", 404);
      return productSuccess(item, kernel, ctx);
    });
  });

  app.post("/product/resumes/:id/reorder", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () =>
      productSuccess(await kernel.productServices.resumeService.reorderResumeItems(ctx.user.id, param(request, "id"), stringArray(body.orderedIds)), kernel, ctx));
  });
}
