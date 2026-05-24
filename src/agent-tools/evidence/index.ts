import { z } from "zod";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { normalizeShowEvidenceArgs } from "../../agent-core/security/ToolIdGuard.js";
import { ShowEvidenceInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import type { ProductVariant } from "../../copilot/types.js";

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
        const normalized = normalizeShowEvidenceArgs(input);
        const variantId = stringValue(normalized.variantId);
        const evidenceChainId = stringValue(normalized.evidenceChainId);
        const generationId = stringValue(normalized.generationId);
        const evidenceId = stringValue(normalized.evidenceId);
        const workspace = context.workspace;
        const variant = variantId
          ? workspace?.variants?.find((item) => item.id === variantId)
          : evidenceChainId
            ? workspace?.variants?.find((item) => item.id === evidenceChainId)
            : evidenceId
              ? workspace?.variants?.find((item) => variantHasEvidence(item, evidenceId))
              : undefined;

        if (variant && hasEvidence(variant)) {
          const evidence = evidenceId
            ? (variant.evidenceSummary?.items ?? []).filter((item) => item.id === evidenceId)
            : variant.evidenceSummary?.items ?? [];
          return {
            status: "success",
            message: "Evidence loaded.",
            visibility: "internal",
            data: {
              variantId: variant.id,
              evidence,
              sourceExperienceIds: variant.sourceExperienceIds ?? [],
              sourceEvidenceIds: variant.sourceEvidenceIds ?? [],
              riskSummary: variant.riskSummary ?? { level: "unknown", unsupportedClaims: [], missingEvidence: [], warnings: [] },
              evidenceSummary: variant.evidenceSummary,
            },
            actionResult: {
              status: "success",
              actionType: "show_evidence",
              variantId: variant.id,
              evidenceId,
              evidenceChainId,
              metadata: {
                evidence,
                sourceExperienceIds: variant.sourceExperienceIds ?? [],
                sourceEvidenceIds: variant.sourceEvidenceIds ?? [],
                riskSummary: variant.riskSummary ?? {},
              },
            },
          };
        }

        if (generationId && !variantId && !evidenceChainId && !evidenceId) {
          const message = "Generation-level evidence lookup is not supported yet. Please select a specific variant or evidence item.";
          return {
            status: "needs_input",
            message,
            visibility: "error_user_visible",
            data: { generationId, evidence: [], empty: true, reason: "generation_evidence_lookup_not_supported" },
            actionResult: {
              status: "needs_input",
              actionType: "show_evidence",
              message,
              reason: "generation_evidence_lookup_not_supported",
            },
          };
        }

        if (variantId || evidenceChainId || evidenceId) {
          const message = "No evidence chain is available for the selected item. Please select another generated variant or evidence item.";
          return {
            status: "needs_input",
            message,
            visibility: "error_user_visible",
            data: { variantId: variant?.id ?? variantId, evidenceChainId, evidenceId, evidence: [], empty: true, reason: "evidence_chain_not_available" },
            actionResult: {
              status: "needs_input",
              actionType: "show_evidence",
              message,
              reason: "evidence_chain_not_available",
              metadata: { empty: true },
            },
          };
        }

        const message = "Please select a generated variant or evidence item first.";
        return {
          status: "needs_input",
          message,
          visibility: "error_user_visible",
          data: { evidence: [] },
          actionResult: {
            status: "needs_input",
            actionType: "show_evidence",
            missingInputs: ["variantId", "evidenceId", "evidenceChainId", "generationId"],
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

function hasEvidence(variant: ProductVariant): boolean {
  return (variant.sourceExperienceIds?.length ?? 0) > 0
    || (variant.sourceEvidenceIds?.length ?? 0) > 0
    || (variant.evidenceSummary?.items?.length ?? 0) > 0;
}

function variantHasEvidence(variant: ProductVariant, evidenceId: string): boolean {
  return variant.sourceExperienceIds?.includes(evidenceId)
    || variant.sourceEvidenceIds?.includes(evidenceId)
    || variant.evidenceSummary?.items?.some((item) => item.id === evidenceId)
    || false;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
