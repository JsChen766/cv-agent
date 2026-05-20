import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError, ErrorCodes } from "../errors.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import type { CopilotOrchestrator } from "../../copilot/CopilotOrchestrator.js";

export async function registerPendingActionRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
  getOrchestrator: () => CopilotOrchestrator,
): Promise<void> {
  app.get("/copilot/pending-actions", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const sessionId = typeof request.query === "object" && request.query && "sessionId" in request.query
      ? String((request.query as { sessionId?: unknown }).sessionId ?? "")
      : undefined;
    return success(getOrchestrator().pendingActions.list(ctx.user.id, sessionId || undefined), {
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
      mode: kernel.mode,
    });
  });

  app.get("/copilot/pending-actions/:id", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const id = readId(request.params);
    const action = getOrchestrator().pendingActions.get(ctx.user.id, id);
    if (!action) throw new ApiError(ErrorCodes.NOT_FOUND, "Pending action not found.", 404);
    return success(action, { requestId: ctx.request.requestId, traceId: ctx.request.traceId, mode: kernel.mode });
  });

  app.post("/copilot/pending-actions/:id/confirm", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const response = await getOrchestrator().runtimeConfirm(ctx, readId(request.params));
    return success(response, { requestId: ctx.request.requestId, traceId: ctx.request.traceId, mode: kernel.mode });
  });

  app.post("/copilot/pending-actions/:id/cancel", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const action = getOrchestrator().pendingActions.cancel(ctx.user.id, readId(request.params));
    return success(action, { requestId: ctx.request.requestId, traceId: ctx.request.traceId, mode: kernel.mode });
  });
}

function readId(params: unknown): string {
  if (typeof params !== "object" || params === null || !("id" in params) || typeof (params as { id: unknown }).id !== "string") {
    throw new ApiError(ErrorCodes.INVALID_BODY, "id is required.", 400);
  }
  return (params as { id: string }).id;
}
