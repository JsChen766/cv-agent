import { z } from "zod";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { normalizeShowEvidenceArgs } from "../../agent-core/security/ToolIdGuard.js";
import { ShowEvidenceInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import type { ProductVariant } from "../../copilot/types.js";
import { isDeterministicFallbackAllowed, llmNotAvailableResult } from "../../product/deterministicFallbackGuard.js";

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

          // Try LLM claim check if available
          let claimCheck = null;
          if (context.kernel.llmRewriteService && generationId) {
            try {
              const experiences = await context.kernel.productServices.experienceService.listExperiences(
                context.userId, { limit: 10, status: "active" },
              );
              const expForCheck = experiences.map((e) => ({
                id: e.id,
                title: e.title,
                content: e.content ?? "",
                organization: e.organization,
                role: e.role,
              }));
              claimCheck = await context.kernel.llmRewriteService.checkClaims(
                variant.content,
                expForCheck,
              );
            } catch {
              // LLM claim check failed, continue without it
            }
          }

          return {
            status: "success",
            message: "Evidence loaded.",
            visibility: "internal",
            data: {
              variantId: variant.id,
              evidence,
              sourceExperienceIds: variant.sourceExperienceIds ?? [],
              sourceEvidenceIds: variant.sourceEvidenceIds ?? [],
              riskSummary: claimCheck?.summary ? {
                level: claimCheck.summary.riskLevel,
                unsupportedClaims: claimCheck.claims
                  .filter((c) => !c.supported)
                  .map((c) => c.text),
                missingEvidence: claimCheck.claims
                  .filter((c) => !c.supported && !c.sourceExperienceId)
                  .map((c) => c.text),
                warnings: claimCheck.summary.unsupportedClaims > 0
                  ? [`${claimCheck.summary.unsupportedClaims} unsupported claims found.`]
                  : [],
              } : variant.riskSummary ?? { level: "unknown", unsupportedClaims: [], missingEvidence: [], warnings: [] },
              evidenceSummary: variant.evidenceSummary,
              ...(claimCheck ? { claimCheck } : {}),
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
                ...(claimCheck ? { claimCheck } : {}),
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
      description: "Check text for unsupported or risky claims using LLM analysis.",
      ownerAgent: "critic",
      inputSchema: z.object({ text: z.string().optional(), resumeId: z.string().optional(), experienceId: z.string().optional() }).passthrough(),
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const text = typeof input.text === "string" ? input.text : "";

        // Primary: LLM-based claim checking
        const llmRewrite = context.kernel.llmRewriteService;
        if (!llmRewrite) {
          if (!isDeterministicFallbackAllowed()) {
            return llmNotAvailableResult("check_unsupported_claims");
          }
          // Test mode only: basic regex fallback
          const warnings = /\b(best|only|guaranteed|100%|top|#1|number one)\b/i.test(text)
            ? ["Potentially exaggerated claim detected."]
            : [];
          return {
            status: "success",
            message: warnings.length ? "Found unsupported-claim risks." : "No obvious unsupported claims found.",
            visibility: "internal",
            data: { warnings },
          };
        }

        if (!text) {
          return {
            status: "needs_input",
            message: "Please provide text to check for unsupported claims.",
            visibility: "error_user_visible",
            data: { warnings: [] },
            actionResult: {
              status: "needs_input",
              actionType: "check_unsupported_claims",
              reason: "missing_text",
              message: "Please provide text to check.",
            },
          };
        }

        const experiences = await context.kernel.productServices.experienceService.listExperiences(
          context.userId, { limit: 10, status: "active" },
        );
        const expForCheck = experiences.map((e) => ({
          id: e.id,
          title: e.title,
          content: e.content ?? "",
          organization: e.organization,
          role: e.role,
        }));
        const result = await llmRewrite.checkClaims(text, expForCheck);
        if (result) {
          return {
            status: "success",
            message: result.summary.unsupportedClaims > 0
              ? `Found ${result.summary.unsupportedClaims} unsupported claims.`
              : "All claims appear supported by the experience library.",
            visibility: "internal",
            data: {
              claims: result.claims,
              summary: result.summary,
              riskLevel: result.summary.riskLevel,
            },
          };
        }

        return {
          status: "needs_input",
          message: "Unable to verify claims at this time. The AI model returned no results.",
          visibility: "error_user_visible",
          data: { warnings: [] },
          actionResult: {
            status: "needs_input",
            actionType: "check_unsupported_claims",
            reason: "llm_not_available",
            message: "Unable to verify claims at this time.",
          },
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
