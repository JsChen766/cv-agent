import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { ApiKernel } from "../types.js";
import type { GraphScopeType } from "../../application/query/index.js";

export async function registerEvidenceRoutes(app: FastifyInstance, kernel: ApiKernel): Promise<void> {
  app.get<{ Params: { sessionId: string } }>("/generations/:sessionId/evidence-chains", async (request) => {
    const userId = requireUserId(request);
    return kernel.evidenceChainQueryService.listBySessionId(userId, request.params.sessionId);
  });

  app.get<{ Params: { scopeType: string; scopeId: string } }>("/graphs/:scopeType/:scopeId", async (request) => {
    const userId = requireUserId(request);
    const scopeType = parseScopeType(request.params.scopeType);
    return kernel.graphViewQueryService.listByScope(userId, scopeType, request.params.scopeId);
  });
}

function requireUserId(request: FastifyRequest): string {
  const value = request.headers["x-user-id"];
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new ApiError("MISSING_USER_ID", "x-user-id header is required.", 400);
}

function parseScopeType(value: string): GraphScopeType {
  if (value === "user" || value === "experience" || value === "generation" || value === "artifact") {
    return value;
  }
  throw new ApiError("INVALID_SCOPE_TYPE", "scopeType must be user, experience, generation, or artifact.", 400);
}
