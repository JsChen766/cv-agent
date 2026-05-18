import type { FastifyRequest } from "fastify";
import { ApiError, ErrorCodes } from "../errors.js";
import type { ApiKernel } from "../types.js";
import { createKernelRequestContext } from "../context.js";

/** Extract a single string header value. */
export function readHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const firstValue = value?.find((item) => item.trim().length > 0);
  return firstValue?.trim();
}

/** Parse `?limit=N` from query, default undefined. */
export function readLimit(query: unknown): number | undefined {
  if (typeof query !== "object" || query === null) return undefined;
  const parsed = typeof (query as Record<string, unknown>).limit === "string"
    ? Number((query as Record<string, unknown>).limit)
    : undefined;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Assert body is a non-null, non-array object. */
export function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ApiError(ErrorCodes.INVALID_BODY, "Request body must be a JSON object.", 400);
  return value;
}

/** Assert value is a non-empty string. */
export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(ErrorCodes.INVALID_BODY, `${name} is required.`, 400);
  }
  return value;
}

/** Return trimmed string or undefined. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Standard isRecord check. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract named route param as string. */
export function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  return requiredString(value, name);
}

/** Standard response meta (no warnings). */
export function meta(kernel: ApiKernel, ctx: ReturnType<typeof createKernelRequestContext>) {
  return { requestId: ctx.request.requestId, traceId: ctx.request.traceId, mode: kernel.mode };
}

/** Standard response meta with warnings. */
export function metaWithWarnings(kernel: ApiKernel, ctx: ReturnType<typeof createKernelRequestContext>) {
  return {
    requestId: ctx.request.requestId,
    traceId: ctx.request.traceId,
    mode: kernel.mode,
    ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
  };
}
