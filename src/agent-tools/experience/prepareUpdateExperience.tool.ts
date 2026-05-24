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
      const patch = sanitizeExperiencePatch(input.patch);
      const hasContent = typeof input.content === "string" && input.content.trim().length > 0;
      const hasPatch = hasPatchFields(patch);
      if (!hasContent && !hasPatch) {
        return {
          status: "needs_input",
          message: "我还没有生成可预览的改写内容，请先生成改写版本。",
          visibility: "error_user_visible",
          actionResult: {
            status: "needs_input",
            actionType: "prepare_update_experience",
            missingInputs: ["content"],
            message: "我还没有生成可预览的改写内容，请先生成改写版本。",
          },
        };
      }
      const id = String(input.experienceId);
      const before = await context.kernel.productServices.experienceService.getExperience(context.userId, id);
      if (!before) return { status: "failed", message: "Experience not found.", data: { id } };
      const after = { ...before, ...patch, ...(hasContent ? { content: input.content as string } : {}) };
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
