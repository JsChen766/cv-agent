import type { ProductExperience } from "../../product/types.js";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ToolResultSchema, UpdateExperienceInputSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { hasPatchFields, sanitizeExperiencePatch } from "../../agent-core/security/ToolPatchSanitizer.js";

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
      const patch = sanitizeExperiencePatch(input.patch) as Partial<ProductExperience>;
      const content = typeof input.content === "string" ? input.content.trim() : "";
      const hasPatch = hasPatchFields(patch);

      if (!hasPatch && !content) {
        return {
          status: "needs_input",
          message: "我还没有生成可写入的改写内容，请先生成改写版本后再确认保存。",
          visibility: "error_user_visible",
          actionResult: {
            status: "needs_input",
            actionType: "update_experience",
            missingInputs: ["content"],
            message: "我还没有生成可写入的改写内容，请先生成改写版本后再确认保存。",
          },
        };
      }

      const updated = await context.kernel.productServices.experienceService.updateExperience(context.userId, id, patch);
      if (!updated) return { status: "failed", message: "Experience not found.", data: { id }, visibility: "error_user_visible" };
      let revision;
      if (content) {
        revision = await context.kernel.productServices.experienceService.createRevision(context.userId, id, {
          content,
          source: "copilot",
        });
      }
      return {
        status: "success",
        message: `Updated experience "${updated.title}".`,
        data: { experience: updated, revision },
        workspacePatch: { activePanel: "experience_library", active: { experienceId: updated.id } },
        visibility: "user_summary",
        actionResult: {
          status: "success",
          actionType: "update_experience",
          experienceId: updated.id,
          revisionSuggestion: revision ? {
            kind: "experience" as const,
            sourceId: updated.id,
            sourceTextPreview: content ? content.slice(0, 200) : undefined,
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
