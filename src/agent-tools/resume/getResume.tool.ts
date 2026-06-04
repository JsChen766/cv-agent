import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { IdInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function createGetResumeTool(): ToolDefinition {
  return {
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
        ? { status: "success", message: `Loaded resume "${resume.title}".`, data: { resume }, workspacePatch: { activePanel: "resume_editor", resumeId: resume.id, activeResume: resume, active: { resumeId: resume.id } }, visibility: "internal" }
        : { status: "failed", message: "Resume not found.", data: { id: input.id }, visibility: "error_user_visible" };
    },
  };
}
