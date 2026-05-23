import { z } from "zod";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

const ShowEvidenceInputSchema = z.object({
  id: z.string().optional(),
  variantId: z.string().optional(),
  generationId: z.string().optional(),
  evidenceId: z.string().optional(),
}).passthrough();

export function createEvidenceAgentTools(): ToolDefinition[] {
  return [
    {
      name: "show_evidence",
      description: "Show evidence linked to an experience or resume artifact.",
      ownerAgent: "critic",
      inputSchema: ShowEvidenceInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const variantId = typeof input.variantId === "string" ? input.variantId : undefined;
        const generationId = typeof input.generationId === "string" ? input.generationId : undefined;
        const evidenceId = typeof input.evidenceId === "string" ? input.evidenceId : undefined;
        const workspace = context.workspace;
        const variant = variantId
          ? workspace?.variants?.find((item) => item.id === variantId)
          : workspace?.variants?.[0];

        if (variant && hasEvidence(variant)) {
          return {
            status: "success",
            message: "Evidence loaded.",
            visibility: "internal",
            data: {
              variantId: variant.id,
              evidence: variant.evidenceSummary?.items ?? [],
              sourceExperienceIds: variant.sourceExperienceIds ?? [],
              sourceEvidenceIds: variant.sourceEvidenceIds ?? [],
              riskSummary: variant.riskSummary ?? { level: "unknown", unsupportedClaims: [], missingEvidence: [], warnings: [] },
              evidenceSummary: variant.evidenceSummary,
            },
            actionResult: {
              status: "success",
              actionType: "show_evidence",
              variantId: variant.id,
              metadata: {
                evidence: variant.evidenceSummary?.items ?? [],
                sourceExperienceIds: variant.sourceExperienceIds ?? [],
                sourceEvidenceIds: variant.sourceEvidenceIds ?? [],
                riskSummary: variant.riskSummary ?? {},
              },
            },
          };
        }

        if (variantId || generationId || evidenceId || variant) {
          const message = "当前版本还没有可展示的证据链。请先生成带证据的版本，或选择其他生成结果。";
          return {
            status: "needs_input",
            message,
            visibility: "error_user_visible",
            data: { variantId: variant?.id ?? variantId, generationId, evidenceId, evidence: [], empty: true, reason: "evidence_chain_not_available" },
            actionResult: {
              status: "needs_input",
              actionType: "show_evidence",
              message,
              reason: "evidence_chain_not_available",
              metadata: { empty: true, notImplemented: true },
            },
          };
        }

        const message = "请先选择一个生成版本或证据项。";
        return {
          status: "needs_input",
          message,
          visibility: "error_user_visible",
          data: { evidence: [] },
          actionResult: {
            status: "needs_input",
            actionType: "show_evidence",
            missingInputs: ["variantId", "generationId"],
            message,
          },
        };
      },
    },
    {
      name: "check_unsupported_claims",
      description: "Check text for unsupported or risky claims.",
      ownerAgent: "critic",
      inputSchema: z.object({ text: z.string().optional(), resumeId: z.string().optional(), experienceId: z.string().optional() }).passthrough(),
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input) => {
        const text = typeof input.text === "string" ? input.text : "";
        const warnings = /\b(best|only|guaranteed|100%|top)\b/i.test(text) ? ["Potentially exaggerated claim detected."] : [];
        return {
          status: "success",
          message: warnings.length ? "Found unsupported-claim risks." : "No obvious unsupported claims found.",
          visibility: "internal",
          data: { warnings },
        };
      },
    },
  ];
}

function hasEvidence(variant: { sourceExperienceIds?: unknown[]; sourceEvidenceIds?: unknown[]; evidenceSummary?: { items?: unknown[] } }): boolean {
  return (variant.sourceExperienceIds?.length ?? 0) > 0
    || (variant.sourceEvidenceIds?.length ?? 0) > 0
    || (variant.evidenceSummary?.items?.length ?? 0) > 0;
}
