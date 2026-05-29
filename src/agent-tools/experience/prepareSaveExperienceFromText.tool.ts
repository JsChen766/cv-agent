import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { TextInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { extractExperienceDraftFromText } from "./helpers.js";
import { extractedCandidateToDraft } from "../../product/LLMExperienceExtractor.js";
import { buildNormalizedExperiencePreview } from "../../product/experiencePreview.js";

export function prepareSaveExperienceFromTextTool(): ToolDefinition {
  return {
    name: "prepare_save_experience_from_text",
    description: "Preview an experience draft from free text without writing the database.",
    ownerAgent: "experience_receiver",
    inputSchema: TextInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "read",
    requiresConfirmation: false,
    riskLevel: "low",
    execute: async (input, context) => {
      const text = String(input.text);

      // Primary: LLM extraction; fallback: rule-based
      const llmExtractor = context.kernel.llmExperienceExtractor;
      let draft: ReturnType<typeof extractExperienceDraftFromText>;

      if (llmExtractor) {
        try {
          const candidates = await llmExtractor.extractCandidates(text);
          if (candidates.length > 0) {
            const converted = extractedCandidateToDraft(candidates[0]);
            draft = {
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
          } else {
            draft = extractExperienceDraftFromText(text);
          }
        } catch {
          draft = extractExperienceDraftFromText(text);
        }
      } else {
        draft = extractExperienceDraftFromText(text);
      }

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
