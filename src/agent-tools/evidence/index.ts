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

        // Try to find a variant from workspace
        const workspace = context.workspace;
        const variant = variantId
          ? workspace?.variants?.find((v) => v.id === variantId)
          : workspace?.variants?.[0];

        if (variant) {
          const hasEvidence = (variant.sourceExperienceIds?.length ?? 0) > 0
            || (variant.sourceEvidenceIds?.length ?? 0) > 0
            || (variant.evidenceSummary?.items?.length ?? 0) > 0;

          if (hasEvidence) {
            return {
              status: "success",
              message: `证据信息已加载（${variant.evidenceSummary?.coverageLabel ?? "已找到相关证据"}）。`,
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

          return {
            status: "success",
            message: "当前版本暂无可展示证据，请先补充经历素材或重新生成。",
            data: { variantId: variant.id, evidence: [], empty: true },
            actionResult: {
              status: "success",
              actionType: "show_evidence",
              message: "当前版本暂无可展示证据，请先补充经历素材或重新生成。",
              metadata: { empty: true },
            },
          };
        }

        // If we have variantId/generationId but couldn't find the variant, still return success with a message
        if (variantId || generationId || evidenceId) {
          return {
            status: "success",
            message: "当前版本暂无可展示证据，请先补充经历素材或重新生成。",
            data: { variantId, generationId, evidenceId, evidence: [], empty: true },
            actionResult: {
              status: "success",
              actionType: "show_evidence",
              message: "当前版本暂无可展示证据，请先补充经历素材或重新生成。",
              metadata: { empty: true },
            },
          };
        }

        return {
          status: "needs_input",
          message: "请先选择一个生成版本或证据项。",
          data: { evidence: [] },
          actionResult: {
            status: "needs_input",
            actionType: "show_evidence",
            missingInputs: ["variantId", "generationId"],
            message: "请先选择一个生成版本或证据项。",
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
        return { status: "success", message: warnings.length ? "Found unsupported-claim risks." : "No obvious unsupported claims found.", data: { warnings } };
      },
    },
  ];
}
