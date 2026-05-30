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
  // Idempotency guard: check for recently-saved duplicate before inserting.
  // Prevents the same experience from being saved twice in quick succession
  // (e.g. double-confirm, frontend re-render, or agent re-invocation).
  const recent = await context.kernel.productServices.experienceService.listExperiences(context.userId, { limit: 20, status: "active" });
  const duplicate = recent.find((exp) => {
    if (exp.title !== draft.title) return false;
    // Also match on content prefix to avoid false positives on generic titles
    const expContent = (exp as { content?: string }).content;
    if (expContent && draft.content) {
      const a = expContent.replace(/\s+/g, "").slice(0, 120);
      const b = draft.content.replace(/\s+/g, "").slice(0, 120);
      if (a !== b) return false;
    }
    return true;
  });
  if (duplicate) {
    return {
      status: "success",
      message: `Experience "${duplicate.title}" already saved. No duplicate was created.`,
      data: {
        experienceId: duplicate.id,
        title: duplicate.title,
        alreadySaved: true,
      },
      workspacePatch: { activePanel: "experience_library", activeExperienceId: duplicate.id, active: { experienceId: duplicate.id } },
      actionResult: {
        status: "success",
        actionType: "save_experience_from_text",
        experienceId: duplicate.id,
        reason: "duplicate_prevented",
        message: `Experience "${duplicate.title}" already saved.`,
      },
    };
  }

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

      // If a structured candidate was passed from the prepare phase, use it directly.
      // This avoids re-extracting from raw text and ensures the confirmed data
      // matches the LLM-structured preview the user saw.
      const candidate = isRecord(input.candidate) ? candidateToDraftLike(input.candidate) : null;
      if (candidate) {
        return saveExperience(candidate, context);
      }

      const llmExtractor = context.kernel.llmExperienceExtractor;

      // Primary path: LLM extraction
      if (llmExtractor) {
        const candidates = await llmExtractor.extractCandidates(text);
        if (candidates.length > 0) {
          const draft = extractedCandidateToDraft(candidates[0]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Convert a structured candidate object (from prepare_save_experience_from_text)
 * into a DraftLike shape for saveExperience().
 */
function candidateToDraftLike(candidate: Record<string, unknown>): DraftLike | null {
  const title = typeof candidate.title === "string" ? candidate.title : "";
  const content = typeof candidate.content === "string" ? candidate.content : "";
  if (!title || !content) return null;

  return {
    category: (typeof candidate.category === "string" ? candidate.category : "other") as DraftLike["category"],
    title,
    organization: typeof candidate.organization === "string" ? candidate.organization : undefined,
    role: typeof candidate.role === "string" ? candidate.role : undefined,
    startDate: typeof candidate.startDate === "string" ? candidate.startDate : undefined,
    endDate: typeof candidate.endDate === "string" ? candidate.endDate : undefined,
    content,
    tags: Array.isArray(candidate.tags) ? candidate.tags.filter((t): t is string => typeof t === "string") : [],
    structured: (isRecord(candidate.structured) ? candidate.structured : { rawText: content }) as DraftLike["structured"],
    confidence: typeof candidate.confidence === "number" ? candidate.confidence : 0.5,
    warnings: Array.isArray(candidate.warnings) ? candidate.warnings.filter((w): w is string => typeof w === "string") : [],
  };
}
