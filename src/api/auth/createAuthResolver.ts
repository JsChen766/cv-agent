import type { FastifyRequest } from "fastify";
import { DevHeaderAuthResolver } from "./DevHeaderAuthResolver.js";
import { StubCookieSessionAuthResolver } from "./StubCookieSessionAuthResolver.js";
import type { AuthMode, AuthResolver } from "./types.js";

export function createAuthResolver(): AuthResolver<FastifyRequest> {
  const authMode = readAuthMode();
  if (authMode === "dev_header") {
    return new DevHeaderAuthResolver();
  }
  if (authMode === "cookie_session") {
    return new StubCookieSessionAuthResolver();
  }
  throw new Error(`Unsupported AUTH_MODE "${authMode}". Supported values are dev_header and cookie_session.`);
}

function readAuthMode(): AuthMode {
  const configuredMode = process.env.AUTH_MODE;
  if (configuredMode === undefined || configuredMode.trim().length === 0) {
    return "dev_header";
  }
  if (isAuthMode(configuredMode)) {
    return configuredMode;
  }
  throw new Error(`Unknown AUTH_MODE "${configuredMode}". Supported values are dev_header and cookie_session.`);
}

function isAuthMode(value: string): value is AuthMode {
  return value === "dev_header" ||
    value === "cookie_session" ||
    value === "bearer_token" ||
    value === "service";
}
