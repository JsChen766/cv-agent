import type { ProductExperience, ProductExperienceRevision } from "../../product/types.js";
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
      const rawPatch = sanitizeExperiencePatch(input.patch);
      const structured = isRecord(rawPatch.structured) ? rawPatch.structured : undefined;
      const { structured: _structured, ...experiencePatch } = rawPatch;
      const patch = experiencePatch as Partial<ProductExperience>;
      const content = typeof input.content === "string" ? input.content.trim() : "";
      const hasPatch = hasPatchFields(rawPatch);

      if (!hasPatch && !content) {
        return {
          status: "needs_input",
          message: "请先提供要改写的内容或更新字段。",
          visibility: "error_user_visible",
          actionResult: {
            status: "needs_input",
            actionType: "update_experience",
            missingInputs: ["content"],
            message: "请先提供要改写的内容或更新字段。",
          },
        };
      }

      const updated = await context.kernel.productServices.experienceService.updateExperience(context.userId, id, patch);
      if (!updated) return { status: "failed", message: "Experience not found.", data: { id }, visibility: "error_user_visible" };

      let revision: ProductExperienceRevision | undefined;

      if (content || structured) {
        const revisions = await context.kernel.productServices.experienceService.listRevisions(context.userId, id);
        const current = updated.currentRevisionId
          ? revisions.find((item) => item.id === updated.currentRevisionId)
          : revisions.at(0);
        const originalContent = current?.content ?? "";

        revision = await context.kernel.productServices.experienceService.createRevision(context.userId, id, {
          content: content || current?.content || "",
          structured,
          source: "copilot",
        });

        return {
          status: "success",
          message: `Updated experience "${updated.title}".`,
          data: { experience: updated, revision },
          workspacePatch: { activePanel: "experience_library", activeExperienceId: updated.id, active: { experienceId: updated.id } },
          visibility: "user_summary",
          actionResult: {
            status: "success",
            actionType: "update_experience",
            experienceId: updated.id,
            revisionSuggestion: {
              kind: "experience" as const,
              sourceId: updated.id,
              sourceTextPreview: originalContent.slice(0, 200),
              rewrittenText: revision.content,
              usedModel: true,
            },
            metadata: {
              experienceId: updated.id,
              revisionId: revision.id,
            },
          },
        };
      }

      return {
        status: "success",
        message: `Updated experience "${updated.title}".`,
        data: { experience: updated },
        workspacePatch: { activePanel: "experience_library", activeExperienceId: updated.id, active: { experienceId: updated.id } },
        visibility: "user_summary",
        actionResult: {
          status: "success",
          actionType: "update_experience",
          experienceId: updated.id,
          metadata: { experienceId: updated.id },
        },
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
