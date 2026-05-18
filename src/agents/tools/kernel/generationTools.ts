import { z } from "zod";
import type { ApiKernel } from "../../../api/types.js";
import { CopilotResponseBuilder } from "../../../copilot/CopilotResponseBuilder.js";
import type { AgentToolDefinition } from "../AgentToolTypes.js";
import { objectSchema } from "../schemas.js";

export function createGenerationTools(kernel: ApiKernel): AgentToolDefinition[] {
  const builder = new CopilotResponseBuilder();
  return [
    {
      name: "generate_resume_variants",
      description: "Generate tailored resume variants from a JD.",
      schema: z.object({
        jdText: z.string().optional(),
        jdId: z.string().optional(),
        targetRole: z.string().optional(),
      }),
      jsonSchema: objectSchema({ jdText: { type: "string" }, jdId: { type: "string" }, targetRole: { type: "string" } }),
      execute: async (args, context) => {
        const jdText = args.jdText ?? context.session.jdText ?? context.request.jdText;
        if (!args.jdId && !jdText?.trim()) {
          return { status: "needs_input", assistantMessage: "请先提供 JD 文本，或选择一个历史 JD。" };
        }
        const targetRole = args.targetRole ?? context.session.targetRole ?? context.request.targetRole ?? "Target Role";
        const result = await kernel.productServices.generationProductService.generateResumeFromJD(context.ctx, {
          userId: context.ctx.user.id,
          sessionId: context.session.id,
          jdId: args.jdId,
          jdText,
          targetRole,
        });
        const response = builder.buildChatResponse({
          sessionId: context.session.id,
          turnId: context.turnId,
          userMessage: context.request.message,
          generatedArtifacts: result.variants,
          critiqueItems: result.generationResult.critiqueReport.items,
          evidenceChains: result.generationResult.evidenceChains,
          targetRole,
          clientState: context.request.clientState ?? {},
        });
        return {
          status: "success",
          assistantMessage: response.assistantMessage.content,
          timelineItems: response.timeline,
          workspacePatch: {
            ...response.workspace,
            activePanel: "variants",
            productGenerationId: result.generation.id,
            jdId: result.jd.id,
          },
          nextActions: response.nextActions,
          rawIds: {
            artifactIds: response.raw.artifactIds,
            evidenceChainIds: response.raw.evidenceChainIds,
            critiqueItemIds: response.raw.critiqueItemIds,
            decisionIds: [result.generation.id],
          },
        };
      },
    },
  ];
}
