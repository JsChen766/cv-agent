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
import { readPlatformConfig } from "../../platform/config.js";
import { isRecord, meta, optionalString, param, readHeader, readLimit, requireRecord, requiredString } from "./helpers.js";

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
    const ctx = createKernelRequestContext(request, { user: { id: readHeader(request.headers["x-user-id"]) ?? "dev-anon", roles: [] }, auth: { mode: "dev_header" } });
    await applyRateLimit(kernel, ctx, request);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
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
      const secure = request.protocol === "https" ? "; Secure" : "";
      reply.header("set-cookie", `${readSessionCookieName()}=${encodeURIComponent(token)}; HttpOnly;${secure}; Path=/; SameSite=Lax; Max-Age=${readPlatformConfig().sessionTtlDays * 86400}`);
      return success({ user }, meta(kernel, ctx));
    });
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

function assertDevLoginAllowed(): void {
  const config = readPlatformConfig();
  if (process.env.NODE_ENV === "production" && !config.allowDevHeaderAuth) {
    throw new ApiError(ErrorCodes.FORBIDDEN, "Dev login is disabled in production.", 403);
  }
}

function readProvider(value: unknown): UserApiKeyProvider {
  if (value === "deepseek" || value === "openai" || value === "compatible") return value;
  throw new ApiError(ErrorCodes.INVALID_BODY, "provider must be deepseek, openai, or compatible.", 400);
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
