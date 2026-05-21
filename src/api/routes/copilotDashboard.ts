import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError } from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import { applyRateLimit } from "../rateLimit.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import type { CopilotMessage, CopilotTurn, CopilotWorkspace } from "../../copilot/types.js";
import {
  normalizeCopilotMessage,
  normalizeCopilotTurn,
  normalizeCopilotWorkspace,
} from "../../copilot/normalize.js";

export async function registerCopilotDashboardRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  const contextFor = async (request: FastifyRequest) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    await applyRateLimit(kernel, ctx, request);
    return ctx;
  };

  app.get("/copilot/sessions", async (request) => {
    const ctx = await contextFor(request);
    const sessions = await kernel.copilotServices.sessionService.listSessions(ctx.user.id, {
      limit: readLimit(request.query) ?? 30,
      status: "active",
    });
    return routeSuccess(sessions, kernel, ctx);
  });

  app.get("/copilot/sessions/:id", async (request) => {
    const ctx = await contextFor(request);
    const id = param(request, "id");
    const session = await kernel.copilotServices.sessionService.getSession(ctx.user.id, id);
    if (!session) throw new ApiError("NOT_FOUND", "Session not found.", 404);

    const detailWarnings: Array<{ source: string; message: string }> = [];

    let messages: CopilotMessage[] = [];
    try {
      const raw = await kernel.copilotServices.sessionService.listMessages(ctx.user.id, id);
      messages = raw.map(normalizeCopilotMessage);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load messages.";
      detailWarnings.push({ source: "messages", message });
      console.error("[copilotDashboard] messages load failed", {
        source: "messages",
        sessionId: id,
        userId: ctx.user.id,
        error: message,
      });
    }

    let workspace: CopilotWorkspace | null = null;
    try {
      const raw = await kernel.copilotServices.workspaceService.getWorkspace(ctx.user.id, id);
      workspace = normalizeCopilotWorkspace(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load workspace.";
      detailWarnings.push({ source: "workspace", message });
      console.error("[copilotDashboard] workspace load failed", {
        source: "workspace",
        sessionId: id,
        userId: ctx.user.id,
        error: message,
      });
    }

    let turns: CopilotTurn[] = [];
    try {
      const raw = await kernel.copilotServices.sessionService.listTurns(ctx.user.id, id);
      turns = raw.map(normalizeCopilotTurn);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load turns.";
      detailWarnings.push({ source: "turns", message });
      console.error("[copilotDashboard] turns load failed", {
        source: "turns",
        sessionId: id,
        userId: ctx.user.id,
        error: message,
      });
    }

    const data: Record<string, unknown> = { session, messages, workspace, turns };
    if (detailWarnings.length > 0) {
      data.detailWarnings = detailWarnings;
    }

    return routeSuccess(data, kernel, ctx);
  });

  app.patch("/copilot/sessions/:id", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const status = readStatus(body.status);
      const updated = await kernel.copilotServices.sessionService.updateSession(ctx.user.id, param(request, "id"), {
        title: optionalString(body.title),
        ...(status ? { status } : {}),
      });
      if (!updated) throw new ApiError("NOT_FOUND", "Session not found.", 404);
      return routeSuccess(updated, kernel, ctx);
    });
  });

  app.get("/copilot/sidebar", async (request) => {
    const ctx = await contextFor(request);
    return routeSuccess(await kernel.copilotServices.workspaceService.getSidebar(ctx.user.id), kernel, ctx);
  });
}

function routeSuccess(data: unknown, kernel: ApiKernel, ctx: ReturnType<typeof createKernelRequestContext>) {
  return success(data, {
    requestId: ctx.request.requestId,
    traceId: ctx.request.traceId,
    mode: kernel.mode,
    ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
  });
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError("INVALID_BODY", "Request body must be a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readStatus(value: unknown): "active" | "archived" | "deleted" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "active" || value === "archived" || value === "deleted") return value;
  throw new ApiError("INVALID_BODY", "status must be active, archived, or deleted.", 400);
}

function param(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, unknown>;
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("INVALID_BODY", `${name} is required.`, 400);
  }
  return value;
}

function readLimit(query: unknown): number | undefined {
  if (typeof query !== "object" || query === null) return undefined;
  const value = (query as Record<string, unknown>).limit;
  const parsed = typeof value === "string" ? Number(value) : undefined;
  return Number.isFinite(parsed) ? parsed : undefined;
}
