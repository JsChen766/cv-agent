import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError, ErrorCodes } from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import { applyRateLimit } from "../rateLimit.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import type { ResumeExportFormat } from "../../exports/index.js";
import { readPlatformConfig } from "../../platform/config.js";
import { isRecord, meta, optionalString, param, readLimit } from "./helpers.js";

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
      console.debug("[exports] POST /exports/resumes/:resumeId", {
        exportId: result.exportRecord.id,
        jobId: result.job.id,
        status: result.exportRecord.status,
        workerDisabled: Boolean(result.workerDisabled),
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
    console.debug("[exports] GET /exports/:id", { exportId: record.id, status: record.status, jobId: record.jobId });
    return success(record, meta(kernel, ctx));
  });

  app.post("/exports/:id/render", async (request, reply) => {
    const config = readPlatformConfig();
    if (process.env.NODE_ENV === "production" && !config.debugRoutesEnabled) {
      throw new ApiError(ErrorCodes.NOT_FOUND, "Route not found.", 404);
    }
    const ctx = await contextFor(request);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const exportId = param(request, "id");
      const record = await kernel.exportService.renderExportJob(ctx.user.id, exportId);
      return success(record, meta(kernel, ctx));
    });
  });

  app.get("/exports/:id/download", async (request, reply) => {
    const ctx = await contextFor(request);
    const result = await kernel.exportService.readDownload(ctx.user.id, param(request, "id"));
    const contentType = result.exportRecord.format === "pdf" ? "application/pdf" : "text/html; charset=utf-8";
    reply.header("content-type", contentType);
    if (result.exportRecord.format === "pdf" && result.fileBuffer) {
      const filename = await buildDownloadFilename(kernel, ctx.user.id, result.exportRecord.resumeId, "pdf");
      reply.header("content-disposition", `attachment; filename="${filename}"`);
      return result.fileBuffer;
    }
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

function readFormat(value: unknown): ResumeExportFormat {
  if (value === undefined || value === "html") return "html";
  if (value === "pdf") return "pdf";
  throw new ApiError(ErrorCodes.INVALID_BODY, "format must be html or pdf.", 400);
}

async function buildDownloadFilename(kernel: ApiKernel, userId: string, resumeId: string, extension: string): Promise<string> {
  try {
    const resume = await kernel.productServices.resumeService.getResume(userId, resumeId);
    const base = sanitizeForContentDisposition(resume?.title) || resumeId;
    return `${base}.${extension}`;
  } catch {
    return `${resumeId}.${extension}`;
  }
}

function sanitizeForContentDisposition(title: string | undefined): string {
  if (!title) return "";
  // RFC 6266: keep ASCII-safe characters in the unquoted-style filename, and
  // collapse anything else to underscores so curl / browsers don't choke.
  return title
    .replace(/[\\/:*?"<>|\r\n]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
