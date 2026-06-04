import type { FastifyRequest } from "fastify";
import { ApiError, ErrorCodes } from "../../errors.js";
import { success } from "../../response.js";
import type { ApiKernel } from "../../types.js";
import type { KernelRequestContext } from "../../context.js";
import type {
  ProductExperienceCategory,
  ProductExperienceRevisionSource,
  ProductExperienceVariantType,
  ProductResumeItem,
} from "../../../product/types.js";

export type ProductRouteContextFn = (request: FastifyRequest) => Promise<KernelRequestContext>;

export function productSuccess(data: unknown, kernel: ApiKernel, ctx: KernelRequestContext) {
  return success(data, {
    requestId: ctx.request.requestId,
    traceId: ctx.request.traceId,
    mode: kernel.mode,
    ...(kernel.warnings.length > 0 ? { warnings: kernel.warnings } : {}),
  });
}

export function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(ErrorCodes.INVALID_BODY, "Request body must be a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(ErrorCodes.INVALID_BODY, `${name} is required.`, 400);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function compactRecord<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

export function readCategory(value: unknown): ProductExperienceCategory | undefined {
  return readEnum(value, "category", ["work", "internship", "project", "education", "award", "skill", "other"]);
}

export function readRevisionSource(value: unknown): ProductExperienceRevisionSource | undefined {
  return readEnum(value, "source", ["manual", "import", "copilot", "resume_upload"]);
}

export function readVariantType(value: unknown): ProductExperienceVariantType | undefined {
  return readEnum(value, "variantType", ["full", "medium", "short", "jd_tailored", "custom"]);
}

export function readLanguage(value: unknown): "zh" | "en" | undefined {
  return readEnum(value, "language", ["zh", "en"]);
}

export function readSectionType(value: unknown): ProductResumeItem["sectionType"] | undefined {
  return readEnum(value, "sectionType", ["experience", "education", "project", "skill", "award", "summary", "other"]);
}

function readEnum<const T extends string>(value: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ApiError(ErrorCodes.INVALID_BODY, `${name} must be one of: ${allowed.join(", ")}.`, 400);
  }
  return value as T;
}

export function param(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, unknown>;
  return requiredString(params[name], name);
}

export function readLimit(query: unknown): number | undefined {
  if (typeof query !== "object" || query === null) return undefined;
  const value = (query as Record<string, unknown>).limit;
  const parsed = typeof value === "string" ? Number(value) : undefined;
  return Number.isFinite(parsed) ? parsed : undefined;
}
