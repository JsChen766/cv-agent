import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError } from "../errors.js";
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
    const body = parseGenerateBody(request.body);
    startNdjson(reply, request);

    const sink = new NdjsonAgentEventSink((event) => {
      reply.raw.write(`${JSON.stringify({ event })}\n`);
    });
    const ctx = createKernelRequestContext(request, resolvedAuth, {
      eventSink: sink,
    });

    try {
      const result = await kernel.cvAgentKernel.generations.create(ctx, {
        jdText: body.jdText,
        targetRole: body.targetRole,
      });
      reply.raw.write(`${JSON.stringify({ final: result })}\n`);
    } catch (error) {
      sink.emit({
        type: "kernel.failed",
        status: "failed",
        requestId: ctx.request.requestId,
        traceId: ctx.request.traceId,
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
  }
  reply.raw.writeHead(200, headers);
}

function resolveDevCorsOrigin(request: FastifyRequest): string | null {
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && process.env.ENABLE_DEV_CORS !== "true") return null;

  const origin = readHeader(request.headers["origin"]);
  if (!origin) return null;

  const allowedOrigins = process.env.DEV_CORS_ORIGIN
    ? process.env.DEV_CORS_ORIGIN.split(",").map((s) => s.trim())
    : ["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:5500", "http://localhost:5500", "null"];

  return allowedOrigins.includes(origin) ? origin : null;
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const firstValue = value?.find((item) => item.trim().length > 0);
  return firstValue?.trim();
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
