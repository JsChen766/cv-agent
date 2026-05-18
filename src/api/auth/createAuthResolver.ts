import type { FastifyRequest } from "fastify";
import { BearerStaticAuthResolver } from "./BearerStaticAuthResolver.js";
import { DevHeaderAuthResolver } from "./DevHeaderAuthResolver.js";
import { DisabledAuthResolver } from "./DisabledAuthResolver.js";
import { StubCookieSessionAuthResolver } from "./StubCookieSessionAuthResolver.js";
import type { AuthMode, AuthResolver } from "./types.js";

export function createAuthResolver(): AuthResolver<FastifyRequest> {
  const authMode = readAuthMode();
  if (authMode === "dev_header") {
    return new DevHeaderAuthResolver();
  }
  if (authMode === "disabled") {
    if (process.env.NODE_ENV !== "test" && process.env.ALLOW_INSECURE_AUTH !== "true") {
      throw new Error("AUTH_MODE=disabled is only allowed in tests or when ALLOW_INSECURE_AUTH=true.");
    }
    return new DisabledAuthResolver();
  }
  if (authMode === "bearer_static") {
    const token = process.env.AUTH_STATIC_BEARER_TOKEN;
    const userId = process.env.AUTH_STATIC_USER_ID;
    if (!token || !userId) {
      throw new Error("AUTH_STATIC_BEARER_TOKEN and AUTH_STATIC_USER_ID are required when AUTH_MODE=bearer_static.");
    }
    return new BearerStaticAuthResolver(token, userId);
  }
  if (authMode === "cookie_session") {
    return new StubCookieSessionAuthResolver();
  }
  if (authMode === "bearer_token") {
    throw new Error("AUTH_MODE bearer_token is reserved but not implemented yet.");
  }
  if (authMode === "service") {
    throw new Error("AUTH_MODE service is reserved but not implemented yet.");
  }
  throw new Error(`Unknown AUTH_MODE "${authMode}". Supported values are dev_header, disabled, bearer_static, and cookie_session.`);
}

function readAuthMode(): AuthMode {
  const configuredMode = process.env.AUTH_MODE;
  if (configuredMode === undefined || configuredMode.trim().length === 0) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_MODE must be set in production. Supported values are dev_header, bearer_static, and cookie_session.");
    }
    return "dev_header";
  }
  if (isAuthMode(configuredMode)) {
    return configuredMode;
  }
  throw new Error(`Unknown AUTH_MODE "${configuredMode}". Supported values are dev_header, disabled, bearer_static, and cookie_session.`);
}

function isAuthMode(value: string): value is AuthMode {
  return value === "dev_header" ||
    value === "disabled" ||
    value === "cookie_session" ||
    value === "bearer_static" ||
    value === "bearer_token" ||
    value === "service";
}
