import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { TextInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { inferExperienceDraft } from "./helpers.js";

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
      const draft = inferExperienceDraft(String(input.text));
      return {
        status: "success",
        message: "Prepared an experience draft for confirmation.",
        data: { draft },
        actionResult: { status: "needs_confirmation", actionType: "save_experience_from_text", preview: { after: draft } },
      };
    },
  };
}
