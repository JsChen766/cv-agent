import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { ResolvedAuth } from "./auth/index.js";

export type KernelRequestSource =
  | "web"
  | "mini_program"
  | "api"
  | "cli"
  | "test";

export type KernelAuthMode =
  | "dev_header"
  | "disabled"
  | "cookie_session"
  | "bearer_static"
  | "bearer_token"
  | "service";

export type KernelRequestContext = {
  user: {
    id: string;
    email?: string;
    displayName?: string;
    roles?: string[];
  };
  auth: {
    mode: KernelAuthMode;
    sessionId?: string;
    tokenId?: string;
  };
  request: {
    requestId: string;
    traceId: string;
    source: KernelRequestSource;
    userAgent?: string;
    ipHash?: string;
  };
  tenant?: {
    id?: string;
  };
};

export function createKernelRequestContext(
  request: FastifyRequest,
  resolvedAuth: ResolvedAuth,
  options: {
    source?: KernelRequestSource;
    requestId?: string;
    traceId?: string;
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
  };
}

export type KernelRequestContextOverrides = {
  user?: Partial<KernelRequestContext["user"]>;
  auth?: Partial<KernelRequestContext["auth"]>;
  request?: Partial<KernelRequestContext["request"]>;
  tenant?: KernelRequestContext["tenant"];
};

export function createTestKernelContext(overrides: KernelRequestContextOverrides = {}): KernelRequestContext {
  return {
    user: { id: "test-user", roles: ["user"], ...overrides.user },
    auth: { mode: "dev_header", ...overrides.auth },
    request: { requestId: "req-test", traceId: "trace-test", source: "test", ...overrides.request },
    ...(overrides.tenant ? { tenant: overrides.tenant } : {}),
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
