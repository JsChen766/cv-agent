import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiKernel } from "../../types.js";
import type { AuthResolver } from "../../auth/index.js";
import { ApiError, ErrorCodes } from "../../errors.js";
import { GroundingContextCoordinator } from "../../../rag/GroundingContextCoordinator.js";
import {
  optionalString,
  productSuccess,
  requireRecord,
  type ProductRouteContextFn,
} from "./productRouteHelpers.js";

export function registerRagRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  contextFor: ProductRouteContextFn,
  _authResolver: AuthResolver<FastifyRequest>,
): void {
  app.post("/product/rag/preview", async (request) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    const jdId = optionalString(body.jdId);
    const jdTextInput = optionalString(body.jdText ?? body.rawText ?? body.text);
    const jd = jdId ? await kernel.productServices.jdService.getJD(ctx.user.id, jdId) : undefined;
    const jdText = jd?.rawText ?? jdTextInput;
    if (!jdText) throw new ApiError(ErrorCodes.INVALID_BODY, "jdText or jdId is required.", 400);
    const targetRole = optionalString(body.targetRole) ?? jd?.targetRole;
    const instructionPack = kernel.productServices.guidelineRAGService
      ? await kernel.productServices.guidelineRAGService.buildInstructionPack({
          userId: ctx.user.id,
          jdText,
          targetRole,
          limit: numericLimit(body.guidelineLimit, 14, 4, 30),
        })
      : undefined;
    const evidencePack = kernel.productServices.evidenceRAGService
      ? await kernel.productServices.evidenceRAGService.buildEvidencePack({
          userId: ctx.user.id,
          jdText,
          targetRole,
          roleFamily: instructionPack?.roleFamily,
          limit: numericLimit(body.evidenceLimit, 12, 3, 40),
        })
      : undefined;
    const groundingContext = new GroundingContextCoordinator().build({ instructionPack, evidencePack });
    return productSuccess({
      instructionPack,
      evidencePack,
      groundingContext,
      summary: {
        guidelineVersion: instructionPack?.version,
        evidenceVersion: evidencePack?.version,
        guidelineStatus: instructionPack?.quality?.status,
        evidenceQuality: evidencePack?.diagnostics?.retrievalEvaluation.overallQuality,
        allowedClaimCount: evidencePack?.allowedClaims.length ?? 0,
        missingRequirementCount: evidencePack?.missingRequirements.length ?? 0,
        persistentClaimHits: evidencePack?.diagnostics?.persistentClaimHits ?? 0,
        dynamicExperienceHits: evidencePack?.diagnostics?.dynamicExperienceHits ?? 0,
      },
    }, kernel, ctx);
  });

  app.post("/product/rag/evidence/reindex", async (request) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body ?? {});
    const service = kernel.productServices.evidenceRAGService;
    if (!service) throw new ApiError(ErrorCodes.INTERNAL_ERROR, "Evidence RAG is not configured.", 503);
    const report = await service.reindexUserExperiences({
      userId: ctx.user.id,
      limit: numericLimit(body.limit, 500, 1, 2000),
    });
    if (!report) throw new ApiError(ErrorCodes.INTERNAL_ERROR, "Persistent claim indexing is not configured.", 503);
    return productSuccess(report, kernel, ctx);
  });

  app.post("/product/rag/evidence/outcome", async (request) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    const outcome = optionalString(body.outcome);
    if (!outcome || !["interview", "rejection", "offer", "no_response", "other"].includes(outcome)) {
      throw new ApiError(ErrorCodes.INVALID_BODY, "A valid outcome is required.", 400);
    }
    const service = kernel.productServices.evidenceRAGService;
    if (!service) throw new ApiError(ErrorCodes.INTERNAL_ERROR, "Evidence RAG is not configured.", 503);
    const feedback = await service.recordOutcomeFeedback({
      userId: ctx.user.id,
      generationId: optionalString(body.generationId),
      resumeId: optionalString(body.resumeId),
      jdId: optionalString(body.jdId),
      targetRole: optionalString(body.targetRole),
      roleFamily: optionalString(body.roleFamily),
      outcome: outcome as "interview" | "rejection" | "offer" | "no_response" | "other",
      notes: optionalString(body.notes),
      relatedClaimIds: stringArray(body.relatedClaimIds),
      relatedExperienceIds: stringArray(body.relatedExperienceIds),
      metadata: isRecord(body.metadata) ? body.metadata : {},
    });
    return productSuccess(feedback ?? { recorded: false }, kernel, ctx);
  });
}

function numericLimit(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
