import { createHash } from "node:crypto";
import { CriticPatchSuggestionService } from "./CriticPatchSuggestionService.js";
import { CriticReviewItemService } from "./CriticReviewItemService.js";
import type {
  JDResumeAnalysisReport,
  LayoutPreviewReport,
  ResumeChangeSet,
  ResumeEditorialCriticReview,
  ResumeOptimizationFindingSeverity,
} from "./types.js";

export class ResumeEditorialCriticService {
  public constructor(
    private readonly reviewItemService: CriticReviewItemService = new CriticReviewItemService(),
    private readonly patchSuggestionService: CriticPatchSuggestionService = new CriticPatchSuggestionService(),
  ) {}

  public review(input: {
    generationId: string;
    analysisReport: JDResumeAnalysisReport;
    changeSet?: ResumeChangeSet;
    layoutPreviewReport?: LayoutPreviewReport;
  }): ResumeEditorialCriticReview {
    const items = this.reviewItemService.createItems(input);
    const patchSuggestions = this.patchSuggestionService.createSuggestions({
      generationId: input.generationId,
      changeSetId: input.changeSet?.changeSetId,
      items,
    });
    const repairedDraft = input.changeSet && patchSuggestions.length > 0
      ? this.patchSuggestionService.applySuggestions({
          draft: input.changeSet.proposedDraft,
          suggestions: patchSuggestions,
        })
      : undefined;
    const needsInputCount = items.filter((item) => item.nextAction && !item.autoFixAllowed).length;
    const status: ResumeEditorialCriticReview["status"] = patchSuggestions.length > 0
      ? "patch_suggested"
      : needsInputCount > 0
        ? "needs_input"
        : "pass";
    return {
      schemaVersion: 1,
      reviewId: stableId("recr", [input.generationId, input.changeSet?.changeSetId ?? "", input.analysisReport.rubricVersion]),
      generationId: input.generationId,
      changeSetId: input.changeSet?.changeSetId,
      createdAt: new Date().toISOString(),
      status,
      summary: {
        totalItems: items.length,
        autoFixableCount: patchSuggestions.length,
        needsInputCount,
        highestSeverity: highestSeverity(items.map((item) => item.severity)),
        label: labelFor(status, items.length, patchSuggestions.length, needsInputCount),
      },
      items,
      patchSuggestions,
      repairedDraft,
    };
  }
}

function labelFor(
  status: ResumeEditorialCriticReview["status"],
  itemCount: number,
  patchCount: number,
  needsInputCount: number,
): string {
  if (status === "pass") return "Editorial critic found no blocking issues";
  if (patchCount > 0) return `${patchCount} critic patch suggestion${patchCount === 1 ? "" : "s"} ready`;
  return `${needsInputCount || itemCount} critic item${(needsInputCount || itemCount) === 1 ? "" : "s"} need user input`;
}

function highestSeverity(values: ResumeOptimizationFindingSeverity[]): ResumeOptimizationFindingSeverity | undefined {
  const ordered: ResumeOptimizationFindingSeverity[] = ["critical", "high", "medium", "low"];
  return ordered.find((severity) => values.includes(severity));
}

function stableId(prefix: string, parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 16);
  return `${prefix}-${hash}`;
}
