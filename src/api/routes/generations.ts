import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { ApiKernel, GenerateJsonBody } from "../types.js";

export async function registerGenerationRoutes(app: FastifyInstance, kernel: ApiKernel): Promise<void> {
  app.post("/generations", async (request) => {
    const userId = requireUserId(request);
    const body = parseGenerateBody(request.body);
    const generation = await kernel.resumeGenerationService.generate({
      userId,
      jdText: body.jdText,
      targetRole: body.targetRole,
    });
    const persisted = kernel.generationPersistenceService
      ? await kernel.generationPersistenceService.persist(generation, { source: "api" })
      : undefined;

    return {
      artifacts: generation.artifacts,
      evidenceChains: generation.evidenceChains,
      graphViews: generation.graphViews,
      coverageReport: generation.coverageReport,
      coverageGapReport: generation.coverageGapReport,
      critiqueReport: generation.critiqueReport,
      ...(persisted
        ? {
            persistedGeneration: {
              sessionId: persisted.session.id,
              evidenceChainSnapshotCount: persisted.evidenceChainSnapshots.length,
              graphViewSnapshotCount: persisted.graphViewSnapshots.length,
              bundleCount: persisted.bundles.length,
            },
          }
        : {}),
    };
  });
}

function requireUserId(request: FastifyRequest): string {
  const value = request.headers["x-user-id"];
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new ApiError("MISSING_USER_ID", "x-user-id header is required.", 400);
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
