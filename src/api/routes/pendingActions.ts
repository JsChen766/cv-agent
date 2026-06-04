import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError, ErrorCodes } from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import { success } from "../response.js";
import { withSessionLock } from "../sessionLock.js";
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
    return success(await getOrchestrator().pendingActions.list(ctx.user.id, sessionId || undefined), {
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
      mode: kernel.mode,
    });
  });

  app.get("/copilot/pending-actions/:id", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const id = readId(request.params);
    const action = await getOrchestrator().pendingActions.get(ctx.user.id, id);
    if (!action) throw new ApiError(ErrorCodes.NOT_FOUND, "Pending action not found.", 404);
    return success(action, { requestId: ctx.request.requestId, traceId: ctx.request.traceId, mode: kernel.mode });
  });

  app.post("/copilot/pending-actions/:id/confirm", async (request, reply) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const pendingActionId = readId(request.params);
    const action = await getOrchestrator().pendingActions.get(ctx.user.id, pendingActionId);
    if (!action) throw new ApiError(ErrorCodes.NOT_FOUND, "Pending action not found.", 404);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => withSessionLock(kernel, ctx, action.sessionId, async () => {
      const response = await getOrchestrator().runtimeConfirm(ctx, pendingActionId);
      const isGenerating = response.raw.actionResults?.some((result) =>
        result.actionType === "generate_resume_from_jd"
        && result.metadata
        && (result.metadata as Record<string, unknown>).generating === true,
      );

      // Attach confirm metadata to the meta field so the frontend can
      // distinguish a completed confirmation from a new pending action
      // without changing the response body shape.
      return success(response, {
        requestId: ctx.request.requestId,
        traceId: ctx.request.traceId,
        mode: kernel.mode,
        confirmStatus: isGenerating ? "generating" as const : "completed" as const,
        pendingActionId,
      });
    }));
  });

  app.post("/copilot/pending-actions/:id/cancel", async (request, reply) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const pendingActionId = readId(request.params);
    const existing = await getOrchestrator().pendingActions.get(ctx.user.id, pendingActionId);
    if (!existing) throw new ApiError(ErrorCodes.NOT_FOUND, "Pending action not found.", 404);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => withSessionLock(kernel, ctx, existing.sessionId, async () => {
      const action = await getOrchestrator().cancelPendingAction(ctx.user.id, pendingActionId);
      return success(action, { requestId: ctx.request.requestId, traceId: ctx.request.traceId, mode: kernel.mode });
    }));
  });
}

function readId(params: unknown): string {
  if (typeof params !== "object" || params === null || !("id" in params) || typeof (params as { id: unknown }).id !== "string") {
    throw new ApiError(ErrorCodes.INVALID_BODY, "id is required.", 400);
  }
  return (params as { id: string }).id;
}
