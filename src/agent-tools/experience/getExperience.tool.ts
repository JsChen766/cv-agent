import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { IdInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function getExperienceTool(): ToolDefinition {
  return {
    name: "get_experience",
    description: "Get an experience and its current/latest revision.",
    ownerAgent: "experience_receiver",
    inputSchema: IdInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "read",
    requiresConfirmation: false,
    riskLevel: "low",
    execute: async (input, context) => {
      const id = String(input.id);
      const experience = await context.kernel.productServices.experienceService.getExperience(context.userId, id);
      if (!experience) return { status: "failed", message: "Experience not found.", data: { id }, visibility: "error_user_visible" };
      const revisions = await context.kernel.productServices.experienceService.listRevisions(context.userId, id);
      const current = revisions.find((revision) => revision.id === experience.currentRevisionId) ?? revisions.at(-1);
      return {
        status: "success",
        message: `Loaded experience: ${experience.title}.`,
        data: { experience, currentRevision: current, revisions },
        workspacePatch: { activePanel: "experience_library", active: { experienceId: experience.id } },
        visibility: "internal",
      };
    },
  };
}
