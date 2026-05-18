import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { ApiKernel, GenerateJsonBody } from "../types.js";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { withIdempotency } from "../idempotency.js";
import { applyRateLimit } from "../rateLimit.js";
import { success } from "../response.js";
import {
  validateEvidenceChain,
  validateGeneratedArtifact,
} from "../../knowledge/schemas/index.js";
import type {
  ReviseArtifactInput,
} from "../../kernel/types.js";
import type {
  RevisionInstruction,
  RevisionTone,
  UserConfirmation,
} from "../../application/revision/index.js";
import type { ArtifactCritiqueItem } from "../../application/critique/types.js";

export async function registerGenerationRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  app.post("/generations", async (request, reply) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    await applyRateLimit(kernel, ctx, request);
    const body = parseGenerateBody(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const result = await kernel.cvAgentKernel.generations.create(ctx, {
        jdText: body.jdText,
        targetRole: body.targetRole,
      });

      return success(result, {
        requestId: ctx.request.requestId,
        traceId: ctx.request.traceId,
        mode: kernel.mode,
        ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
      });
    });
  });

  app.post("/generations/artifacts/revise", async (request, reply) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    await applyRateLimit(kernel, ctx, request);
    const body = parseReviseArtifactBody(request.body);
    if (body.artifact.userId !== ctx.user.id) {
      throw new ApiError("FORBIDDEN", "Cannot revise an artifact that belongs to another user.", 403);
    }
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const result = await kernel.cvAgentKernel.generations.reviseArtifact(ctx, body);

      return success(result, {
        requestId: ctx.request.requestId,
        traceId: ctx.request.traceId,
        mode: kernel.mode,
        ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
      });
    });
  });
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

function parseReviseArtifactBody(body: unknown): ReviseArtifactInput {
  if (!isRecord(body)) {
    throw new ApiError("INVALID_REVISION_REQUEST", "Request body must be a JSON object.", 400);
  }
  const artifact = validateGeneratedArtifact(body.artifact);
  if (!isRevisionInstruction(body.instruction)) {
    throw new ApiError("INVALID_REVISION_REQUEST", "instruction is required and must be a supported revision instruction.", 400);
  }
  return {
    artifact,
    instruction: body.instruction,
    ...(isRecord(body.critiqueItem)
      ? { critiqueItem: body.critiqueItem as ArtifactCritiqueItem }
      : {}),
    ...(isRecord(body.evidenceChain)
      ? { evidenceChain: validateEvidenceChain(body.evidenceChain) }
      : {}),
    ...(typeof body.customInstruction === "string"
      ? { customInstruction: body.customInstruction }
      : {}),
    ...(Array.isArray(body.targetRequirementIds)
      ? { targetRequirementIds: body.targetRequirementIds.filter((item): item is string => typeof item === "string") }
      : {}),
    ...(Array.isArray(body.userConfirmations)
      ? { userConfirmations: parseUserConfirmations(body.userConfirmations) }
      : {}),
    ...(isRevisionTone(body.tone) ? { tone: body.tone } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRevisionInstruction(value: unknown): value is RevisionInstruction {
  return value === "make_more_conservative" ||
    value === "remove_unsupported_claims" ||
    value === "apply_user_confirmation" ||
    value === "make_more_quantified" ||
    value === "align_to_requirement" ||
    value === "rewrite_for_tone" ||
    value === "custom";
}

function isRevisionTone(value: unknown): value is RevisionTone {
  return value === "professional" ||
    value === "concise" ||
    value === "impactful" ||
    value === "conservative" ||
    value === "technical";
}

function parseUserConfirmations(values: unknown[]): UserConfirmation[] {
  return values.flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }
    return [{
      ...(typeof value.claimText === "string" ? { claimText: value.claimText } : {}),
      ...(typeof value.metric === "string" ? { metric: value.metric } : {}),
      ...(typeof value.value === "string" ? { value: value.value } : {}),
      ...(typeof value.explanation === "string" ? { explanation: value.explanation } : {}),
    }];
  });
}
