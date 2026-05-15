export type KernelRequestSource =
  | "web"
  | "mini_program"
  | "api"
  | "cli"
  | "test";

export type KernelAuthMode =
  | "dev_header"
  | "cookie_session"
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

export type KernelRequestContextOverrides = {
  user?: Partial<KernelRequestContext["user"]>;
  auth?: Partial<KernelRequestContext["auth"]>;
  request?: Partial<KernelRequestContext["request"]>;
  tenant?: KernelRequestContext["tenant"];
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
  };
}
