import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { TextInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { extractExperienceDraftFromText } from "./helpers.js";
import { extractedCandidateToDraft } from "../../product/LLMExperienceExtractor.js";
import { buildNormalizedExperiencePreview } from "../../product/experiencePreview.js";
import type { ProductExperienceCategory } from "../../product/types.js";
import { isDeterministicFallbackAllowed, llmNotAvailableResult } from "../../product/deterministicFallbackGuard.js";
import type { AgentContext } from "../../agent-core/runtime/AgentContext.js";
import type { ToolResult } from "../../agent-core/tools/ToolResult.js";

function normalizeCategory(raw: string, title: string, role: string | undefined, content: string): ProductExperienceCategory {
  const lower = raw.toLowerCase();
  if (lower.includes("intern")) return "internship";
  const text = `${title} ${role ?? ""} ${content}`.toLowerCase();
  if (lower === "work" && /intern|实习/i.test(text)) return "internship";
  const validCategories: ProductExperienceCategory[] = ["work", "internship", "project", "education", "award", "skill", "other"];
  if (validCategories.includes(lower as ProductExperienceCategory)) return lower as ProductExperienceCategory;
  return "other";
}

type DraftLike = ReturnType<typeof extractExperienceDraftFromText>;

async function saveExperience(
  draft: DraftLike,
  context: AgentContext,
): Promise<ToolResult> {
  const category = normalizeCategory(draft.category ?? "other", draft.title, draft.role, draft.content);
  const saved = await context.kernel.productServices.experienceService.createExperience(context.userId, {
    title: draft.title,
    category,
    content: draft.content,
    organization: draft.organization,
    role: draft.role,
    startDate: draft.startDate,
    endDate: draft.endDate,
    tags: draft.tags,
    structured: draft.structured,
    source: "copilot",
  });

  const preview = buildNormalizedExperiencePreview(draft, {
    id: saved.experience.id,
    missingFields: draft.warnings,
  });

  return {
    status: "success",
    message: `Saved experience "${saved.experience.title}".`,
    data: {
      experienceId: saved.experience.id,
      title: saved.experience.title,
      summary: (draft.structured as Record<string, unknown>)?.summary,
      warnings: draft.warnings,
      confidence: draft.confidence,
      tags: saved.experience.tags,
      experience: saved.experience,
      revision: saved.revision,
      experienceDraft: preview,
      draft,
    },
    workspacePatch: { activePanel: "experience_library", activeExperienceId: saved.experience.id, active: { experienceId: saved.experience.id } },
    actionResult: {
      status: "success",
      actionType: "save_experience_from_text",
      experienceId: saved.experience.id,
      metadata: { experienceDraft: preview },
    },
  };
}

export function saveExperienceFromTextTool(): ToolDefinition {
  return {
    name: "save_experience_from_text",
    description: "Save a new experience to the real product experience library. Uses AI to extract structured experience from free text.",
    ownerAgent: "experience_receiver",
    inputSchema: TextInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "write",
    requiresConfirmation: true,
    riskLevel: "medium",
    execute: async (input, context) => {
      const text = String(input.text);
      const llmExtractor = context.kernel.llmExperienceExtractor;

      // Primary path: LLM extraction
      if (llmExtractor) {
        const candidates = await llmExtractor.extractCandidates(text);
        if (candidates.length > 0) {
          const draft = extractedCandidateToDraft(candidates[0]);
          // Convert to DraftLike shape
          const draftLike: DraftLike = {
            category: draft.category,
            title: draft.title,
            organization: draft.organization,
            role: draft.role,
            startDate: draft.startDate,
            endDate: draft.endDate,
            content: draft.content,
            tags: draft.tags,
            structured: draft.structured as DraftLike["structured"],
            confidence: draft.confidence,
            warnings: draft.warnings,
          };
          return saveExperience(draftLike, context);
        }
        // LLM returned no candidates
        if (!isDeterministicFallbackAllowed()) {
          return { status: "needs_input", message: "AI model could not extract any experience from this text. Please provide more structured content.", visibility: "error_user_visible", actionResult: { status: "needs_input", actionType: "save_experience_from_text", reason: "llm_not_available", message: "AI model could not extract any experience from this text." } };
        }
      } else {
        // No LLM extractor available
        if (!isDeterministicFallbackAllowed()) {
          return llmNotAvailableResult("save_experience_from_text");
        }
      }

      // Deterministic fallback: rule-based extraction (test mode only)
      return saveExperience(extractExperienceDraftFromText(text), context);
    },
  };
}
