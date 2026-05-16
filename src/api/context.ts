import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type {
  KernelRequestContext,
  KernelRequestSource,
} from "../kernel/index.js";
import type { AgentEventSink } from "../kernel/events/index.js";
import type { ResolvedAuth } from "./auth/index.js";

export function createKernelRequestContext(
  request: FastifyRequest,
  resolvedAuth: ResolvedAuth,
  options: {
    source?: KernelRequestSource;
    requestId?: string;
    traceId?: string;
    eventSink?: AgentEventSink;
  } = {},
): KernelRequestContext {
  const requestId = options.requestId ??
    readHeader(request.headers["x-request-id"]) ??
    `req-${randomUUID()}`;
  const traceId = options.traceId ??
    readHeader(request.headers["x-trace-id"]) ??
    requestId;
  const userAgent = readHeader(request.headers["user-agent"]);

  return {
    user: {
      id: resolvedAuth.user.id,
      ...(resolvedAuth.user.email ? { email: resolvedAuth.user.email } : {}),
      ...(resolvedAuth.user.displayName ? { displayName: resolvedAuth.user.displayName } : {}),
      roles: resolvedAuth.user.roles,
    },
    auth: {
      mode: resolvedAuth.auth.mode,
      ...(resolvedAuth.auth.sessionId ? { sessionId: resolvedAuth.auth.sessionId } : {}),
      ...(resolvedAuth.auth.tokenId ? { tokenId: resolvedAuth.auth.tokenId } : {}),
    },
    request: {
      requestId,
      traceId,
      source: options.source ?? "api",
      ...(userAgent ? { userAgent } : {}),
    },
    ...(options.eventSink ? { events: options.eventSink } : {}),
  };
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const firstValue = value?.find((item) => item.trim().length > 0);
  return firstValue?.trim();
}
