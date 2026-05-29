import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { TextInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { extractExperienceDraftFromText } from "./helpers.js";

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
    execute: async (input) => {
      const draft = extractExperienceDraftFromText(String(input.text));
      return {
        status: "success",
        message: "Prepared structured experience draft preview.",
        data: {
          draft,
          warnings: draft.warnings,
          confidence: draft.confidence,
        },
        actionResult: {
          status: "success",
          actionType: "prepare_save_experience_from_text",
          message: "Prepared structured experience draft preview.",
        },
      };
    },
  };
}