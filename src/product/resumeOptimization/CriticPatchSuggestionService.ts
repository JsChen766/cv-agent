import { createHash } from "node:crypto";
import type { ResumeDocument } from "../types.js";
import { cloneResumeDocument } from "./ResumeDraftProjector.js";
import type {
  ResumeCriticPatchSuggestion,
  ResumeCriticReviewItem,
} from "./types.js";

export class CriticPatchSuggestionService {
  public createSuggestions(input: {
    generationId: string;
    changeSetId?: string;
    items: ResumeCriticReviewItem[];
  }): ResumeCriticPatchSuggestion[] {
    return input.items
      .filter((item) => item.autoFixAllowed && item.patch)
      .map((item) => ({
        suggestionId: stableId("rcps", [input.generationId, input.changeSetId ?? "", item.itemId, item.patch!.after]),
        reviewItemId: item.itemId,
        changeSetId: input.changeSetId,
        generationId: input.generationId,
        severity: item.severity,
        autoApply: item.severity === "low" || item.severity === "medium",
        patch: item.patch!,
        rationale: item.suggestedFix,
      }));
  }

  public applySuggestions(input: {
    draft: ResumeDocument;
    suggestions: ResumeCriticPatchSuggestion[];
    autoApplyOnly?: boolean;
  }): ResumeDocument {
    const draft = cloneResumeDocument(input.draft);
    const suggestions = input.autoApplyOnly === false
      ? input.suggestions
      : input.suggestions.filter((suggestion) => suggestion.autoApply);
    for (const suggestion of suggestions) {
      applyPatch(draft, suggestion);
    }
    return draft;
  }
}

function applyPatch(document: ResumeDocument, suggestion: ResumeCriticPatchSuggestion): void {
  const target = suggestion.patch.target;
  for (const section of document.sections) {
    if (target.sectionId && section.id !== target.sectionId) continue;
    for (const item of section.items) {
      if (target.itemId && item.id !== target.itemId) continue;
      for (const bullet of item.bullets) {
        if (target.bulletId && bullet.id !== target.bulletId) continue;
        if (suggestion.patch.before && normalizeText(bullet.text) !== normalizeText(suggestion.patch.before)) continue;
        bullet.text = suggestion.patch.after;
        return;
      }
    }
  }
}

function stableId(prefix: string, parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 16);
  return `${prefix}-${hash}`;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
