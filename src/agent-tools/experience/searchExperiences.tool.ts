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
      const results = items.map((item) => ({
        id: item.id,
        title: item.title,
        organization: item.organization,
        role: item.role,
        tags: item.tags,
        contentPreview: typeof item.content === "string" ? item.content.replace(/\s+/g, " ").trim().slice(0, 200) : undefined,
        updatedAt: item.updatedAt,
      }));
      return {
        status: "success",
        message: items.length === 0 ? `No experiences matched "${query}".` : `Found ${items.length} matching experience(s).`,
        data: { count: items.length, results, query },
        visibility: "internal",
        workspacePatch: { activePanel: "experience_library", experiences: items },
        actionResult: {
          status: "success",
          actionType: "search_experiences",
          metadata: { count: items.length, query },
        },
      };
    },
  };
}
