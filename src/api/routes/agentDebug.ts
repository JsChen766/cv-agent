import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import { createAgentTools } from "../../agent-tools/index.js";

export async function registerAgentDebugRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  app.get("/copilot/agent-debug/tools", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    return success(createAgentTools().map((tool) => ({
      name: tool.name,
      ownerAgent: tool.ownerAgent,
      mutability: tool.mutability,
      requiresConfirmation: tool.requiresConfirmation,
      riskLevel: tool.riskLevel,
    })), {
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
      mode: kernel.mode,
    });
  });
}
