import { z } from "zod";
import type { ApiKernel } from "../../../api/types.js";
import type { AgentToolDefinition } from "../AgentToolTypes.js";
import { markVariantStatus } from "../helpers.js";
import { objectSchema } from "../schemas.js";

export function createResumeTools(kernel: ApiKernel): AgentToolDefinition[] {
  return [
    {
      name: "list_resumes",
      description: "List saved resume drafts.",
      schema: z.object({ limit: z.number().int().positive().optional() }),
      jsonSchema: objectSchema({ limit: { type: "number" } }),
      execute: async (args, context) => {
        const resumes = await kernel.productServices.resumeService.listResumes(context.ctx.user.id, args.limit);
        return {
          status: "success",
          assistantMessage: resumes.length > 0 ? `找到 ${resumes.length} 份历史简历。` : "还没有历史简历。",
          workspacePatch: { activePanel: "resume_history", resumes },
          rawIds: { decisionIds: resumes.map((item) => item.id) },
        };
      },
    },
    {
      name: "open_resume",
      description: "Open a saved resume draft.",
      schema: z.object({ resumeId: z.string().min(1) }),
      jsonSchema: objectSchema({ resumeId: { type: "string" } }, ["resumeId"]),
      execute: async (args, context) => {
        const resume = await kernel.productServices.resumeService.getResume(context.ctx.user.id, args.resumeId);
        if (!resume) return { status: "failed", assistantMessage: "没有找到这份简历。" };
        return {
          status: "success",
          assistantMessage: `已打开简历：${resume.title}`,
          workspacePatch: { activePanel: "resume_editor", activeResume: resume, resumeId: resume.id },
          rawIds: { decisionIds: [resume.id] },
        };
      },
    },
    {
      name: "save_variant_to_resume",
      description: "Save a generated variant into the resume editor.",
      schema: z.object({
        generationId: z.string().optional(),
        variantId: z.string().optional(),
        resumeId: z.string().optional(),
      }),
      jsonSchema: objectSchema({ generationId: { type: "string" }, variantId: { type: "string" }, resumeId: { type: "string" } }),
      execute: async (args, context) => {
        const generationId = args.generationId ?? context.workspace?.productGenerationId ?? undefined;
        const variantId = args.variantId ?? context.request.clientState?.activeVariantId ?? context.workspace?.activeVariantId ?? context.workspace?.variants[0]?.id;
        if (!generationId || !variantId) {
          return { status: "needs_input", assistantMessage: "请告诉我采用哪一个生成版本。" };
        }
        const result = await kernel.productServices.generationProductService.saveAcceptedVariantToResume(context.ctx.user.id, {
          generationId,
          variantId,
          resumeId: args.resumeId ?? context.workspace?.resumeId ?? undefined,
        });
        return {
          status: "success",
          assistantMessage: "已采用这个版本，并保存到当前简历草稿。",
          timelineItems: [{
            id: `tl-${context.turnId}-decision`,
            type: "decision_recorded",
            title: "Variant accepted",
            status: "completed",
            createdAt: new Date().toISOString(),
            relatedVariantId: variantId,
          }],
          workspacePatch: {
            activePanel: "resume_editor",
            activeResume: { ...result.resume, items: [result.item] },
            resumeId: result.resume.id,
            status: "accepted",
            variants: markVariantStatus(context.workspace?.variants ?? [], variantId, "accepted"),
          },
          rawIds: { artifactIds: [variantId], decisionIds: [result.resume.id, result.generation.id] },
        };
      },
    },
  ];
}
