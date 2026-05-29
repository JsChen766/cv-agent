import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { TextInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { extractExperienceDraftFromText } from "./helpers.js";
import { extractedCandidateToDraft } from "../../product/LLMExperienceExtractor.js";
import { buildNormalizedExperiencePreview } from "../../product/experiencePreview.js";
import { isDeterministicFallbackAllowed, llmNotAvailableResult } from "../../product/deterministicFallbackGuard.js";

export function prepareSaveExperienceFromTextTool(): ToolDefinition {
  return {
    name: "prepare_save_experience_from_text",
    description: "Preview an experience draft from free text without writing the database. Uses AI to extract structured experience.",
    ownerAgent: "experience_receiver",
    inputSchema: TextInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "read",
    requiresConfirmation: false,
    riskLevel: "low",
    execute: async (input, context) => {
      const text = String(input.text);
      const llmExtractor = context.kernel.llmExperienceExtractor;

      // Primary path: LLM extraction
      if (llmExtractor) {
        const candidates = await llmExtractor.extractCandidates(text);
        if (candidates.length > 0) {
          const converted = extractedCandidateToDraft(candidates[0]);
          const draft = {
            category: converted.category,
            title: converted.title,
            organization: converted.organization,
            role: converted.role,
            startDate: converted.startDate,
            endDate: converted.endDate,
            content: converted.content,
            tags: converted.tags,
            structured: converted.structured as ReturnType<typeof extractExperienceDraftFromText>["structured"],
            confidence: converted.confidence,
            warnings: converted.warnings,
          };
          return {
            status: "success",
            message: "Prepared structured experience draft preview using AI.",
            data: {
              draft,
              experienceDraft: buildNormalizedExperiencePreview(draft, { missingFields: draft.warnings }),
              warnings: draft.warnings,
              confidence: draft.confidence,
            },
            actionResult: {
              status: "success",
              actionType: "prepare_save_experience_from_text",
              message: "AI-powered experience draft preview.",
              metadata: {
                experienceDraft: buildNormalizedExperiencePreview(draft, { missingFields: draft.warnings }),
                usedModel: true,
              },
            },
          };
        }
        // LLM returned no candidates
        if (!isDeterministicFallbackAllowed()) {
          return { status: "needs_input", message: "AI model could not extract any experience from this text.", visibility: "error_user_visible", actionResult: { status: "needs_input", actionType: "prepare_save_experience_from_text", reason: "llm_not_available", message: "AI model could not extract any experience from this text." } };
        }
      } else {
        // No LLM extractor
        if (!isDeterministicFallbackAllowed()) {
          return llmNotAvailableResult("prepare_save_experience_from_text");
        }
      }

      // Deterministic fallback (test mode only)
      const draft = extractExperienceDraftFromText(text);
      return {
        status: "success",
        message: "Prepared structured experience draft preview.",
        data: {
          draft,
          experienceDraft: buildNormalizedExperiencePreview(draft, { missingFields: draft.warnings }),
          warnings: draft.warnings,
          confidence: draft.confidence,
        },
        actionResult: {
          status: "success",
          actionType: "prepare_save_experience_from_text",
          message: "Prepared structured experience draft preview.",
          metadata: {
            experienceDraft: buildNormalizedExperiencePreview(draft, { missingFields: draft.warnings }),
          },
        },
      };
    },
  };
}
