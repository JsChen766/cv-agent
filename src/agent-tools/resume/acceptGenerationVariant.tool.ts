import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import type { ToolResultEntity, ToolResultNextActionHint } from "../../agent-core/tools/ToolResult.js";
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

      // ── Phase 1 structured payload (additive; legacy fields untouched) ──
      const summaryFacts: string[] = [
        `Variant ${result.variant.id} accepted into resume ${result.resume.id}.`,
        `Generation: ${result.generation.id}.`,
        activeResume?.items?.length !== undefined
          ? `Resume now has ${activeResume.items.length} item(s).`
          : "Resume detail not loaded; downstream consumers should fetch it.",
      ];
      const entities: ToolResultEntity[] = [
        {
          type: "resume",
          id: result.resume.id,
          title: result.resume.title,
          data: { targetRole: result.resume.targetRole, jdId: result.resume.jdId },
        },
        {
          type: "resume_variant",
          id: String(input.variantId),
          data: { generationId: String(input.generationId) },
        },
        {
          type: "resume_item",
          id: result.item.id,
          title: result.item.title,
          data: { resumeId: result.resume.id },
        },
      ];
      const nextActionHints: ToolResultNextActionHint[] = [
        {
          type: "export_resume",
          label: "Export this resume",
          payload: { resumeId: result.resume.id, format: "pdf" },
        },
        {
          type: "open_resume_editor",
          label: "Open in resume editor",
          payload: { resumeId: result.resume.id },
        },
      ];

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
            variantId: String(input.variantId),
            nextAction: "export_resume",
          },
        },
        visibility: "user_summary",
        resultKind: "variant_accepted",
        summaryFacts,
        entities,
        nextActionHints,
      };
    },
  };
}
