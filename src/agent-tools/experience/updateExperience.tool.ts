import type { ProductExperience } from "../../product/types.js";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ToolResultSchema, UpdateExperienceInputSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function updateExperienceTool(): ToolDefinition {
  return {
    name: "update_experience",
    description: "Update a real product experience and optionally create a new revision.",
    ownerAgent: "experience_receiver",
    inputSchema: UpdateExperienceInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "write",
    requiresConfirmation: true,
    riskLevel: "medium",
    execute: async (input, context) => {
      const id = String(input.experienceId);
      const patch = input.patch as Partial<ProductExperience>;
      const updated = await context.kernel.productServices.experienceService.updateExperience(context.userId, id, patch);
      if (!updated) return { status: "failed", message: "Experience not found.", data: { id } };
      let revision;
      if (typeof input.content === "string" && input.content.trim()) {
        revision = await context.kernel.productServices.experienceService.createRevision(context.userId, id, {
          content: input.content,
          source: "copilot",
        });
      }
      return {
        status: "success",
        message: `Updated experience "${updated.title}".`,
        data: { experience: updated, revision },
        workspacePatch: { activePanel: "experience_library", activeExperienceId: updated.id },
        actionResult: {
          status: "success",
          actionType: "update_experience",
          experienceId: updated.id,
          revisionSuggestion: revision ? {
            kind: "experience" as const,
            sourceId: updated.id,
            sourceTextPreview: typeof input.content === "string" ? input.content.slice(0, 200) : undefined,
            rewrittenText: revision.content,
            usedModel: false,
          } : undefined,
          metadata: {
            experienceId: updated.id,
            revisionId: revision?.id,
          },
        },
      };
    },
  };
}
