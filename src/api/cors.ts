import type { FastifyRequest } from "fastify";
import { readHeader } from "./routes/helpers.js";

export function isDevCorsEnabled(): boolean {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_DEV_CORS !== "true") {
    return false;
  }
  return true;
}

export function isAllowedDevCorsOrigin(origin: string | undefined, callback: (error: Error | null, allowed: boolean) => void): void {
  callback(null, isAllowedCorsOrigin(origin));
}

export function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "null") return true;
  if (parseConfiguredCorsOrigins().includes(origin)) return true;

  try {
    const url = new URL(origin);
    const isLocalHost = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    return isLocalHost && (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

export function resolveDevCorsOrigin(request: FastifyRequest): string | null {
  if (!isDevCorsEnabled()) return null;

  const origin = readHeader(request.headers["origin"]);
  if (!origin) return null;
  return isAllowedCorsOrigin(origin) ? origin : null;
}

function parseConfiguredCorsOrigins(): string[] {
  return (process.env.DEV_CORS_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
