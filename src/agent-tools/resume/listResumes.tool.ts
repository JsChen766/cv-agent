import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ListInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function createListResumesTool(): ToolDefinition {
  return {
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
      return { status: "success", message: `Found ${items.length} resume(s).`, data: { count: items.length, items }, workspacePatch: { activePanel: "resume_history", resumes: items }, visibility: "internal" };
    },
  };
}
