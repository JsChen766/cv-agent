import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { GenerateResumeInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { toWorkspaceVariant } from "./helpers.js";

export function createGenerateResumeFromJDTool(): ToolDefinition {
  return {
    name: "generate_resume_from_jd",
    description: "Generate resume variants from a JD.",
    ownerAgent: "architect",
    inputSchema: GenerateResumeInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "write",
    requiresConfirmation: true,
    riskLevel: "medium",
    execute: async (input, context) => {
      const result = await context.kernel.productServices.generationProductService.generateResumeFromJD({
        userId: context.userId,
        sessionId: context.sessionId,
        jdId: typeof input.jdId === "string" ? input.jdId : undefined,
        jdText: typeof input.jdText === "string" ? input.jdText : undefined,
        targetRole: typeof input.targetRole === "string" ? input.targetRole : undefined,
      });
      const variants = result.variants.map((variant, index) => toWorkspaceVariant(variant, result.jd, result.generation.id, index));
      return {
        status: "success",
        message: `已基于 JD 生成 ${variants.length} 个简历版本。请选择一个版本保存为简历，之后可以导出文件。`,
        data: {
          generationId: result.generation.id,
          jd: result.jd,
          variants,
          generation: result.generation,
        },
        workspacePatch: {
          activePanel: "variants",
          productGenerationId: result.generation.id,
          jdId: result.jd.id,
          active: { jdId: result.jd.id, variantId: variants[0]?.id ?? undefined },
          activeVariantId: variants[0]?.id ?? null,
          variants,
          status: "ready",
          summary: `已生成 ${variants.length} 个 JD 简历版本。`,
        },
        actionResult: {
          status: "success",
          actionType: "generate_resume_from_jd",
          variantId: variants[0]?.id,
          metadata: {
            generationId: result.generation.id,
            variantCount: variants.length,
          },
        },
        visibility: "user_summary",
      };
    },
  };
}
