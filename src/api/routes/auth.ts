import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError, ErrorCodes } from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import { applyRateLimit } from "../rateLimit.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import { readSessionCookieName } from "../../auth/index.js";
import type { UserApiKeyProvider } from "../../auth/types.js";

export async function registerAuthRoutes(app: FastifyInstance, kernel: ApiKernel, authResolver: AuthResolver<FastifyRequest>): Promise<void> {
  app.get("/auth/me", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    await applyRateLimit(kernel, ctx, request);
    const user = await kernel.authService.getUserById(ctx.user.id);
    if (!user) throw new ApiError(ErrorCodes.NOT_FOUND, "User not found.", 404);
    return success({ user }, meta(kernel, ctx));
  });

  app.post("/auth/dev-login", async (request, reply) => {
    assertDevLoginAllowed();
    const body = isRecord(request.body) ? request.body : {};
    const user = await kernel.authService.createUser({
      email: typeof body.email === "string" ? body.email : "dev@example.com",
      displayName: typeof body.displayName === "string" ? body.displayName : "Dev User",
      authProvider: "dev",
    });
    const { token } = await kernel.authService.createSession({
      userId: user.id,
      userAgent: readHeader(request.headers["user-agent"]),
      ip: request.ip,
    });
    reply.header("set-cookie", `${readSessionCookieName()}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`);
    return success({ user }, { requestId: "dev-login", traceId: "dev-login", mode: kernel.mode });
  });

  app.post("/auth/logout", async (request) => {
    const token = readCookie(request.headers.cookie, readSessionCookieName());
    if (token) await kernel.authService.revokeSession(token);
    return success({ loggedOut: true }, { requestId: "logout", traceId: "logout", mode: kernel.mode });
  });

  app.get("/auth/api-keys", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    await applyRateLimit(kernel, ctx, request);
    return success(await kernel.authService.listUserApiKeys(ctx.user.id), meta(kernel, ctx));
  });

  app.post("/auth/api-keys", async (request, reply) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    await applyRateLimit(kernel, ctx, request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () =>
      success(await kernel.authService.createUserApiKey(ctx.user.id, {
        provider: readProvider(body.provider),
        label: requiredString(body.label, "label"),
        apiKey: requiredString(body.apiKey, "apiKey"),
        baseUrl: optionalString(body.baseUrl),
        model: optionalString(body.model),
      }), meta(kernel, ctx)));
  });

  app.delete("/auth/api-keys/:id", async (request, reply) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    await applyRateLimit(kernel, ctx, request);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const key = await kernel.authService.disableUserApiKey(ctx.user.id, param(request, "id"));
      if (!key) throw new ApiError(ErrorCodes.NOT_FOUND, "API key not found.", 404);
      return success(key, meta(kernel, ctx));
    });
  });
}

function meta(kernel: ApiKernel, ctx: ReturnType<typeof createKernelRequestContext>) {
  return { requestId: ctx.request.requestId, traceId: ctx.request.traceId, mode: kernel.mode };
}

function assertDevLoginAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(ErrorCodes.FORBIDDEN, "Dev login is disabled in production.", 403);
  }
}

function readProvider(value: unknown): UserApiKeyProvider {
  if (value === "deepseek" || value === "openai" || value === "compatible") return value;
  throw new ApiError(ErrorCodes.INVALID_BODY, "provider must be deepseek, openai, or compatible.", 400);
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  return requiredString(value, name);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ApiError(ErrorCodes.INVALID_BODY, "Request body must be a JSON object.", 400);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(ErrorCodes.INVALID_BODY, `${name} is required.`, 400);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  return value?.find((item) => item.trim().length > 0)?.trim();
}

function readCookie(cookieHeader: string | string[] | undefined, name: string): string | undefined {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}
