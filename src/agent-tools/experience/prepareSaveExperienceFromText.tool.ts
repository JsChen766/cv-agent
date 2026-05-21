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
        message: "已识别出一条经历草稿，你可以继续补充或要求我保存。",
        data: { draft },
        actionResult: {
          status: "success",
          actionType: "prepare_save_experience_from_text",
          message: "已识别出一条经历草稿。",
        },
      };
    },
  };
}
