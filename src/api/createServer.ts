import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import fastifyCors from "@fastify/cors";
import type { ApiKernel } from "./types.js";
import type { AuthResolver } from "./auth/index.js";
import { createAuthResolver } from "./auth/index.js";
import { isAllowedDevCorsOrigin, isDevCorsEnabled } from "./cors.js";
import { readHeader } from "./routes/helpers.js";
import { errorResponse } from "./errors/index.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAgentDebugRoutes } from "./routes/agentDebug.js";
import { registerCopilotRoutes } from "./routes/copilot.js";
import { registerCopilotDashboardRoutes } from "./routes/copilotDashboard.js";
import { registerExportRoutes } from "./routes/exports.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerProductRoutes } from "./routes/product.js";

export type CreateServerOptions = {
  authResolver?: AuthResolver<FastifyRequest>;
};

export async function createServer(kernel: ApiKernel, options: CreateServerOptions = {}) {
  const app = Fastify({ logger: false });
  const authResolver = options.authResolver ?? {
    resolve: (request: FastifyRequest) => createAuthResolver(kernel.authService).resolve(request),
  };

  await registerDevCors(app);

  app.setErrorHandler((error, request, reply) => {
    const requestId = readHeader(request.headers["x-request-id"]) ?? `req-${randomUUID()}`;
    if (error instanceof Error && !/NOT_FOUND|INVALID_BODY|FORBIDDEN|RATE_LIMIT/i.test(error.message)) {
      console.error("[setErrorHandler] Unexpected error:", error instanceof Error ? { message: error.message, stack: error.stack } : error);
    }
    const mapped = errorResponse(error, {
      requestId,
      traceId: readHeader(request.headers["x-trace-id"]) ?? requestId,
      mode: kernel.mode,
      ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
    });
    reply.status(mapped.statusCode).send(mapped.body);
  });

  await registerHealthRoutes(app, kernel);
  await registerAuthRoutes(app, kernel, authResolver);
  await registerAgentDebugRoutes(app, kernel, authResolver);
  await registerProductRoutes(app, kernel, authResolver);
  await registerCopilotDashboardRoutes(app, kernel, authResolver);
  await registerCopilotRoutes(app, kernel, authResolver);
  await registerJobRoutes(app, kernel, authResolver);
  await registerFileRoutes(app, kernel, authResolver);
  await registerExportRoutes(app, kernel, authResolver);

  return app;
}

async function registerDevCors(app: ReturnType<typeof Fastify>): Promise<void> {
  if (!isDevCorsEnabled()) return;

  await app.register(fastifyCors, {
    origin: isAllowedDevCorsOrigin,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "cookie", "x-user-id", "x-request-id", "x-trace-id", "idempotency-key"],
    credentials: true,
  });
}
