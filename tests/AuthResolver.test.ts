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
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
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

  it("throws UNAUTHORIZED when x-user-id is absent", async () => {
    const resolver = new DevHeaderAuthResolver();

    await expect(resolver.resolve({ headers: {} } as unknown as FastifyRequest))
      .rejects
      .toMatchObject({
        code: "UNAUTHORIZED",
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

  it("defaults to dev header auth outside production", () => {
    delete process.env.AUTH_MODE;
    process.env.NODE_ENV = "test";

    expect(createAuthResolver()).toBeInstanceOf(DevHeaderAuthResolver);
  });

  it("requires AUTH_MODE in production", () => {
    delete process.env.AUTH_MODE;
    process.env.NODE_ENV = "production";

    expect(() => createAuthResolver()).toThrow(
      "AUTH_MODE must be set in production. Supported values are dev_header, bearer_static, and cookie_session.",
    );
  });

  it("creates resolver from implemented AUTH_MODE values", () => {
    process.env.AUTH_MODE = "cookie_session";
    expect(createAuthResolver()).toBeInstanceOf(StubCookieSessionAuthResolver);

    process.env.AUTH_MODE = "dev_header";
    expect(createAuthResolver()).toBeInstanceOf(DevHeaderAuthResolver);
  });

  it("rejects reserved auth modes", () => {
    process.env.AUTH_MODE = "bearer_token";
    expect(() => createAuthResolver()).toThrow("AUTH_MODE bearer_token is reserved but not implemented yet.");

    process.env.AUTH_MODE = "service";
    expect(() => createAuthResolver()).toThrow("AUTH_MODE service is reserved but not implemented yet.");
  });

  it("rejects unknown auth modes", () => {
    process.env.AUTH_MODE = "unknown";

    expect(() => createAuthResolver()).toThrow(
      'Unknown AUTH_MODE "unknown". Supported values are dev_header, disabled, bearer_static, and cookie_session.',
    );
  });
});
