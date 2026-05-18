import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import fastifyCors from "@fastify/cors";
import { ApiError } from "./errors.js";
import type { ApiKernel } from "./types.js";
import type { AuthResolver } from "./auth/index.js";
import { createAuthResolver } from "./auth/index.js";
import { failure } from "./response.js";
import { registerCopilotRoutes } from "./routes/copilot.js";
import { registerCopilotDashboardRoutes } from "./routes/copilotDashboard.js";
import { registerDebugRoutes } from "./routes/debug.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerDecisionRoutes } from "./routes/decisions.js";
import { registerEvidenceRoutes } from "./routes/evidence.js";
import { registerGenerationRoutes } from "./routes/generations.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProductRoutes } from "./routes/product.js";
import { registerStreamingRoutes } from "./routes/streaming.js";

export type CreateServerOptions = {
  authResolver?: AuthResolver<FastifyRequest>;
};

export async function createServer(kernel: ApiKernel, options: CreateServerOptions = {}) {
  const app = Fastify({ logger: false });
  const authResolver = options.authResolver ?? createAuthResolver();

  await registerDevCors(app);

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error instanceof ApiError ? error.statusCode : 500;
    const requestId = readHeader(request.headers["x-request-id"]) ?? `req-${randomUUID()}`;
    reply.status(statusCode).send(failure(error, {
      requestId,
      traceId: readHeader(request.headers["x-trace-id"]) ?? requestId,
      mode: kernel.mode,
      ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
    }));
  });

  await registerHealthRoutes(app, kernel);
  await registerDebugRoutes(app, kernel);
  await registerDocumentRoutes(app, kernel, authResolver);
  await registerGenerationRoutes(app, kernel, authResolver);
  await registerStreamingRoutes(app, kernel, authResolver);
  await registerDecisionRoutes(app, kernel, authResolver);
  await registerEvidenceRoutes(app, kernel, authResolver);
  await registerProductRoutes(app, kernel, authResolver);
  await registerCopilotDashboardRoutes(app, kernel, authResolver);
  await registerCopilotRoutes(app, kernel, authResolver);

  return app;
}

function isDevCorsEnabled(): boolean {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_DEV_CORS !== "true") {
    return false;
  }
  return true;
}

async function registerDevCors(app: ReturnType<typeof Fastify>): Promise<void> {
  if (!isDevCorsEnabled()) return;

  await app.register(fastifyCors, {
    origin: isAllowedDevCorsOrigin,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["content-type", "x-user-id", "x-request-id", "x-trace-id"],
    credentials: false,
  });
}

function isAllowedDevCorsOrigin(origin: string | undefined, callback: (error: Error | null, allowed: boolean) => void): void {
  callback(null, isAllowedOrigin(origin));
}

function isAllowedOrigin(origin: string | undefined): boolean {
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

function parseConfiguredCorsOrigins(): string[] {
  return (process.env.DEV_CORS_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const firstValue = value?.find((item) => item.trim().length > 0);
  return firstValue?.trim();
}
