import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { createKernelRequestContext } from "../src/api/context.js";
import { createTestKernelContext } from "../src/kernel/index.js";

describe("KernelRequestContext", () => {
  it("creates a test context with nested overrides", () => {
    const ctx = createTestKernelContext({
      user: {
        id: "user-1",
        email: "user@example.com",
      },
      request: {
        requestId: "req-1",
      },
    });

    expect(ctx.user.id).toBe("user-1");
    expect(ctx.user.email).toBe("user@example.com");
    expect(ctx.user.roles).toEqual(["user"]);
    expect(ctx.request.requestId).toBe("req-1");
    expect(ctx.request.source).toBe("test");
  });

  it("builds kernel context from Fastify request headers and resolved auth", () => {
    const request = {
      headers: {
        "x-request-id": "req-123",
        "x-trace-id": "trace-123",
        "user-agent": "vitest",
      },
    } as unknown as FastifyRequest;

    const ctx = createKernelRequestContext(request, {
      user: {
        id: "user-1",
        roles: ["user"],
      },
      auth: {
        mode: "dev_header",
      },
    });

    expect(ctx.user.id).toBe("user-1");
    expect(ctx.auth.mode).toBe("dev_header");
    expect(ctx.request.requestId).toBe("req-123");
    expect(ctx.request.traceId).toBe("trace-123");
    expect(ctx.request.source).toBe("api");
    expect(ctx.request.userAgent).toBe("vitest");
  });
});
