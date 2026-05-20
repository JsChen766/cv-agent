import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { IdInputSchema, JDInputSchema, ListInputSchema, TextInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function createJDAgentTools(): ToolDefinition[] {
  return [
    {
      name: "list_jds",
      description: "List saved JD records.",
      ownerAgent: "strategist",
      inputSchema: ListInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const items = await context.kernel.productServices.jdService.listJDs(context.userId, typeof input.limit === "number" ? input.limit : 50);
        return { status: "success", message: `Found ${items.length} JD(s).`, data: { count: items.length, items }, workspacePatch: { activePanel: "jd_library", jds: items } };
      },
    },
    {
      name: "get_jd",
      description: "Get a saved JD record.",
      ownerAgent: "strategist",
      inputSchema: IdInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const jd = await context.kernel.productServices.jdService.getJD(context.userId, String(input.id));
        return jd
          ? { status: "success", message: `Loaded JD "${jd.title}".`, data: { jd }, workspacePatch: { activePanel: "jd_library", jdId: jd.id } }
          : { status: "failed", message: "JD not found.", data: { id: input.id } };
      },
    },
    {
      name: "prepare_save_jd_from_text",
      description: "Preview saving JD text.",
      ownerAgent: "strategist",
      inputSchema: TextInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input) => ({ status: "success", message: "Prepared JD save for confirmation.", data: { preview: { rawText: input.text } } }),
    },
    {
      name: "save_jd_from_text",
      description: "Save a JD record.",
      ownerAgent: "strategist",
      inputSchema: JDInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "write",
      requiresConfirmation: true,
      riskLevel: "medium",
      execute: async (input, context) => {
        const jd = await context.kernel.productServices.jdService.saveJD(context.userId, {
          rawText: String(input.text),
          title: typeof input.title === "string" ? input.title : undefined,
          company: typeof input.company === "string" ? input.company : undefined,
          targetRole: typeof input.targetRole === "string" ? input.targetRole : undefined,
        });
        return { status: "success", message: `Saved JD "${jd.title}".`, data: { jd }, workspacePatch: { activePanel: "jd_library", jdId: jd.id } };
      },
    },
  ];
}
