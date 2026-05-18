import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError, ErrorCodes } from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import { applyRateLimit } from "../rateLimit.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import type { BackgroundJobType } from "../../platform/index.js";

export async function registerJobRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  const contextFor = async (request: FastifyRequest) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    await applyRateLimit(kernel, ctx, request);
    return ctx;
  };

  app.get("/jobs", async (request) => {
    const ctx = await contextFor(request);
    return success(await kernel.platformServices.backgroundJobs.listJobs(ctx.user.id, readLimit(request.query)), meta(kernel, ctx));
  });

  app.post("/jobs", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const job = await kernel.platformServices.backgroundJobs.createJob({
        userId: ctx.user.id,
        type: readJobType(body.type),
        input: isRecord(body.input) ? body.input : undefined,
        runAfter: typeof body.runAfter === "string" ? body.runAfter : undefined,
      });
      return success(job, meta(kernel, ctx));
    });
  });

  app.get("/jobs/:id", async (request) => {
    const ctx = await contextFor(request);
    const job = await kernel.platformServices.backgroundJobs.getJob(ctx.user.id, param(request, "id"));
    if (!job) throw new ApiError(ErrorCodes.NOT_FOUND, "Job not found.", 404);
    return success(job, meta(kernel, ctx));
  });

  app.post("/jobs/:id/cancel", async (request, reply) => {
    const ctx = await contextFor(request);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const job = await kernel.platformServices.backgroundJobs.cancelJob(ctx.user.id, param(request, "id"));
      if (!job) throw new ApiError(ErrorCodes.NOT_FOUND, "Job not found.", 404);
      return success(job, meta(kernel, ctx));
    });
  });
}

function meta(kernel: ApiKernel, ctx: ReturnType<typeof createKernelRequestContext>) {
  return {
    requestId: ctx.request.requestId,
    traceId: ctx.request.traceId,
    mode: kernel.mode,
    ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
  };
}

function readJobType(value: unknown): BackgroundJobType {
  if (value === "import_pdf" || value === "export_pdf" || value === "rebuild_index" || value === "long_generation") return value;
  throw new ApiError(ErrorCodes.INVALID_BODY, "type must be import_pdf, export_pdf, rebuild_index, or long_generation.", 400);
}

function param(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, unknown>;
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) throw new ApiError(ErrorCodes.INVALID_BODY, `${name} is required.`, 400);
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ApiError(ErrorCodes.INVALID_BODY, "Request body must be a JSON object.", 400);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLimit(query: unknown): number | undefined {
  if (!isRecord(query)) return undefined;
  const parsed = typeof query.limit === "string" ? Number(query.limit) : undefined;
  return Number.isFinite(parsed) ? parsed : undefined;
}
