import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { GenerateResumeInputSchema, IdInputSchema, ListInputSchema, ReviseResumeItemInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function createResumeAgentTools(): ToolDefinition[] {
  return [
    {
      name: "list_resumes",
      description: "List saved product resumes.",
      ownerAgent: "architect",
      inputSchema: ListInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const items = await context.kernel.productServices.resumeService.listResumes(context.userId, typeof input.limit === "number" ? input.limit : 50);
        return { status: "success", message: `Found ${items.length} resume(s).`, data: { count: items.length, items }, workspacePatch: { activePanel: "resume_history", resumes: items } };
      },
    },
    {
      name: "get_resume",
      description: "Get a resume with items.",
      ownerAgent: "architect",
      inputSchema: IdInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const resume = await context.kernel.productServices.resumeService.getResume(context.userId, String(input.id));
        return resume
          ? { status: "success", message: `Loaded resume "${resume.title}".`, data: { resume }, workspacePatch: { activePanel: "resume_editor", resumeId: resume.id, activeResume: resume } }
          : { status: "failed", message: "Resume not found.", data: { id: input.id } };
      },
    },
    {
      name: "generate_resume_from_jd",
      description: "Generate resume variants from a JD.",
      ownerAgent: "architect",
      inputSchema: GenerateResumeInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "write",
      requiresConfirmation: true,
      riskLevel: "medium",
      execute: async (input, context) => {
        const result = await context.kernel.productServices.generationProductService.generateResumeFromJD(context.requestContext, {
          userId: context.userId,
          sessionId: context.sessionId,
          jdId: typeof input.jdId === "string" ? input.jdId : undefined,
          jdText: typeof input.jdText === "string" ? input.jdText : undefined,
          targetRole: typeof input.targetRole === "string" ? input.targetRole : undefined,
        });
        return {
          status: "success",
          message: `Generated ${result.variants.length} resume variant(s).`,
          data: result,
          workspacePatch: { activePanel: "variants", productGenerationId: result.generation.id, jdId: result.jd.id },
        };
      },
    },
    {
      name: "revise_resume_item",
      description: "Revise a resume item after confirmation.",
      ownerAgent: "architect",
      inputSchema: ReviseResumeItemInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "write",
      requiresConfirmation: true,
      riskLevel: "medium",
      execute: async (input, context) => {
        const updated = await context.kernel.productServices.resumeService.updateResumeItem(context.userId, String(input.resumeItemId), {
          contentSnapshot: String(input.instruction),
        });
        return updated
          ? { status: "success", message: "Updated resume item.", data: { item: updated }, workspacePatch: { activePanel: "resume_editor" } }
          : { status: "failed", message: "Resume item not found.", data: { id: input.resumeItemId } };
      },
    },
  ];
}
