import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { resolveDevCorsOrigin } from "../cors.js";
import { ApiError, ErrorCodes } from "../errors.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import { withIdempotency } from "../idempotency.js";
import { withSessionLock } from "../sessionLock.js";
import { applyRateLimit } from "../rateLimit.js";
import { CopilotOrchestrator } from "../../copilot/CopilotOrchestrator.js";
import type { CopilotActionRequest, CopilotChatRequest } from "../../copilot/types.js";
import { isRecord, readHeader } from "./helpers.js";
import { registerPendingActionRoutes } from "./pendingActions.js";

// Module-level orchestrator — scoped to the kernel instance
let orchestrator: CopilotOrchestrator;

export async function registerCopilotRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  orchestrator = new CopilotOrchestrator({ kernel });

  app.post("/copilot/chat", async (request, reply) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    await applyRateLimit(kernel, ctx, request);
    const body = parseCopilotChatBody(request.body);

    return withIdempotency(request, reply, kernel, ctx.user.id, async () => withSessionLock(kernel, ctx, body.sessionId, async () => {
      const response = await orchestrator.handleChat(ctx, body);

      return success(response, {
        requestId: ctx.request.requestId,
        traceId: ctx.request.traceId,
        mode: kernel.mode,
        ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
      });
    }));
  });

  app.post("/copilot/actions", async (request, reply) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    await applyRateLimit(kernel, ctx, request);
    const body = parseCopilotActionBody(request.body);

    const session = await orchestrator.getSession(ctx.user.id, body.sessionId);
    if (!session) {
      throw new ApiError(ErrorCodes.NOT_FOUND, "Session not found.", 404);
    }

    return withIdempotency(request, reply, kernel, ctx.user.id, async () => withSessionLock(kernel, ctx, body.sessionId, async () => {
      const response = await orchestrator.handleAction(ctx, body);

      return success(response, {
        requestId: ctx.request.requestId,
        traceId: ctx.request.traceId,
        mode: kernel.mode,
      });
    }));
  });

  app.post("/copilot/chat/stream", async (request, reply) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    await applyRateLimit(kernel, ctx, request);
    if (readHeader(request.headers["idempotency-key"])) {
      throw new ApiError(ErrorCodes.INVALID_BODY, "SSE stream does not support idempotent replay.", 400);
    }
    const body = parseCopilotChatBody(request.body);
    const corsOrigin = resolveDevCorsOrigin(request);
    const headers: Record<string, string> = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    };
    if (corsOrigin !== null) {
      headers["access-control-allow-origin"] = corsOrigin;
      headers["access-control-allow-credentials"] = "true";
    }

    reply.hijack();
    reply.raw.writeHead(200, headers);
    const rawSocket = reply.raw as unknown as { flushHeaders?: () => void; flush?: () => void };
    if (typeof rawSocket.flushHeaders === "function") {
      rawSocket.flushHeaders();
    }

    const sse = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof rawSocket.flush === "function") {
        rawSocket.flush();
      }
    };

    try {
      await orchestrator.handleStream(ctx, body, sse);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Stream failed.";
      sse("agent.failed", {
        type: "agent.failed",
        sessionId: body.sessionId ?? "",
        turnId: "",
        createdAt: new Date().toISOString(),
        label: "处理失败",
        status: "failed",
        message: errorMessage,
        payload: { message: errorMessage },
      });
    } finally {
      reply.raw.end();
    }
  });

  await registerPendingActionRoutes(app, kernel, authResolver, () => orchestrator);
}

function parseCopilotChatBody(body: unknown): CopilotChatRequest {
  if (!isRecord(body)) {
    throw new ApiError(ErrorCodes.INVALID_BODY, "Request body must be a JSON object.", 400);
  }
  if (typeof body.message !== "string" || !body.message.trim()) {
    throw new ApiError(ErrorCodes.INVALID_BODY, "message is required.", 400);
  }
  return {
    sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    message: body.message,
    resumeText: typeof body.resumeText === "string" ? body.resumeText : undefined,
    jdText: typeof body.jdText === "string" ? body.jdText : undefined,
    targetRole: typeof body.targetRole === "string" ? body.targetRole : undefined,
    clientState: isRecord(body.clientState) ? body.clientState as CopilotChatRequest["clientState"] : undefined,
  };
}

function parseCopilotActionBody(body: unknown): CopilotActionRequest {
  if (!isRecord(body)) {
    throw new ApiError(ErrorCodes.INVALID_BODY, "Request body must be a JSON object.", 400);
  }
  if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
    throw new ApiError(ErrorCodes.INVALID_BODY, "sessionId is required.", 400);
  }
  if (!isRecord(body.action) || typeof body.action.type !== "string") {
    throw new ApiError(ErrorCodes.INVALID_BODY, "action with type is required.", 400);
  }
  return {
    sessionId: body.sessionId,
    turnId: typeof body.turnId === "string" ? body.turnId : undefined,
    action: {
      type: body.action.type as CopilotActionRequest["action"]["type"],
      variantId: typeof body.action.variantId === "string" ? body.action.variantId : undefined,
      payload: isRecord(body.action.payload) ? body.action.payload as Record<string, unknown> : undefined,
    },
    clientState: isRecord(body.clientState) ? body.clientState as CopilotActionRequest["clientState"] : undefined,
  };
}
