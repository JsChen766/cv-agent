import type { FastifyInstance } from "fastify";
import type { ApiKernel } from "../types.js";

export async function registerHealthRoutes(app: FastifyInstance, kernel: ApiKernel): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    mode: kernel.mode,
  }));
}
