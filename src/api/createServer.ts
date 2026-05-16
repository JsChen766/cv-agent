import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import type { ApiKernel } from "./types.js";
import type { AuthResolver } from "./auth/index.js";
import { createAuthResolver } from "./auth/index.js";
import { failure } from "./response.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerDecisionRoutes } from "./routes/decisions.js";
import { registerEvidenceRoutes } from "./routes/evidence.js";
import { registerGenerationRoutes } from "./routes/generations.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerStreamingRoutes } from "./routes/streaming.js";

export type CreateServerOptions = {
  authResolver?: AuthResolver<FastifyRequest>;
};

export async function createServer(kernel: ApiKernel, options: CreateServerOptions = {}) {
  const app = Fastify({ logger: false });
  const authResolver = options.authResolver ?? createAuthResolver();

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
  await registerDocumentRoutes(app, kernel, authResolver);
  await registerGenerationRoutes(app, kernel, authResolver);
  await registerStreamingRoutes(app, kernel, authResolver);
  await registerDecisionRoutes(app, kernel, authResolver);
  await registerEvidenceRoutes(app, kernel, authResolver);

  return app;
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const firstValue = value?.find((item) => item.trim().length > 0);
  return firstValue?.trim();
}
