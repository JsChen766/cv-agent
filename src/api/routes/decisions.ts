import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError } from "../errors.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import type {
  RecordArtifactDecisionInput,
} from "../../kernel/index.js";
import type { ArtifactDecisionType } from "../../application/decisions/index.js";

export async function registerDecisionRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  app.post("/generations/artifacts/decisions", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const input = parseDecisionBody(request.body);
    const result = await kernel.cvAgentKernel.generations.recordArtifactDecision(ctx, input);

    return success(result, {
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
      mode: kernel.mode,
      ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
    });
  });

  app.get<{ Params: { artifactId: string } }>("/generations/artifacts/:artifactId/decisions", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const result = await kernel.cvAgentKernel.generations.listArtifactDecisions(ctx, {
      artifactId: request.params.artifactId,
    });

    return success(result, {
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
      mode: kernel.mode,
      ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
    });
  });

  app.get<{ Params: { sessionId: string } }>("/generations/:sessionId/artifact-decisions", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const result = await kernel.cvAgentKernel.generations.listArtifactDecisions(ctx, {
      sessionId: request.params.sessionId,
    });

    return success(result, {
      requestId: ctx.request.requestId,
      traceId: ctx.request.traceId,
      mode: kernel.mode,
      ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
    });
  });
}

function parseDecisionBody(body: unknown): RecordArtifactDecisionInput {
  if (!isRecord(body)) {
    throw new ApiError("INVALID_DECISION_REQUEST", "Request body must be a JSON object.", 400);
  }
  if (typeof body.artifactId !== "string" || !body.artifactId.trim()) {
    throw new ApiError("INVALID_DECISION_REQUEST", "artifactId is required.", 400);
  }
  if (!isArtifactDecisionType(body.decision)) {
    throw new ApiError("INVALID_DECISION_REQUEST", "decision is required and must be supported.", 400);
  }
  return {
    artifactId: body.artifactId,
    decision: body.decision,
    ...(typeof body.sessionId === "string" && body.sessionId.trim()
      ? { sessionId: body.sessionId }
      : {}),
    ...(typeof body.reason === "string" && body.reason.trim()
      ? { reason: body.reason }
      : {}),
    ...(typeof body.selectedVariantId === "string" && body.selectedVariantId.trim()
      ? { selectedVariantId: body.selectedVariantId }
      : {}),
    ...(isRecord(body.confirmation)
      ? { confirmation: parseConfirmation(body.confirmation) }
      : {}),
  };
}

function parseConfirmation(value: Record<string, unknown>): NonNullable<RecordArtifactDecisionInput["confirmation"]> {
  return {
    ...(typeof value.metric === "string" && value.metric.trim() ? { metric: value.metric } : {}),
    ...(typeof value.value === "string" && value.value.trim() ? { value: value.value } : {}),
    ...(typeof value.explanation === "string" && value.explanation.trim() ? { explanation: value.explanation } : {}),
  };
}

function isArtifactDecisionType(value: unknown): value is ArtifactDecisionType {
  return value === "accept" ||
    value === "reject" ||
    value === "request_revision" ||
    value === "confirm_metric" ||
    value === "mark_unsafe" ||
    value === "prefer_variant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
