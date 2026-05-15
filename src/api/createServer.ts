import Fastify from "fastify";
import { errorResponse } from "./errors.js";
import type { ApiKernel } from "./types.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerEvidenceRoutes } from "./routes/evidence.js";
import { registerGenerationRoutes } from "./routes/generations.js";
import { registerHealthRoutes } from "./routes/health.js";

export async function createServer(kernel: ApiKernel) {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    const response = errorResponse(error);
    reply.status(response.statusCode).send(response.body);
  });

  await registerHealthRoutes(app, kernel);
  await registerDocumentRoutes(app, kernel);
  await registerGenerationRoutes(app, kernel);
  await registerEvidenceRoutes(app, kernel);

  return app;
}
