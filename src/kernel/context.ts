import type { AgentEventSink } from "./events/index.js";

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
  events?: AgentEventSink;
};

export type KernelRequestContextOverrides = {
  user?: Partial<KernelRequestContext["user"]>;
  auth?: Partial<KernelRequestContext["auth"]>;
  request?: Partial<KernelRequestContext["request"]>;
  tenant?: KernelRequestContext["tenant"];
  events?: AgentEventSink;
};

export function createTestKernelContext(
  overrides: KernelRequestContextOverrides = {},
): KernelRequestContext {
  return {
    user: {
      id: "test-user",
      roles: ["user"],
      ...overrides.user,
    },
    auth: {
      mode: "dev_header",
      ...overrides.auth,
    },
    request: {
      requestId: "req-test",
      traceId: "trace-test",
      source: "test",
      ...overrides.request,
    },
    ...(overrides.tenant ? { tenant: overrides.tenant } : {}),
    ...(overrides.events ? { events: overrides.events } : {}),
  };
}
