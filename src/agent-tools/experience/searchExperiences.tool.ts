import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { SearchInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { searchMatches } from "./helpers.js";

export function searchExperiencesTool(): ToolDefinition {
  return {
    name: "search_experiences",
    description: "Search real product experiences by text.",
    ownerAgent: "experience_receiver",
    inputSchema: SearchInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "read",
    requiresConfirmation: false,
    riskLevel: "low",
    execute: async (input, context) => {
      const query = String(input.query);
      const limit = typeof input.limit === "number" ? input.limit : 20;
      const all = await context.kernel.productServices.experienceService.listExperiences(context.userId, { limit: 200 });
      const items = all.filter((item) => searchMatches(query, item)).slice(0, limit);
      return {
        status: "success",
        message: items.length === 0 ? `No experiences matched "${query}".` : `Found ${items.length} matching experience(s).`,
        data: { count: items.length, items, query },
        workspacePatch: { activePanel: "experience_library", experiences: items },
      };
    },
  };
}
