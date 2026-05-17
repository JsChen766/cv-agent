import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import type {
  ProductExperienceCategory,
  ProductExperienceRevisionSource,
  ProductExperienceVariantType,
  ProductResumeItem,
} from "../../product/types.js";

export async function registerProductRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  app.get("/product/experiences", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const data = await kernel.productServices.experienceService.listExperiences(ctx.user.id, { limit: readLimit(request.query) });
    return productSuccess(data, kernel, ctx);
  });

  app.post("/product/experiences", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const body = requireRecord(request.body);
    const data = await kernel.productServices.experienceService.createExperience(ctx.user.id, {
      title: requiredString(body.title, "title"),
      content: requiredString(body.content, "content"),
      category: readCategory(body.category),
      organization: optionalString(body.organization),
      role: optionalString(body.role),
      tags: stringArray(body.tags),
    });
    return productSuccess(data, kernel, ctx);
  });

  app.get("/product/experiences/:id", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const experience = await kernel.productServices.experienceService.getExperience(ctx.user.id, param(request, "id"));
    if (!experience) throw new ApiError("NOT_FOUND", "Experience not found.", 404);
    const revisions = await kernel.productServices.experienceService.listRevisions(ctx.user.id, experience.id);
    return productSuccess({ experience, revisions }, kernel, ctx);
  });

  app.patch("/product/experiences/:id", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const body = requireRecord(request.body);
    const patch = {
      title: optionalString(body.title),
      organization: optionalString(body.organization),
      role: optionalString(body.role),
      ...(Array.isArray(body.tags) ? { tags: stringArray(body.tags) } : {}),
    };
    const updated = await kernel.productServices.experienceService.updateExperience(ctx.user.id, param(request, "id"), {
      ...patch,
    });
    if (!updated) throw new ApiError("NOT_FOUND", "Experience not found.", 404);
    return productSuccess(updated, kernel, ctx);
  });

  app.post("/product/experiences/:id/revisions", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const body = requireRecord(request.body);
    const revision = await kernel.productServices.experienceService.createRevision(ctx.user.id, param(request, "id"), {
      content: requiredString(body.content, "content"),
      source: readRevisionSource(body.source),
    });
    return productSuccess(revision, kernel, ctx);
  });

  app.post("/product/experiences/:id/variants", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const body = requireRecord(request.body);
    const variant = await kernel.productServices.experienceService.createVariant(ctx.user.id, param(request, "id"), requiredString(body.revisionId, "revisionId"), {
      content: requiredString(body.content, "content"),
      variantType: readVariantType(body.variantType),
      language: readLanguage(body.language),
      targetJdId: optionalString(body.targetJdId),
    });
    return productSuccess(variant, kernel, ctx);
  });

  app.get("/product/jds", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    return productSuccess(await kernel.productServices.jdService.listJDs(ctx.user.id, readLimit(request.query)), kernel, ctx);
  });

  app.post("/product/jds", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const body = requireRecord(request.body);
    const jd = await kernel.productServices.jdService.saveJD(ctx.user.id, {
      rawText: requiredString(body.rawText ?? body.jdText, "rawText"),
      title: optionalString(body.title),
      company: optionalString(body.company),
      targetRole: optionalString(body.targetRole),
    });
    return productSuccess(jd, kernel, ctx);
  });

  app.get("/product/jds/:id", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const jd = await kernel.productServices.jdService.getJD(ctx.user.id, param(request, "id"));
    if (!jd) throw new ApiError("NOT_FOUND", "JD not found.", 404);
    return productSuccess(jd, kernel, ctx);
  });

  app.get("/product/resumes", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    return productSuccess(await kernel.productServices.resumeService.listResumes(ctx.user.id, readLimit(request.query)), kernel, ctx);
  });

  app.post("/product/resumes", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const body = requireRecord(request.body);
    return productSuccess(await kernel.productServices.resumeService.createResume(ctx.user.id, {
      title: optionalString(body.title),
      targetRole: optionalString(body.targetRole),
      jdId: optionalString(body.jdId),
    }), kernel, ctx);
  });

  app.get("/product/resumes/:id", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const resume = await kernel.productServices.resumeService.getResume(ctx.user.id, param(request, "id"));
    if (!resume) throw new ApiError("NOT_FOUND", "Resume not found.", 404);
    return productSuccess(resume, kernel, ctx);
  });

  app.post("/product/resumes/:id/items", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const body = requireRecord(request.body);
    const item = await kernel.productServices.resumeService.addResumeItem(ctx.user.id, param(request, "id"), {
      title: requiredString(body.title, "title"),
      contentSnapshot: requiredString(body.contentSnapshot, "contentSnapshot"),
      sectionType: readSectionType(body.sectionType),
      sourceExperienceId: optionalString(body.sourceExperienceId),
      sourceVariantId: optionalString(body.sourceVariantId),
      sourceArtifactId: optionalString(body.sourceArtifactId),
    });
    return productSuccess(item, kernel, ctx);
  });

  app.patch("/product/resume-items/:id", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const body = requireRecord(request.body);
    const item = await kernel.productServices.resumeService.updateResumeItem(ctx.user.id, param(request, "id"), {
      title: optionalString(body.title),
      contentSnapshot: optionalString(body.contentSnapshot),
      hidden: typeof body.hidden === "boolean" ? body.hidden : undefined,
      pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
    });
    if (!item) throw new ApiError("NOT_FOUND", "Resume item not found.", 404);
    return productSuccess(item, kernel, ctx);
  });

  app.post("/product/resumes/:id/reorder", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const body = requireRecord(request.body);
    return productSuccess(await kernel.productServices.resumeService.reorderResumeItems(ctx.user.id, param(request, "id"), stringArray(body.orderedIds)), kernel, ctx);
  });

  app.post("/product/imports/text", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const body = requireRecord(request.body);
    const job = await kernel.productServices.importService.createTextImportJob(ctx.user.id, requiredString(body.rawText, "rawText"));
    const candidates = await kernel.productServices.importService.createCandidatesFromText(ctx.user.id, job.id);
    return productSuccess({ job, candidates }, kernel, ctx);
  });

  app.get("/product/imports/:id", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const job = await kernel.productServices.importService.getImportJob(ctx.user.id, param(request, "id"));
    if (!job) throw new ApiError("NOT_FOUND", "Import job not found.", 404);
    const candidates = await kernel.productServices.importService.listCandidatesByJob(ctx.user.id, job.id);
    return productSuccess({ job, candidates }, kernel, ctx);
  });

  app.post("/product/import-candidates/:id/accept", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    return productSuccess(await kernel.productServices.importService.acceptCandidate(ctx.user.id, param(request, "id")), kernel, ctx);
  });

  app.post("/product/import-candidates/:id/reject", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    return productSuccess(await kernel.productServices.importService.rejectCandidate(ctx.user.id, param(request, "id")), kernel, ctx);
  });

  app.post("/product/generations/from-jd", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const body = requireRecord(request.body);
    const jdId = optionalString(body.jdId);
    const jdText = optionalString(body.jdText);
    if (!jdId && !jdText) {
      throw new ApiError("INVALID_BODY", "jdText or jdId is required.", 400);
    }
    const result = await kernel.productServices.generationProductService.generateResumeFromJD(ctx, {
      userId: ctx.user.id,
      jdId,
      jdText,
      targetRole: optionalString(body.targetRole),
    });
    return productSuccess({ generationId: result.generation.id, jd: result.jd, variants: result.variants, generation: result.generation }, kernel, ctx);
  });

  app.post("/product/generations/:id/accept-variant", async (request) => {
    const ctx = createKernelRequestContext(request, await authResolver.resolve(request));
    const body = requireRecord(request.body);
    return productSuccess(await kernel.productServices.generationProductService.saveAcceptedVariantToResume(ctx.user.id, {
      generationId: param(request, "id"),
      variantId: requiredString(body.variantId, "variantId"),
      resumeId: optionalString(body.resumeId),
    }), kernel, ctx);
  });
}

function productSuccess(data: unknown, kernel: ApiKernel, ctx: ReturnType<typeof createKernelRequestContext>) {
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

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("INVALID_BODY", `${name} is required.`, 400);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readCategory(value: unknown): ProductExperienceCategory | undefined {
  return readEnum(value, "category", ["work", "project", "education", "award", "skill", "other"]);
}

function readRevisionSource(value: unknown): ProductExperienceRevisionSource | undefined {
  return readEnum(value, "source", ["manual", "import", "copilot", "resume_upload"]);
}

function readVariantType(value: unknown): ProductExperienceVariantType | undefined {
  return readEnum(value, "variantType", ["full", "medium", "short", "jd_tailored", "custom"]);
}

function readLanguage(value: unknown): "zh" | "en" | undefined {
  return readEnum(value, "language", ["zh", "en"]);
}

function readSectionType(value: unknown): ProductResumeItem["sectionType"] | undefined {
  return readEnum(value, "sectionType", ["experience", "education", "project", "skill", "award", "summary", "other"]);
}

function readEnum<const T extends string>(value: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ApiError("INVALID_BODY", `${name} must be one of: ${allowed.join(", ")}.`, 400);
  }
  return value as T;
}

function param(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, unknown>;
  return requiredString(params[name], name);
}

function readLimit(query: unknown): number | undefined {
  if (typeof query !== "object" || query === null) return undefined;
  const value = (query as Record<string, unknown>).limit;
  const parsed = typeof value === "string" ? Number(value) : undefined;
  return Number.isFinite(parsed) ? parsed : undefined;
}
