import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError, ErrorCodes } from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import { applyRateLimit } from "../rateLimit.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import { meta, param, readHeader, readLimit, requiredString } from "./helpers.js";

export async function registerFileRoutes(app: FastifyInstance, kernel: ApiKernel, authResolver: AuthResolver<FastifyRequest>): Promise<void> {
  app.addContentTypeParser(/^multipart\/form-data/i, { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  const contextFor = async (request: FastifyRequest) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    await applyRateLimit(kernel, ctx, request);
    return ctx;
  };

  app.post("/files/upload", async (request, reply) => {
    const ctx = await contextFor(request);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const file = parseUpload(request);
      return success(await kernel.fileService.uploadFile(ctx.user.id, file), meta(kernel, ctx));
    });
  });

  app.get("/files", async (request) => {
    const ctx = await contextFor(request);
    return success(await kernel.fileService.listFiles(ctx.user.id, readLimit(request.query)), meta(kernel, ctx));
  });

  app.get("/files/:id", async (request) => {
    const ctx = await contextFor(request);
    const file = await kernel.fileService.getFile(ctx.user.id, param(request, "id"));
    if (!file) throw new ApiError(ErrorCodes.NOT_FOUND, "File not found.", 404);
    return success(file, meta(kernel, ctx));
  });

  app.delete("/files/:id", async (request, reply) => {
    const ctx = await contextFor(request);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const file = await kernel.fileService.deleteFile(ctx.user.id, param(request, "id"));
      if (!file) throw new ApiError(ErrorCodes.NOT_FOUND, "File not found.", 404);
      return success(file, meta(kernel, ctx));
    });
  });

  app.post("/files/:id/parse", async (request, reply) => {
    const ctx = await contextFor(request);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const fileId = param(request, "id");
      const file = await kernel.fileService.getFile(ctx.user.id, fileId);
      if (!file) throw new ApiError(ErrorCodes.NOT_FOUND, "File not found.", 404);
      const job = await kernel.platformServices.backgroundJobs.enqueue({
        userId: ctx.user.id,
        type: "parse_document",
        input: { fileId },
        progress: 0,
        priority: 0,
        maxAttempts: 3,
      });
      return success({ job }, meta(kernel, ctx));
    });
  });

  app.get("/files/:id/parsed-document", async (request) => {
    const ctx = await contextFor(request);
    const document = await kernel.fileService.getParsedDocumentByFileId(ctx.user.id, param(request, "id"));
    if (!document) throw new ApiError(ErrorCodes.NOT_FOUND, "Parsed document not found.", 404);
    return success(document, meta(kernel, ctx));
  });
}

function parseUpload(request: FastifyRequest): { originalName: string; mimeType: string; buffer: Buffer } {
  const contentType = readHeader(request.headers["content-type"]) ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    return parseMultipartUpload(request.body, contentType);
  }
  const body = request.body;
  if (typeof body === "object" && body !== null && !Buffer.isBuffer(body)) {
    const record = body as Record<string, unknown>;
    const base64 = requiredString(record.base64, "base64");
    return {
      originalName: requiredString(record.fileName ?? record.originalName, "fileName"),
      mimeType: requiredString(record.mimeType, "mimeType"),
      buffer: Buffer.from(base64, "base64"),
    };
  }
  throw new ApiError(ErrorCodes.INVALID_BODY, "Expected multipart file upload or JSON base64 body.", 400);
}

function parseMultipartUpload(body: unknown, contentType: string): { originalName: string; mimeType: string; buffer: Buffer } {
  if (!Buffer.isBuffer(body)) throw new ApiError(ErrorCodes.INVALID_BODY, "Multipart body must be binary.", 400);
  const boundary = contentType.match(/boundary=([^;]+)/i)?.[1];
  if (!boundary) throw new ApiError(ErrorCodes.INVALID_BODY, "Multipart boundary is required.", 400);
  const raw = body.toString("binary");
  const part = raw.split(`--${boundary}`).find((item) => item.includes('name="file"'));
  if (!part) throw new ApiError(ErrorCodes.INVALID_BODY, "file field is required.", 400);
  const [headerText, ...rest] = part.split("\r\n\r\n");
  const content = rest.join("\r\n\r\n").replace(/\r\n--$/, "").replace(/\r\n$/, "");
  const filename = headerText.match(/filename="([^"]+)"/)?.[1] ?? "upload";
  const mimeType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? "application/octet-stream";
  return { originalName: filename, mimeType, buffer: Buffer.from(content, "binary") };
}

