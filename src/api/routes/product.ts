import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiKernel } from "../types.js";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { applyRateLimit } from "../rateLimit.js";
import { registerExperienceRoutes } from "./product/experienceRoutes.js";
import { registerJDRoutes } from "./product/jdRoutes.js";
import { registerResumeRoutes } from "./product/resumeRoutes.js";
import { registerImportRoutes } from "./product/importRoutes.js";
import { registerGenerationRoutes } from "./product/generationRoutes.js";
import { registerRagRoutes } from "./product/ragRoutes.js";
import { registerPreferenceRoutes } from "./product/preferenceRoutes.js";

export async function registerProductRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  const contextFor = async (request: FastifyRequest) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    await applyRateLimit(kernel, ctx, request);
    return ctx;
  };

  registerExperienceRoutes(app, kernel, contextFor, authResolver);
  registerJDRoutes(app, kernel, contextFor, authResolver);
  registerResumeRoutes(app, kernel, contextFor, authResolver);
  registerImportRoutes(app, kernel, contextFor, authResolver);
  registerGenerationRoutes(app, kernel, contextFor, authResolver);
  registerRagRoutes(app, kernel, contextFor, authResolver);
  registerPreferenceRoutes(app, kernel, contextFor, authResolver);
}
