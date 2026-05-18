import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError, ErrorCodes } from "../errors.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import { withIdempotency } from "../idempotency.js";
import { applyRateLimit } from "../rateLimit.js";
import { CopilotOrchestrator } from "../../copilot/CopilotOrchestrator.js";
import type { CopilotActionRequest, CopilotChatRequest } from "../../copilot/types.js";
import { isRecord, readHeader } from "./helpers.js";

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

    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const response = await orchestrator.handleChat(ctx, body);

      return success(response, {
        requestId: ctx.request.requestId,
        traceId: ctx.request.traceId,
        mode: kernel.mode,
        ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
      });
    });
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

    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const response = await orchestrator.handleAction(ctx, body);

      return success(response, {
        requestId: ctx.request.requestId,
        traceId: ctx.request.traceId,
        mode: kernel.mode,
      });
    });
  });

  app.post("/copilot/chat/stream", async (request, reply) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    await applyRateLimit(kernel, ctx, request);
    if (readHeader(request.headers["idempotency-key"])) {
      throw new ApiError(ErrorCodes.INVALID_BODY, "SSE stream does not support idempotent replay.", 400);
    }
    const body = parseCopilotChatBody(request.body);

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": readHeader(request.headers["origin"]) ?? "*",
    });

    const sse = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    await orchestrator.handleStream(ctx, body, sse);

    reply.raw.end();
  });
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
    clientState: isRecord(body.clientState) ? body.clientState as Record<string, unknown> : undefined,
  };
}
