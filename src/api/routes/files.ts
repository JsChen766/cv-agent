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
    const buffer = decodeBase64(base64);
    return {
      originalName: requiredString(record.fileName ?? record.originalName, "fileName"),
      mimeType: requiredString(record.mimeType, "mimeType"),
      buffer,
    };
  }
  throw new ApiError(ErrorCodes.INVALID_BODY, "Expected multipart file upload or JSON base64 body.", 400);
}

function decodeBase64(value: string): Buffer {
  // Strip any data: URL prefix and surrounding whitespace so frontends can
  // pass either a raw base64 payload or a `data:<mime>;base64,...` URL.
  const cleaned = value.replace(/^data:[^;,]*;base64,/i, "").replace(/\s+/g, "");
  if (!cleaned) throw new ApiError(ErrorCodes.INVALID_BODY, "base64 payload is empty.", 400);
  if (!/^[A-Za-z0-9+/=_-]+$/.test(cleaned)) {
    throw new ApiError(ErrorCodes.INVALID_BODY, "base64 payload contains invalid characters.", 400);
  }
  const buffer = Buffer.from(cleaned, "base64");
  if (buffer.length === 0) {
    throw new ApiError(ErrorCodes.INVALID_BODY, "base64 payload decoded to an empty buffer.", 400);
  }
  return buffer;
}

function parseMultipartUpload(body: unknown, contentType: string): { originalName: string; mimeType: string; buffer: Buffer } {
  if (!Buffer.isBuffer(body)) throw new ApiError(ErrorCodes.INVALID_BODY, "Multipart body must be binary.", 400);
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundaryValue = (boundary?.[1] ?? boundary?.[2])?.trim();
  if (!boundaryValue) throw new ApiError(ErrorCodes.INVALID_BODY, "Multipart boundary is required.", 400);

  // Parse multipart bytes correctly — splitting on the boundary in `binary`
  // preserves byte positions, then we slice the raw `body` buffer for the
  // file content so PDFs/DOCX (which contain non-utf8 bytes) round-trip
  // intact.
  const delimiter = `--${boundaryValue}`;
  const raw = body.toString("binary");
  // Find each part's start by searching for the delimiter; build [start, end)
  // ranges that cover everything between consecutive delimiters.
  const parts: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const next = raw.indexOf(delimiter, cursor);
    if (next < 0) break;
    const partStart = next + delimiter.length;
    // skip CRLF after delimiter
    const after = raw.charCodeAt(partStart) === 0x0d && raw.charCodeAt(partStart + 1) === 0x0a
      ? partStart + 2
      : partStart;
    const closing = raw.indexOf(delimiter, after);
    if (closing < 0) break;
    parts.push({ start: after, end: closing });
    cursor = closing;
  }

  for (const part of parts) {
    const headerEnd = raw.indexOf("\r\n\r\n", part.start);
    if (headerEnd < 0 || headerEnd >= part.end) continue;
    const headerText = raw.slice(part.start, headerEnd);
    if (!/name="file"/i.test(headerText)) continue;
    const contentStart = headerEnd + 4;
    // Strip trailing CRLF that precedes the next boundary delimiter.
    const contentEnd = part.end >= 2 && raw.charCodeAt(part.end - 2) === 0x0d && raw.charCodeAt(part.end - 1) === 0x0a
      ? part.end - 2
      : part.end;
    if (contentEnd <= contentStart) {
      throw new ApiError(ErrorCodes.INVALID_BODY, "Uploaded file is empty.", 400);
    }
    const filename = headerText.match(/filename="([^"]*)"/i)?.[1]?.trim();
    const mimeType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? "application/octet-stream";
    const buffer = body.subarray(contentStart, contentEnd);
    return {
      originalName: filename && filename.length > 0 ? filename : "upload",
      mimeType,
      buffer,
    };
  }
  throw new ApiError(ErrorCodes.INVALID_BODY, 'Multipart "file" field is required.', 400);
}

