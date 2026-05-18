import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError, ErrorCodes } from "./errors.js";
import type { ApiKernel } from "./types.js";

export async function withIdempotency<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  kernel: ApiKernel,
  userId: string,
  handler: () => Promise<T>,
): Promise<T> {
  const key = readHeader(request.headers["idempotency-key"]);
  if (!key) return handler();
  const requestHash = hashRequestBody(request.body);
  const begin = await kernel.platformServices.idempotency.begin({
    userId,
    key,
    requestMethod: request.method,
    requestPath: request.url.split("?")[0] ?? request.url,
    requestHash,
  });
  if (begin.type === "replay") {
    reply.status(begin.entry.responseStatus ?? 200);
    return begin.entry.responseBody as T;
  }
  if (begin.type === "conflict") {
    throw new ApiError(
      begin.reason === "hash_mismatch" ? ErrorCodes.IDEMPOTENCY_CONFLICT : ErrorCodes.CONFLICT,
      begin.reason === "hash_mismatch"
        ? "Idempotency-Key was reused with a different request body."
        : "A request with this Idempotency-Key is still pending.",
      409,
      { retryable: begin.reason === "pending" },
    );
  }
  try {
    const response = await handler();
    await kernel.platformServices.idempotency.complete(userId, key, reply.statusCode, response);
    return response;
  } catch (error) {
    await kernel.platformServices.idempotency.fail(userId, key);
    throw error;
  }
}

export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const firstValue = value?.find((item) => item.trim().length > 0);
  return firstValue?.trim();
}
