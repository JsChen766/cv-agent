import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ApiKernel } from "../types.js";
import { success } from "../response.js";

export async function registerHealthRoutes(app: FastifyInstance, kernel: ApiKernel): Promise<void> {
  app.get("/health", async (request) => {
    const requestId = readHeader(request.headers["x-request-id"]) ?? `req-${randomUUID()}`;
    const traceId = readHeader(request.headers["x-trace-id"]) ?? requestId;
    return success(await kernel.cvAgentKernel.health(), {
      requestId,
      traceId,
      mode: kernel.mode,
      ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
    });
  });
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const firstValue = value?.find((item) => item.trim().length > 0);
  return firstValue?.trim();
}
