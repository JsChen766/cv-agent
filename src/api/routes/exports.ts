import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError, ErrorCodes } from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import { applyRateLimit } from "../rateLimit.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import type { ResumeExportFormat } from "../../exports/index.js";

export async function registerExportRoutes(app: FastifyInstance, kernel: ApiKernel, authResolver: AuthResolver<FastifyRequest>): Promise<void> {
  const contextFor = async (request: FastifyRequest) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    await applyRateLimit(kernel, ctx, request);
    return ctx;
  };

  app.post("/exports/resumes/:resumeId", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = isRecord(request.body) ? request.body : {};
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const result = await kernel.exportService.createExport(ctx.user.id, {
        resumeId: param(request, "resumeId"),
        format: readFormat(body.format),
        templateId: optionalString(body.templateId),
      });
      return success(result, meta(kernel, ctx));
    });
  });

  app.get("/exports", async (request) => {
    const ctx = await contextFor(request);
    return success(await kernel.exportService.listExports(ctx.user.id, readLimit(request.query)), meta(kernel, ctx));
  });

  app.get("/exports/:id", async (request) => {
    const ctx = await contextFor(request);
    const record = await kernel.exportService.getExport(ctx.user.id, param(request, "id"));
    if (!record) throw new ApiError(ErrorCodes.NOT_FOUND, "Export not found.", 404);
    return success(record, meta(kernel, ctx));
  });

  app.get("/exports/:id/download", async (request, reply) => {
    const ctx = await contextFor(request);
    const result = await kernel.exportService.readDownload(ctx.user.id, param(request, "id"));
    const contentType = result.exportRecord.format === "pdf" ? "application/pdf" : "text/html; charset=utf-8";
    reply.header("content-type", contentType);
    return result.fileText;
  });

  app.delete("/exports/:id", async (request, reply) => {
    const ctx = await contextFor(request);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const record = await kernel.exportService.deleteExport(ctx.user.id, param(request, "id"));
      if (!record) throw new ApiError(ErrorCodes.NOT_FOUND, "Export not found.", 404);
      return success(record, meta(kernel, ctx));
    });
  });
}

function meta(kernel: ApiKernel, ctx: ReturnType<typeof createKernelRequestContext>) {
  return { requestId: ctx.request.requestId, traceId: ctx.request.traceId, mode: kernel.mode };
}

function readFormat(value: unknown): ResumeExportFormat {
  if (value === undefined || value === "html") return "html";
  if (value === "pdf") return "pdf";
  throw new ApiError(ErrorCodes.INVALID_BODY, "format must be html or pdf.", 400);
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== "string" || !value.trim()) throw new ApiError(ErrorCodes.INVALID_BODY, `${name} is required.`, 400);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readLimit(query: unknown): number | undefined {
  if (!isRecord(query)) return undefined;
  const parsed = typeof query.limit === "string" ? Number(query.limit) : undefined;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
