import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ToolResultSchema, UpdateExperienceInputSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function prepareUpdateExperienceTool(): ToolDefinition {
  return {
    name: "prepare_update_experience",
    description: "Preview an experience update without writing the database.",
    ownerAgent: "experience_receiver",
    inputSchema: UpdateExperienceInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "read",
    requiresConfirmation: false,
    riskLevel: "low",
    execute: async (input, context) => {
      const id = String(input.experienceId);
      const before = await context.kernel.productServices.experienceService.getExperience(context.userId, id);
      if (!before) return { status: "failed", message: "Experience not found.", data: { id } };
      const after = { ...before, ...(input.patch as Record<string, unknown>), content: input.content };
      return {
        status: "success",
        message: "已准备好经历改写预览。若要写入经历库，请继续执行 update_experience 并确认。",
        data: { before, after },
        visibility: "user_summary",
        actionResult: {
          status: "success",
          actionType: "prepare_update_experience",
          preview: { before, after },
          metadata: {
            nextAction: "update_experience",
            requiresConfirmation: true,
          },
        },
      };
    },
  };
}
