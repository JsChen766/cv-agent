import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, ErrorCodes } from "../../errors.js";
import type { ApiKernel } from "../../types.js";
import type { AuthResolver } from "../../auth/index.js";
import { withIdempotency } from "../../idempotency.js";
import { ProductStateConflictError } from "../../../product/index.js";
import type { ProductExperienceCategory } from "../../../product/types.js";
import {
  productSuccess,
  requireRecord,
  requiredString,
  param,
  type ProductRouteContextFn,
} from "./productRouteHelpers.js";

export function registerImportRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  contextFor: ProductRouteContextFn,
  _authResolver: AuthResolver<FastifyRequest>,
): void {
  app.post("/product/imports/text", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const rawText = body.rawText ?? body.text;
      if (typeof rawText !== "string" || !rawText.trim()) {
        throw new ApiError(ErrorCodes.INVALID_BODY, "Please provide import text in rawText or text.", 400);
      }
      const job = await kernel.productServices.importService.createTextImportJob(ctx.user.id, rawText);
      const candidates = await kernel.productServices.importService.createCandidatesFromText(ctx.user.id, job.id);
      return productSuccess({ job, candidates }, kernel, ctx);
    });
  });

  app.post("/product/imports/file", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const fileId = requiredString(body.fileId, "fileId");
      const file = await kernel.fileService.getFile(ctx.user.id, fileId);
      if (!file) throw new ApiError(ErrorCodes.NOT_FOUND, "File not found.", 404);
      const job = await kernel.platformServices.backgroundJobs.enqueue({
        userId: ctx.user.id,
        type: "import_resume_file",
        input: { fileId },
        progress: 0,
        priority: 0,
        maxAttempts: 3,
      });
      return productSuccess({ job }, kernel, ctx);
    });
  });

  app.get("/product/imports/:id", async (request) => {
    const ctx = await contextFor(request);
    const job = await kernel.productServices.importService.getImportJob(ctx.user.id, param(request, "id"));
    if (!job) throw new ApiError(ErrorCodes.NOT_FOUND, "Import job not found.", 404);
    const candidates = await kernel.productServices.importService.listCandidatesByJob(ctx.user.id, job.id);
    return productSuccess({ job, candidates }, kernel, ctx);
  });

  app.post("/product/import-candidates/:id/accept", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      try {
        return productSuccess(await kernel.productServices.importService.acceptCandidate(ctx.user.id, param(request, "id"), sanitizeAcceptCandidatePatch(body)), kernel, ctx);
      } catch (error) {
        if (error instanceof ProductStateConflictError) {
          throw new ApiError(ErrorCodes.CONFLICT, error.message, 409, { retryable: true });
        }
        throw error;
      }
    });
  });

  app.post("/product/import-candidates/:id/reject", async (request, reply) => {
    const ctx = await contextFor(request);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () =>
      productSuccess(await kernel.productServices.importService.rejectCandidate(ctx.user.id, param(request, "id")), kernel, ctx));
  });
}

function sanitizeAcceptCandidatePatch(body: Record<string, unknown>) {
  const structured = body.structured && typeof body.structured === "object" && !Array.isArray(body.structured)
    ? body.structured as Record<string, unknown>
    : undefined;
  return {
    title: optionalString(body.title),
    category: optionalCategory(body.category),
    organization: optionalString(body.organization),
    role: optionalString(body.role),
    startDate: optionalString(body.startDate),
    endDate: optionalString(body.endDate),
    content: optionalString(body.content),
    structured,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalCategory(value: unknown): ProductExperienceCategory | undefined {
  return value === "work"
    || value === "internship"
    || value === "project"
    || value === "education"
    || value === "award"
    || value === "skill"
    || value === "other"
    ? value
    : undefined;
}
