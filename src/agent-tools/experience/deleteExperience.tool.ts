import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { DeleteExperienceInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function deleteExperienceTool(): ToolDefinition {
  return {
    name: "delete_experience",
    description: "Archive a real product experience after confirmation.",
    ownerAgent: "experience_receiver",
    inputSchema: DeleteExperienceInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "delete",
    requiresConfirmation: true,
    riskLevel: "medium",
    execute: async (input, context) => {
      const id = String(input.experienceId);
      const archived = await context.kernel.productServices.experienceService.archiveExperience(context.userId, id);
      if (!archived) return { status: "failed", message: "Experience not found.", data: { id } };
      return {
        status: "success",
        message: `Deleted experience "${archived.title}".`,
        data: { experienceId: archived.id, title: archived.title },
        workspacePatch: { activePanel: "experience_library" },
        actionResult: { status: "success", actionType: "delete_experience", experienceId: archived.id },
      };
    },
  };
}
