import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ImportCandidateInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { sanitizeImportCandidate, sanitizeExperienceItem } from "../../agent-core/runtime/ProductBlockPresenter.js";
import type { ProductImportCandidate } from "../../product/types.js";

export function acceptImportCandidateTool(): ToolDefinition {
  return {
    name: "accept_import_candidate",
    description: "Accept an import candidate and create a product experience.",
    ownerAgent: "experience_receiver",
    inputSchema: ImportCandidateInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "write",
    requiresConfirmation: true,
    riskLevel: "low",
    execute: async (input, context) => {
      const candidateId = String(input.candidateId ?? "").trim();
      const patch = isRecord(input.patch) ? sanitizeCandidatePatch(input.patch) : {};
      const result = await context.kernel.productServices.importService.acceptCandidate(context.userId, candidateId, patch);
      return {
        status: "success",
        message: "Import candidate saved to the experience library.",
        data: {
          candidate: sanitizeImportCandidate(result.candidate as unknown as Record<string, unknown>),
          experience: sanitizeExperienceItem(result.experience as unknown as Record<string, unknown>),
        },
        workspacePatch: {
          activePanel: "experience_library",
          active: { experienceId: result.experience.id },
        },
        actionResult: {
          status: "success",
          actionType: "accept_import_candidate",
          message: "Import candidate saved to the experience library.",
          experienceId: result.experience.id,
          metadata: {
            candidateId,
            experienceId: result.experience.id,
            candidateStatus: result.candidate.status,
          },
        },
        visibility: "user_summary",
      };
    },
  };
}

function sanitizeCandidatePatch(value: Record<string, unknown>): Partial<Pick<ProductImportCandidate, "title" | "category" | "organization" | "role" | "startDate" | "endDate" | "content" | "structured">> {
  return {
    title: stringValue(value.title),
    category: categoryValue(value.category),
    organization: stringValue(value.organization),
    role: stringValue(value.role),
    startDate: stringValue(value.startDate),
    endDate: stringValue(value.endDate),
    content: stringValue(value.content),
    structured: isRecord(value.structured) ? value.structured : undefined,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function categoryValue(value: unknown): ProductImportCandidate["category"] | undefined {
  return value === "work"
    || value === "internship"
    || value === "project"
    || value === "education"
    || value === "award"
    || value === "skill"
    || value === "other"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
