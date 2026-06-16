import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthResolver } from "../../auth/index.js";
import { ApiError, ErrorCodes } from "../../errors.js";
import type { ApiKernel } from "../../types.js";
import type { PreferenceScope, PreferenceStatus } from "../../../self-evolution/preference/index.js";
import {
  optionalString,
  productSuccess,
  requireRecord,
  requiredString,
  type ProductRouteContextFn,
} from "./productRouteHelpers.js";

export function registerPreferenceRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  contextFor: ProductRouteContextFn,
  _authResolver: AuthResolver<FastifyRequest>,
): void {
  app.get("/product/preferences", async (request) => {
    const ctx = await contextFor(request);
    const service = requireService(kernel);
    const query = isRecord(request.query) ? request.query : {};
    const statuses = parseStatuses(query.status ?? query.statuses);
    const preferences = await service.listPreferences(ctx.user.id, {
      statuses,
      limit: numericLimit(query.limit, 200, 1, 1000),
    });
    return productSuccess({ preferences }, kernel, ctx);
  });

  app.post("/product/preferences/explicit", async (request) => {
    const ctx = await contextFor(request);
    const service = requireService(kernel);
    const body = requireRecord(request.body);
    const result = await service.recordExplicitPreference({
      userId: ctx.user.id,
      instruction: requiredString(body.instruction ?? body.text, "instruction"),
      polarity: body.polarity === "negative" ? "negative" : "positive",
      scope: readScope(body.scope ?? body),
      source: "product_preferences_explicit_route",
    });
    return productSuccess(result, kernel, ctx);
  });

  app.post("/product/preferences/preview", async (request) => {
    const ctx = await contextFor(request);
    const service = requireService(kernel);
    const body = requireRecord(request.body ?? {});
    const jdId = optionalString(body.jdId);
    const jd = jdId ? await kernel.productServices.jdService.getJD(ctx.user.id, jdId) : undefined;
    const jdText = jd?.rawText ?? optionalString(body.jdText ?? body.rawText ?? body.text);
    const targetRole = optionalString(body.targetRole) ?? jd?.targetRole;
    const instructionPack = jdText && kernel.productServices.guidelineRAGService
      ? await kernel.productServices.guidelineRAGService.buildInstructionPack({
          userId: ctx.user.id,
          jdText,
          targetRole,
          limit: 8,
        })
      : undefined;
    const context: PreferenceScope = {
      ...readScope(body.scope ?? body),
      targetRole: targetRole ?? readScope(body.scope ?? body).targetRole,
      roleFamily: instructionPack?.roleFamily ?? readScope(body.scope ?? body).roleFamily,
      applicationType: instructionPack?.applicationType ?? readScope(body.scope ?? body).applicationType,
      language: instructionPack?.language ?? readScope(body.scope ?? body).language,
      industry: instructionPack?.industry ?? readScope(body.scope ?? body).industry,
    };
    const personalizationPack = await service.buildPersonalizationPack({
      userId: ctx.user.id,
      context,
      limit: numericLimit(body.limit, 12, 1, 40),
    });
    return productSuccess({ personalizationPack }, kernel, ctx);
  });
}

function requireService(kernel: ApiKernel) {
  const service = kernel.productServices.preferenceBankService;
  if (!service) {
    throw new ApiError(ErrorCodes.INTERNAL_ERROR, "PreferenceBank is not configured.", 503);
  }
  return service;
}

function readScope(value: unknown): PreferenceScope {
  if (!isRecord(value)) return {};
  const language = optionalString(value.language);
  return {
    roleFamily: optionalString(value.roleFamily),
    applicationType: optionalString(value.applicationType),
    language: language === "zh" || language === "en" ? language : undefined,
    section: optionalString(value.section),
    targetRole: optionalString(value.targetRole),
    industry: optionalString(value.industry),
  };
}

function parseStatuses(value: unknown): PreferenceStatus[] | undefined {
  const allowed = new Set<PreferenceStatus>(["candidate", "active", "stale", "rejected", "locked"]);
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const statuses = items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item): item is PreferenceStatus => allowed.has(item as PreferenceStatus));
  return statuses.length > 0 ? [...new Set(statuses)] : undefined;
}

function numericLimit(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
