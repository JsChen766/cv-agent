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
  optionalRecord,
  stringArray,
  compactRecord,
  readCategory,
  readRevisionSource,
  readVariantType,
  readLanguage,
  param,
  readLimit,
  type ProductRouteContextFn,
} from "./productRouteHelpers.js";

export function registerExperienceRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  contextFor: ProductRouteContextFn,
  _authResolver: AuthResolver<FastifyRequest>,
): void {
  app.get("/product/experiences", async (request) => {
    const ctx = await contextFor(request);
    const data = await kernel.productServices.experienceService.listExperiences(ctx.user.id, { limit: readLimit(request.query) });
    return productSuccess(data, kernel, ctx);
  });

  app.post("/product/experiences", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const data = await kernel.productServices.experienceService.createExperience(ctx.user.id, {
        title: requiredString(body.title, "title"),
        content: requiredString(body.content, "content"),
        category: readCategory(body.category),
        organization: optionalString(body.organization),
        role: optionalString(body.role),
        startDate: optionalString(body.startDate),
        endDate: optionalString(body.endDate),
        tags: stringArray(body.tags),
        structured: optionalRecord(body.structured),
        sourceDocumentId: optionalString(body.sourceDocumentId),
      });
      return productSuccess(data, kernel, ctx);
    });
  });

  app.get("/product/experiences/:id", async (request) => {
    const ctx = await contextFor(request);
    const experience = await kernel.productServices.experienceService.getExperience(ctx.user.id, param(request, "id"));
    if (!experience) throw new ApiError(ErrorCodes.NOT_FOUND, "Experience not found.", 404);
    const [revisions, variants] = await Promise.all([
      kernel.productServices.experienceService.listRevisions(ctx.user.id, experience.id),
      kernel.productServices.experienceService.listVariants(ctx.user.id, experience.id),
    ]);
    return productSuccess({ experience, revisions, variants }, kernel, ctx);
  });

  app.patch("/product/experiences/:id", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const patch = compactRecord({
        title: optionalString(body.title),
        category: readCategory(body.category),
        organization: optionalString(body.organization),
        role: optionalString(body.role),
        startDate: optionalString(body.startDate),
        endDate: optionalString(body.endDate),
        sourceDocumentId: optionalString(body.sourceDocumentId),
        ...(Array.isArray(body.tags) ? { tags: stringArray(body.tags) } : {}),
      });
      const id = param(request, "id");
      const structured = optionalRecord(body.structured);
      const content = optionalString(body.content);
      const hasPatch = Object.keys(patch).length > 0;
      const needsRevision = structured !== undefined || typeof content === "string";
      if (!hasPatch && !needsRevision) {
        throw new ApiError(ErrorCodes.INVALID_BODY, "Please provide at least one patch field, content, or structured.", 400);
      }
      const updated = await kernel.productServices.experienceService.updateExperience(ctx.user.id, id, {
        ...patch,
      });
      if (!updated) throw new ApiError(ErrorCodes.NOT_FOUND, "Experience not found.", 404);
      if (needsRevision) {
        const revisions = await kernel.productServices.experienceService.listRevisions(ctx.user.id, id);
        const currentRevision = updated.currentRevisionId
          ? revisions.find((item) => item.id === updated.currentRevisionId)
          : revisions.at(0);
        const revision = await kernel.productServices.experienceService.createRevision(ctx.user.id, id, {
          content: content ?? currentRevision?.content ?? "",
          structured,
          source: "manual",
        });
        const latest = await kernel.productServices.experienceService.getExperience(ctx.user.id, id);
        return productSuccess({ experience: latest ?? updated, revision }, kernel, ctx);
      }
      return productSuccess(updated, kernel, ctx);
    });
  });

  app.post("/product/experiences/:id/revisions", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const revision = await kernel.productServices.experienceService.createRevision(ctx.user.id, param(request, "id"), {
        content: requiredString(body.content, "content"),
        source: readRevisionSource(body.source),
        structured: optionalRecord(body.structured),
      });
      return productSuccess(revision, kernel, ctx);
    });
  });

  app.post("/product/experiences/:id/variants", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const variant = await kernel.productServices.experienceService.createVariant(ctx.user.id, param(request, "id"), requiredString(body.revisionId, "revisionId"), {
        content: requiredString(body.content, "content"),
        variantType: readVariantType(body.variantType),
        language: readLanguage(body.language),
        targetJdId: optionalString(body.targetJdId),
      });
      return productSuccess(variant, kernel, ctx);
    });
  });
}
