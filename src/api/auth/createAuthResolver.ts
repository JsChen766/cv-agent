import type { FastifyRequest } from "fastify";
import type { AuthService } from "../../auth/index.js";
import { readPlatformConfig } from "../../platform/config.js";
import { BearerStaticAuthResolver } from "./BearerStaticAuthResolver.js";
import { DevHeaderAuthResolver } from "./DevHeaderAuthResolver.js";
import { DisabledAuthResolver } from "./DisabledAuthResolver.js";
import { StubCookieSessionAuthResolver } from "./StubCookieSessionAuthResolver.js";
import type { AuthResolver } from "./types.js";

export function createAuthResolver(authService?: AuthService): AuthResolver<FastifyRequest> {
  const config = readPlatformConfig();
  const authMode = config.authMode;

  if (authMode === "dev_header") {
    if (process.env.NODE_ENV === "production" && !config.allowDevHeaderAuth) {
      throw new Error("AUTH_MODE=dev_header is disabled in production unless ALLOW_DEV_HEADER_AUTH=true.");
    }
    return new DevHeaderAuthResolver();
  }
  if (authMode === "disabled") {
    if (process.env.NODE_ENV !== "test" && !config.allowInsecureAuth) {
      throw new Error("AUTH_MODE=disabled is only allowed in tests or when ALLOW_INSECURE_AUTH=true.");
    }
    return new DisabledAuthResolver();
  }
  if (authMode === "bearer_static") {
    const token = config.authStaticBearerToken;
    const userId = config.authStaticUserId;
    if (!token || !userId) {
      throw new Error("AUTH_STATIC_BEARER_TOKEN and AUTH_STATIC_USER_ID are required when AUTH_MODE=bearer_static.");
    }
    return new BearerStaticAuthResolver(token, userId);
  }
  if (authMode === "cookie_session") {
    return new StubCookieSessionAuthResolver(authService);
  }
  if (authMode === "bearer_token") {
    throw new Error("AUTH_MODE bearer_token is reserved but not implemented yet.");
  }
  if (authMode === "service") {
    throw new Error("AUTH_MODE service is reserved but not implemented yet.");
  }
  throw new Error(`Unknown AUTH_MODE "${authMode}". Supported values are dev_header, disabled, bearer_static, and cookie_session.`);
}
