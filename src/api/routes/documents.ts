import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { ApiKernel, IngestDocumentJsonBody } from "../types.js";
import type { DocumentInput } from "../../tools/document/index.js";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { withIdempotency } from "../idempotency.js";
import { applyRateLimit } from "../rateLimit.js";
import { success } from "../response.js";

export async function registerDocumentRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  app.post("/documents/ingest", async (request, reply) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    await applyRateLimit(kernel, ctx, request);
    const body = parseIngestBody(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const document = toDocumentInput(ctx.user.id, body);

      const result = await kernel.cvAgentKernel.documents.ingest(ctx, {
        message: "Import this resume document.",
        documents: [document],
      });

      return success(result, {
        requestId: ctx.request.requestId,
        traceId: ctx.request.traceId,
        mode: kernel.mode,
        ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
      });
    });
  });
}

function parseIngestBody(body: unknown): IngestDocumentJsonBody {
  if (!isRecord(body)) {
    throw new ApiError("INVALID_BODY", "Request body must be a JSON object.", 400);
  }
  const fileName = body.fileName;
  if (typeof fileName !== "string" || !fileName.trim()) {
    throw new ApiError("INVALID_BODY", "fileName is required.", 400);
  }
  const text = optionalString(body.text);
  const base64 = optionalString(body.base64);
  if (!text && !base64) {
    throw new ApiError("INVALID_BODY", "Either text or base64 is required.", 400);
  }
  return {
    fileName,
    mimeType: optionalString(body.mimeType),
    extension: optionalString(body.extension),
    text,
    base64,
    sourceRef: optionalString(body.sourceRef),
  };
}

function toDocumentInput(userId: string, body: IngestDocumentJsonBody): DocumentInput {
  const buffer = body.text
    ? new TextEncoder().encode(body.text)
    : Buffer.from(body.base64 ?? "", "base64");
  return {
    userId,
    fileName: body.fileName,
    ...(body.mimeType ? { mimeType: body.mimeType } : {}),
    ...(body.extension ? { extension: body.extension } : {}),
    sourceRef: body.sourceRef ?? `api:${userId}:${body.fileName}`,
    buffer,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
