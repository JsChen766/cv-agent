import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ImportCandidateInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { sanitizeImportCandidate } from "../../agent-core/runtime/ProductBlockPresenter.js";

export function rejectImportCandidateTool(): ToolDefinition {
  return {
    name: "reject_import_candidate",
    description: "Reject an import candidate without creating an experience.",
    ownerAgent: "experience_receiver",
    inputSchema: ImportCandidateInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "write",
    requiresConfirmation: true,
    riskLevel: "low",
    execute: async (input, context) => {
      const candidateId = String(input.candidateId ?? "").trim();
      const candidate = await context.kernel.productServices.importService.rejectCandidate(context.userId, candidateId);
      return {
        status: "success",
        message: "Import candidate ignored.",
        data: {
          candidate: sanitizeImportCandidate(candidate as unknown as Record<string, unknown>),
        },
        actionResult: {
          status: "success",
          actionType: "reject_import_candidate",
          message: "Import candidate ignored.",
          metadata: {
            candidateId,
            candidateStatus: candidate.status,
          },
        },
        visibility: "user_summary",
      };
    },
  };
}
