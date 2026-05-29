import { z } from "zod";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

const MatchExperienceInputSchema = z.object({
  experienceId: z.string().min(1),
  jdId: z.string().optional(),
  jdText: z.string().optional(),
}).passthrough();

export function matchExperienceTool(): ToolDefinition {
  return {
    name: "match_experience",
    description: "Match one experience against a JD and return a concise fit summary.",
    ownerAgent: "experience_receiver",
    inputSchema: MatchExperienceInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "read",
    requiresConfirmation: false,
    riskLevel: "low",
    execute: async (input, context) => {
      const experienceId = String(input.experienceId);
      const experience = await context.kernel.productServices.experienceService.getExperience(context.userId, experienceId);
      if (!experience) {
        return {
          status: "failed",
          message: "Experience not found.",
          visibility: "error_user_visible",
          actionResult: { actionType: "match_experience", status: "failed", reason: "experience_not_found" },
        };
      }

      const jdText = typeof input.jdText === "string" ? input.jdText.trim() : "";
      const jdId = typeof input.jdId === "string" ? input.jdId : undefined;
      const jd = jdId ? await context.kernel.productServices.jdService.getJD(context.userId, jdId) : null;
      const targetText = jdText || jd?.rawText || "";
      if (!targetText) {
        return {
          status: "needs_input",
          message: "Please provide JD text (or select a JD) before matching.",
          visibility: "error_user_visible",
          actionResult: {
            actionType: "match_experience",
            status: "needs_input",
            missingInputs: ["jdId", "jdText"],
          },
        };
      }

      const revisions = await context.kernel.productServices.experienceService.listRevisions(context.userId, experience.id);
      const currentRevision = experience.currentRevisionId
        ? revisions.find((item) => item.id === experience.currentRevisionId)
        : revisions.at(0);
      const expText = `${experience.title} ${experience.organization ?? ""} ${experience.role ?? ""} ${currentRevision?.content ?? ""}`.toLowerCase();
      const jdWords = uniqueWords(targetText.toLowerCase());
      const matched = jdWords.filter((word) => expText.includes(word)).slice(0, 20);
      const score = jdWords.length > 0 ? Number((matched.length / jdWords.length).toFixed(2)) : 0;
      const summary = score >= 0.6
        ? "High overlap with the current JD."
        : score >= 0.35
          ? "Partial overlap with the current JD."
          : "Low overlap. Consider rewriting this experience for the JD.";

      return {
        status: "success",
        message: summary,
        data: {
          experienceId: experience.id,
          jdId: jd?.id ?? jdId,
          score,
          matchedKeywords: matched,
          summary,
        },
        workspacePatch: { activePanel: "experience_library", activeExperienceId: experience.id, active: { experienceId: experience.id } },
        actionResult: {
          actionType: "match_experience",
          status: "success",
          metadata: { experienceId: experience.id, jdId: jd?.id ?? jdId, score },
        },
      };
    },
  };
}

function uniqueWords(text: string): string[] {
  const words = text
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
  return Array.from(new Set(words)).slice(0, 120);
}
