import type { ProductExperience } from "../../product/types.js";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ToolResultSchema, UpdateExperienceInputSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { hasPatchFields, sanitizeExperiencePatch } from "../../agent-core/security/ToolPatchSanitizer.js";

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
      const rawPatch = sanitizeExperiencePatch(input.patch);
      const structured = isRecord(rawPatch.structured) ? rawPatch.structured : undefined;
      const { structured: _structured, ...experiencePatch } = rawPatch;
      const patch = experiencePatch as Partial<ProductExperience>;
      const hasContent = typeof input.content === "string" && input.content.trim().length > 0;
      const hasPatch = hasPatchFields(rawPatch);
      if (!hasContent && !hasPatch) {
        return {
          status: "needs_input",
          message: "请先提供要改写的内容或更新字段，再预览改写结果。",
          visibility: "error_user_visible",
          actionResult: {
            status: "needs_input",
            actionType: "prepare_update_experience",
            missingInputs: ["content"],
            message: "请先提供要改写的内容或更新字段，再预览改写结果。",
          },
        };
      }
      const id = String(input.experienceId);
      const before = await context.kernel.productServices.experienceService.getExperience(context.userId, id);
      if (!before) return { status: "failed", message: "Experience not found.", data: { id } };
      const after = {
        ...before,
        ...patch,
        ...(hasContent ? { content: String(input.content).trim() } : {}),
        ...(structured ? { structured } : {}),
      };
      return {
        status: "success",
        message: "Prepared experience update preview.",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
