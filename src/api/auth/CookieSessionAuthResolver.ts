import type { FastifyRequest } from "fastify";
import { ApiError, ErrorCodes } from "../errors.js";
import type { AuthService } from "../../auth/index.js";
import { readSessionCookieName } from "../../auth/index.js";
import type { AuthResolver, ResolvedAuth } from "./types.js";

/**
 * Cookie-based session authentication resolver.
 *
 * Reads the session cookie (name from SESSION_COOKIE_NAME env, default "coolto_session"),
 * validates it against the AuthService, and returns the authenticated user.
 *
 * Requires a configured AuthService (in-memory or Postgres) — the service is passed
 * through the kernel chain: createKernel → kernel.authService → createAuthResolver.
 *
 * Sessions are created by POST /auth/dev-login (sets the cookie on the response).
 * In production, replace dev-login with an OAuth or password-based login flow that
 * calls AuthService.createSession() and sets the same cookie.
 */
export class CookieSessionAuthResolver implements AuthResolver<FastifyRequest> {
  public constructor(private readonly authService?: AuthService) {}

  public async resolve(request: FastifyRequest): Promise<ResolvedAuth> {
    if (!this.authService) {
      throw new ApiError("INVALID_AUTH", "Cookie session auth service is not configured.", 501);
    }
    const token = readCookie(request.headers.cookie, readSessionCookieName());
    if (!token) {
      throw new ApiError(ErrorCodes.UNAUTHORIZED, "Session cookie is required.", 401);
    }
    const user = await this.authService.validateSessionToken(token);
    if (!user) {
      throw new ApiError(ErrorCodes.UNAUTHORIZED, "Invalid or expired session.", 401);
    }
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName, roles: ["user"] },
      auth: { mode: "cookie_session", sessionId: token.slice(0, 12) },
    };
  }
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
