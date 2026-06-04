import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { AcceptGenerationVariantInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function createAcceptGenerationVariantTool(): ToolDefinition {
  return {
    name: "accept_generation_variant",
    description: "Accept a generation variant and save it to the resume.",
    ownerAgent: "architect",
    inputSchema: AcceptGenerationVariantInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "write",
    requiresConfirmation: true,
    riskLevel: "medium",
    execute: async (input, context) => {
      const result = await context.kernel.productServices.generationProductService.saveAcceptedVariantToResume(context.userId, {
        generationId: String(input.generationId),
        variantId: String(input.variantId),
        resumeId: typeof input.resumeId === "string" ? input.resumeId : undefined,
      });
      let activeResume = null;
      try {
        activeResume = await context.kernel.productServices.resumeService.getResume(context.userId, result.resume.id);
      } catch {
        // Fallback: resumeId alone is enough for the frontend to fetch detail
      }
      return {
        status: "success",
        message: "已将选中的版本保存到简历。",
        data: {
          generation: result.generation,
          resume: result.resume,
          item: result.item,
          variant: result.variant,
        },
        workspacePatch: {
          activePanel: "resume_editor",
          resumeId: result.resume.id,
          activeResume: activeResume ?? result.resume,
          active: { resumeId: result.resume.id, variantId: String(input.variantId) },
          status: "accepted",
          summary: "已将选中的版本保存到简历。",
        },
        actionResult: {
          status: "success",
          actionType: "accept_generation_variant",
          variantId: String(input.variantId),
          metadata: {
            generationId: String(input.generationId),
            resumeId: result.resume.id,
          },
        },
        visibility: "user_summary",
      };
    },
  };
}
