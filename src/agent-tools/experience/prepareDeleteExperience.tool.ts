import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { DeleteExperienceInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function prepareDeleteExperienceTool(): ToolDefinition {
  return {
    name: "prepare_delete_experience",
    description: "Preview archiving an experience without changing the database.",
    ownerAgent: "experience_receiver",
    inputSchema: DeleteExperienceInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "read",
    requiresConfirmation: false,
    riskLevel: "medium",
    execute: async (input, context) => {
      const id = String(input.experienceId);
      const before = await context.kernel.productServices.experienceService.getExperience(context.userId, id);
      if (!before) return { status: "failed", message: "Experience not found.", data: { id } };
      return {
        status: "success",
        message: `Prepared deletion for "${before.title}".`,
        data: { before, after: { ...before, status: "archived" } },
        actionResult: { status: "needs_confirmation", actionType: "delete_experience", preview: { before } },
      };
    },
  };
}
