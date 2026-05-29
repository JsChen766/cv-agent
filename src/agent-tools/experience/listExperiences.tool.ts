import { z } from "zod";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ListInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function listExperiencesTool(): ToolDefinition {
  return {
    name: "list_experiences",
    description: "List real product experience records for the current user.",
    ownerAgent: "experience_receiver",
    inputSchema: ListInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "read",
    requiresConfirmation: false,
    riskLevel: "low",
    execute: async (input, context) => {
      const limit = typeof input.limit === "number" ? input.limit : 50;
      const items = await context.kernel.productServices.experienceService.listExperiences(context.userId, { limit });
      return {
        status: "success",
        message: items.length === 0 ? "Your experience library is empty." : `Your experience library has ${items.length} item(s).`,
        data: { count: items.length, items },
        workspacePatch: { activePanel: "experience_library", experiences: items },
        visibility: "internal",
        actionResult: {
          status: "success",
          actionType: "list_experiences",
          metadata: { count: items.length },
        },
      };
    },
  };
}
