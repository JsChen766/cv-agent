import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { resolveDevCorsOrigin } from "../cors.js";
import { ApiError } from "../errors.js";
import { applyRateLimit } from "../rateLimit.js";
import type { ApiKernel, GenerateJsonBody } from "../types.js";
import {
  createAgentEvent,
  type AgentEvent,
  type AgentEventSink,
} from "../../kernel/events/index.js";

export async function registerStreamingRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  app.post("/generations/stream", async (request, reply) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    await applyRateLimit(kernel, ctx, request);
    const body = parseGenerateBody(request.body);
    startNdjson(reply, request);

    const sink = new NdjsonAgentEventSink((event) => {
      reply.raw.write(`${JSON.stringify({ event })}\n`);
    });
    const streamCtx = createKernelRequestContext(request, resolvedAuth, { eventSink: sink });

    try {
      const result = await kernel.cvAgentKernel.generations.create(streamCtx, {
        jdText: body.jdText,
        targetRole: body.targetRole,
      });
      reply.raw.write(`${JSON.stringify({ final: result })}\n`);
    } catch (error) {
      sink.emit({
        type: "kernel.failed",
        status: "failed",
        requestId: streamCtx.request.requestId,
        traceId: streamCtx.request.traceId,
        step: "generations.stream",
        message: "Streaming generation failed.",
        data: { errorType: error instanceof Error ? error.name : "UnknownError" },
      });
      reply.raw.write(`${JSON.stringify({
        error: {
          code: "STREAM_FAILED",
          message: "Streaming generation failed.",
        },
      })}\n`);
    } finally {
      reply.raw.end();
    }
  });
}

class NdjsonAgentEventSink implements AgentEventSink {
  public constructor(private readonly writeEvent: (event: AgentEvent) => void) {}

  public emit(event: Omit<AgentEvent, "id" | "timestamp">): void {
    this.writeEvent(createAgentEvent(event));
  }
}

function startNdjson(reply: FastifyReply, request: FastifyRequest): void {
  reply.hijack();
  const headers: Record<string, string> = {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
  const corsOrigin = resolveDevCorsOrigin(request);
  if (corsOrigin !== null) {
    headers["access-control-allow-origin"] = corsOrigin;
    headers["access-control-allow-credentials"] = "true";
  }
  reply.raw.writeHead(200, headers);
}

function parseGenerateBody(body: unknown): GenerateJsonBody {
  if (!isRecord(body)) {
    throw new ApiError("INVALID_BODY", "Request body must be a JSON object.", 400);
  }
  if (typeof body.jdText !== "string" || !body.jdText.trim()) {
    throw new ApiError("INVALID_BODY", "jdText is required.", 400);
  }
  if (typeof body.targetRole !== "string" || !body.targetRole.trim()) {
    throw new ApiError("INVALID_BODY", "targetRole is required.", 400);
  }
  return {
    jdText: body.jdText,
    targetRole: body.targetRole,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
