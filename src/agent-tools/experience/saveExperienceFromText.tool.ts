import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { TextInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { extractExperienceDraftFromText } from "./helpers.js";
import { extractedCandidateToDraft } from "../../product/LLMExperienceExtractor.js";
import { buildNormalizedExperiencePreview } from "../../product/experiencePreview.js";
import type { ProductExperienceCategory } from "../../product/types.js";

function normalizeCategory(raw: string, title: string, role: string | undefined, content: string): ProductExperienceCategory {
  const lower = raw.toLowerCase();
  if (lower.includes("intern")) return "internship";
  const text = `${title} ${role ?? ""} ${content}`.toLowerCase();
  if (lower === "work" && /intern|实习/i.test(text)) return "internship";
  const validCategories: ProductExperienceCategory[] = ["work", "internship", "project", "education", "award", "skill", "other"];
  if (validCategories.includes(lower as ProductExperienceCategory)) return lower as ProductExperienceCategory;
  return "other";
}

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
      const text = String(input.text);

      // Primary path: LLM extraction. Fall back to rule-based if unavailable or fails.
      const llmExtractor = context.kernel.llmExperienceExtractor;
      let extracted: { title: string; category: string; organization?: string; role?: string; startDate?: string; endDate?: string; content: string; tags: string[]; structured: Record<string, unknown>; confidence: number; warnings: string[] };

      if (llmExtractor) {
        try {
          const candidates = await llmExtractor.extractCandidates(text);
          if (candidates.length > 0) {
            const draft = extractedCandidateToDraft(candidates[0]);
            extracted = { ...draft, tags: draft.tags ?? [], warnings: draft.warnings ?? [], confidence: draft.confidence ?? 0.5 };
          } else {
            extracted = extractExperienceDraftFromText(text) as unknown as typeof extracted;
          }
        } catch {
          extracted = extractExperienceDraftFromText(text) as unknown as typeof extracted;
        }
      } else {
        extracted = extractExperienceDraftFromText(text) as unknown as typeof extracted;
      }

      const category = normalizeCategory(extracted.category, extracted.title, extracted.role, extracted.content);
      const saved = await context.kernel.productServices.experienceService.createExperience(context.userId, {
        title: extracted.title,
        category,
        content: extracted.content,
        organization: extracted.organization,
        role: extracted.role,
        startDate: extracted.startDate,
        endDate: extracted.endDate,
        tags: extracted.tags,
        structured: extracted.structured,
        source: "copilot",
      });

      const preview = buildNormalizedExperiencePreview(
        { category, title: extracted.title, content: extracted.content, organization: extracted.organization, role: extracted.role, startDate: extracted.startDate, endDate: extracted.endDate, structured: extracted.structured, confidence: extracted.confidence, warnings: extracted.warnings } as Parameters<typeof buildNormalizedExperiencePreview>[0],
        { id: saved.experience.id, missingFields: extracted.warnings },
      );

      return {
        status: "success",
        message: `Saved experience "${saved.experience.title}".`,
        data: {
          experienceId: saved.experience.id,
          title: saved.experience.title,
          summary: (extracted.structured as Record<string, unknown>)?.summary,
          warnings: extracted.warnings,
          confidence: extracted.confidence,
          tags: saved.experience.tags,
          experience: saved.experience,
          revision: saved.revision,
          experienceDraft: preview,
        },
        workspacePatch: { activePanel: "experience_library", activeExperienceId: saved.experience.id, active: { experienceId: saved.experience.id } },
        actionResult: {
          status: "success",
          actionType: "save_experience_from_text",
          experienceId: saved.experience.id,
          metadata: { experienceDraft: preview },
        },
      };
    },
  };
}
