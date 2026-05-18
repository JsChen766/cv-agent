import { z } from "zod";
import type { ApiKernel } from "../../../api/types.js";
import { CopilotResponseBuilder } from "../../../copilot/CopilotResponseBuilder.js";
import type { AgentToolDefinition } from "../AgentToolTypes.js";
import { findArtifact, inferRevisionInstruction } from "../helpers.js";
import { objectSchema, revisionInstructionSchema } from "../schemas.js";

export function createRevisionTools(kernel: ApiKernel): AgentToolDefinition[] {
  const builder = new CopilotResponseBuilder();
  return [
    {
      name: "revise_variant",
      description: "Revise the active generated variant.",
      schema: z.object({
        variantId: z.string().optional(),
        instruction: revisionInstructionSchema.optional(),
        customInstruction: z.string().optional(),
      }),
      jsonSchema: objectSchema({ variantId: { type: "string" }, instruction: { type: "string" }, customInstruction: { type: "string" } }),
      execute: async (args, context) => {
        const workspace = context.workspace;
        const generationId = workspace?.productGenerationId;
        const variantId = args.variantId ?? context.request.clientState?.activeVariantId ?? workspace?.activeVariantId ?? workspace?.variants[0]?.id;
        if (!generationId || !variantId) {
          return { status: "needs_input", assistantMessage: "请先选择一个要修改的生成版本。" };
        }
        const generation = await kernel.productServices.generationProductService.getGeneration(context.ctx.user.id, generationId);
        const artifact = findArtifact(generation?.outputSnapshot?.variants, variantId, workspace);
        if (!artifact) return { status: "failed", assistantMessage: "没有找到可修改的版本。" };
        const revised = await kernel.cvAgentKernel.generations.reviseArtifact(context.ctx, {
          artifact,
          instruction: args.instruction ?? inferRevisionInstruction(context.request.message),
          customInstruction: args.customInstruction,
        });
        const revisedVariant = builder.buildVariant({ artifact: revised.revisedArtifact, allVariants: [revised.revisedArtifact], targetRole: generation?.targetRole });
        const variants = [...(workspace?.variants ?? []), revisedVariant];
        return {
          status: "success",
          assistantMessage: "已按你的要求生成一个修改版本。",
          timelineItems: [{
            id: `tl-${context.turnId}-revision`,
            type: "revision_completed",
            title: "Revision completed",
            status: "completed",
            createdAt: new Date().toISOString(),
            relatedVariantId: revisedVariant.id,
          }],
          workspacePatch: {
            activePanel: "variants",
            variants,
            activeVariantId: revisedVariant.id,
            status: "ready",
          },
          nextActions: revisedVariant.actions,
          rawIds: { artifactIds: [revisedVariant.id] },
        };
      },
    },
  ];
}
