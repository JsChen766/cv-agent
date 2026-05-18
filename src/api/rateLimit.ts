import type { FastifyRequest } from "fastify";
import type { KernelRequestContext } from "../kernel/context.js";
import type { ApiKernel } from "./types.js";

export async function applyRateLimit(
  kernel: ApiKernel,
  ctx: KernelRequestContext,
  request: FastifyRequest,
): Promise<void> {
  await kernel.platformServices.usage.checkRequest({
    userId: ctx.user.id,
    ip: request.ip,
  });
}
