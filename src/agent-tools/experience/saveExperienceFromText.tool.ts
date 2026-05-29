import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { TextInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { extractExperienceDraftFromText } from "./helpers.js";

export function saveExperienceFromTextTool(): ToolDefinition {
  return {
    name: "save_experience_from_text",
    description: "Save a new experience to the real product experience library.",
    ownerAgent: "experience_receiver",
    inputSchema: TextInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "write",
    requiresConfirmation: true,
    riskLevel: "medium",
    execute: async (input, context) => {
      const draft = extractExperienceDraftFromText(String(input.text));
      const saved = await context.kernel.productServices.experienceService.createExperience(context.userId, {
        title: draft.title,
        category: draft.category,
        content: draft.content,
        organization: draft.organization,
        role: draft.role,
        startDate: draft.startDate,
        endDate: draft.endDate,
        tags: draft.tags,
        structured: draft.structured,
        source: "copilot",
      });
      return {
        status: "success",
        message: `Saved experience "${saved.experience.title}".`,
        data: {
          draft,
          experienceId: saved.experience.id,
          title: saved.experience.title,
          summary: draft.structured.summary,
          warnings: draft.warnings,
          confidence: draft.confidence,
          tags: saved.experience.tags,
          experience: saved.experience,
          revision: saved.revision,
        },
        workspacePatch: { activePanel: "experience_library", activeExperienceId: saved.experience.id, active: { experienceId: saved.experience.id } },
        actionResult: { status: "success", actionType: "save_experience_from_text", experienceId: saved.experience.id },
      };
    },
  };
}
