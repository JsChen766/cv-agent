import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.js";
import {
  DevHeaderAuthResolver,
  StubCookieSessionAuthResolver,
  createAuthResolver,
} from "../src/api/auth/index.js";

describe("AuthResolver", () => {
  const originalAuthMode = process.env.AUTH_MODE;

  afterEach(() => {
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
  });

  it("resolves x-user-id in dev header mode", async () => {
    const resolver = new DevHeaderAuthResolver();
    const result = await resolver.resolve({
      headers: {
        "x-user-id": "user-1",
      },
    } as unknown as FastifyRequest);

    expect(result).toEqual({
      user: {
        id: "user-1",
        roles: ["user"],
      },
      auth: {
        mode: "dev_header",
      },
    });
  });

  it("throws MISSING_AUTH when x-user-id is absent", async () => {
    const resolver = new DevHeaderAuthResolver();

    await expect(resolver.resolve({ headers: {} } as unknown as FastifyRequest))
      .rejects
      .toMatchObject({
        code: "MISSING_AUTH",
        statusCode: 401,
      } satisfies Partial<ApiError>);
  });

  it("keeps cookie session auth as an explicit stub", async () => {
    const resolver = new StubCookieSessionAuthResolver();

    await expect(resolver.resolve({ headers: {} } as unknown as FastifyRequest))
      .rejects
      .toMatchObject({
        code: "INVALID_AUTH",
        statusCode: 501,
      } satisfies Partial<ApiError>);
  });

  it("creates resolver from AUTH_MODE", () => {
    process.env.AUTH_MODE = "cookie_session";
    expect(createAuthResolver()).toBeInstanceOf(StubCookieSessionAuthResolver);

    process.env.AUTH_MODE = "dev_header";
    expect(createAuthResolver()).toBeInstanceOf(DevHeaderAuthResolver);
  });
});
