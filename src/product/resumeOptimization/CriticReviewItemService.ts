import { createHash } from "node:crypto";
import type { ResumeDocument } from "../types.js";
import type {
  JDResumeAnalysisReport,
  LayoutPreviewReport,
  ResumeChangeSet,
  ResumeCriticFindingCategory,
  ResumeCriticReviewItem,
  ResumeOptimizationFindingSeverity,
  ResumeOptimizationReportFinding,
  ResumeOptimizationRubricDimension,
  ResumeOptimizationTarget,
} from "./types.js";

export class CriticReviewItemService {
  public createItems(input: {
    generationId: string;
    analysisReport: JDResumeAnalysisReport;
    changeSet?: ResumeChangeSet;
    layoutPreviewReport?: LayoutPreviewReport;
  }): ResumeCriticReviewItem[] {
    const items: ResumeCriticReviewItem[] = [];
    for (const finding of input.analysisReport.findings) {
      items.push(itemFromAnalysisFinding({
        generationId: input.generationId,
        finding,
        changeSet: input.changeSet,
      }));
    }
    if (input.changeSet) {
      items.push(...itemsFromChangeSet(input.generationId, input.changeSet));
      items.push(...itemsFromDraftText(input.generationId, input.changeSet.proposedDraft));
    }
    if (input.layoutPreviewReport) {
      items.push(...itemsFromLayoutReport(input.generationId, input.layoutPreviewReport));
    }
    return dedupeItems(items).sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
  }
}

function itemFromAnalysisFinding(input: {
  generationId: string;
  finding: ResumeOptimizationReportFinding;
  changeSet?: ResumeChangeSet;
}): ResumeCriticReviewItem {
  const category = categoryForDimension(input.finding.dimension, input.finding.message);
  const patchChange = input.changeSet?.changes.find((change) =>
    sameTarget(change.target, input.finding.target)
    && change.status === "pending"
    && change.riskLevel !== "high"
    && change.riskLevel !== "critical"
    && change.evidenceIds.length > 0
  );
  const needsEvidence = (category === "unsupported_claim" || category === "inflated_metric")
    && (input.finding.recommendedAction === "ask_user"
    || input.finding.recommendedAction === "verify"
    || input.finding.evidenceIds.length === 0);
  const patch = patchChange
    ? {
        type: patchChange.type,
        target: patchChange.target,
        before: patchChange.before,
        after: patchChange.after,
      }
    : undefined;
  return {
    itemId: stableId("rcri", [input.generationId, input.finding.id, category]),
    category,
    severity: input.finding.severity,
    target: input.finding.target ?? {},
    explanation: input.finding.message,
    evidenceIds: [...input.finding.evidenceIds],
    suggestedFix: patch
      ? `Apply the prepared local rewrite for ${category.replace(/_/g, " ")}.`
      : suggestionForCategory(category, needsEvidence),
    autoFixAllowed: Boolean(patch) && !needsEvidence,
    patch,
    nextAction: needsEvidence
      ? {
          type: "provide_critic_evidence",
          label: "Provide evidence or approve omission for this critic item",
          payload: {
            findingId: input.finding.id,
            category,
            requirementIds: input.finding.requirementIds,
          },
        }
      : category === "layout_risk"
        ? {
            type: "retry_layout_check",
            label: "Rerun layout check after editing",
            payload: {
              findingId: input.finding.id,
              category,
              requirementIds: input.finding.requirementIds,
            },
          }
      : undefined,
  };
}

function itemsFromChangeSet(generationId: string, changeSet: ResumeChangeSet): ResumeCriticReviewItem[] {
  return changeSet.changes.map((change) => {
    const needsEvidence = change.evidenceIds.length === 0 || change.riskLevel === "high" || change.riskLevel === "critical";
    const category = needsEvidence ? "unsupported_claim" : categoryForChange(change.rubricDimensions);
    return {
      itemId: stableId("rcri", [generationId, change.changeId, category]),
      category,
      severity: change.riskLevel,
      target: change.target,
      explanation: needsEvidence
        ? "The proposed rewrite needs stronger evidence before it can be safely applied."
        : change.reason,
      evidenceIds: [...change.evidenceIds],
      suggestedFix: needsEvidence
        ? "Ask the user for supporting evidence or omit the claim."
        : "Offer this local rewrite as an explicit patch suggestion.",
      autoFixAllowed: !needsEvidence,
      patch: needsEvidence
        ? undefined
        : {
            type: change.type,
            target: change.target,
            before: change.before,
            after: change.after,
          },
      nextAction: needsEvidence
        ? {
            type: "provide_missing_evidence",
            label: "Add evidence for this proposed claim",
            payload: { changeSetId: changeSet.changeSetId, changeId: change.changeId },
          }
        : undefined,
    };
  });
}

function itemsFromDraftText(generationId: string, draft: ResumeDocument): ResumeCriticReviewItem[] {
  const items: ResumeCriticReviewItem[] = [];
  const seenBullets = new Map<string, ResumeOptimizationTarget>();
  for (const section of draft.sections) {
    for (const item of section.items) {
      for (const bullet of item.bullets) {
        const target = {
          sectionId: section.id,
          itemId: item.id,
          bulletId: bullet.id,
          sourceExperienceId: item.sourceExperienceId,
          path: `sections.${section.id}.items.${item.id}.bullets.${bullet.id}`,
        };
        const normalized = normalizeText(bullet.text);
        if (normalized && seenBullets.has(normalized)) {
          items.push({
            itemId: stableId("rcri", [generationId, "repeated", bullet.id, normalized]),
            category: "repeated_wording",
            severity: "medium",
            target,
            explanation: "This bullet repeats wording already used elsewhere in the draft.",
            evidenceIds: bullet.evidenceIds ? [...bullet.evidenceIds] : [],
            suggestedFix: "Rewrite one repeated bullet with a different result, scope, or method.",
            autoFixAllowed: false,
          });
        }
        seenBullets.set(normalized, target);
        const wordCount = bullet.text.trim().split(/\s+/u).filter(Boolean).length;
        if (wordCount > 34 || bullet.text.length > 230) {
          items.push({
            itemId: stableId("rcri", [generationId, "too-long", bullet.id]),
            category: "bullet_too_long",
            severity: "medium",
            target,
            explanation: "This bullet is long enough to create readability and layout risk.",
            evidenceIds: bullet.evidenceIds ? [...bullet.evidenceIds] : [],
            suggestedFix: "Split or tighten the bullet while preserving the same evidence.",
            autoFixAllowed: false,
          });
        }
        if (wordCount > 0 && wordCount < 7) {
          items.push({
            itemId: stableId("rcri", [generationId, "too-short", bullet.id]),
            category: "bullet_too_short",
            severity: "low",
            target,
            explanation: "This bullet is too short to carry action, method, and result.",
            evidenceIds: bullet.evidenceIds ? [...bullet.evidenceIds] : [],
            suggestedFix: "Expand it into an action-method-result bullet using known evidence.",
            autoFixAllowed: false,
          });
        }
      }
    }
  }
  return items;
}

function itemsFromLayoutReport(generationId: string, report: LayoutPreviewReport): ResumeCriticReviewItem[] {
  return report.diagnostics.map((diagnostic, index) => ({
    itemId: stableId("rcri", [generationId, report.layoutPreviewId, diagnostic.type, String(index)]),
    category: "layout_risk",
    severity: diagnostic.severity,
    target: {
      itemId: diagnostic.itemId,
      bulletId: diagnostic.bulletId,
      path: diagnostic.sectionType ? `sections.${diagnostic.sectionType}` : undefined,
    },
    explanation: diagnostic.message,
    evidenceIds: [],
    suggestedFix: "Compact the affected section or rerun layout measurement after patching.",
    autoFixAllowed: false,
    nextAction: {
      type: "retry_layout_check",
      label: "Rerun layout check after editing",
      payload: { layoutPreviewId: report.layoutPreviewId, diagnosticType: diagnostic.type },
    },
  }));
}

function categoryForDimension(
  dimension: ResumeOptimizationRubricDimension,
  message: string,
): ResumeCriticFindingCategory {
  if (dimension === "fabrication_exaggeration_risk") return /metric|number|%|percent/i.test(message) ? "inflated_metric" : "unsupported_claim";
  if (dimension === "star_closure") return "missing_star_closure";
  if (dimension === "jd_alignment" || dimension === "ats_keyword_coverage") return "poor_jd_alignment";
  if (dimension === "layout_risk") return "layout_risk";
  if (dimension === "structure_completeness") return "structure_mismatch";
  if (dimension === "professional_expression_quality") return "weak_verb";
  if (dimension === "metric_quantification_quality") return "inflated_metric";
  if (dimension === "application_readiness") return "tone_or_seniority_mismatch";
  return "poor_jd_alignment";
}

function categoryForChange(dimensions: ResumeOptimizationRubricDimension[]): ResumeCriticFindingCategory {
  if (dimensions.includes("star_closure")) return "missing_star_closure";
  if (dimensions.includes("layout_risk")) return "layout_risk";
  if (dimensions.includes("professional_expression_quality")) return "weak_verb";
  if (dimensions.includes("metric_quantification_quality")) return "inflated_metric";
  return "poor_jd_alignment";
}

function suggestionForCategory(category: ResumeCriticFindingCategory, needsEvidence: boolean): string {
  if (needsEvidence) return "Ask for supporting evidence or remove the risky claim.";
  if (category === "missing_star_closure") return "Add the result or business impact to close the STAR arc.";
  if (category === "weak_verb") return "Replace weak phrasing with a concrete action verb.";
  if (category === "layout_risk") return "Tighten wording and recheck layout.";
  return "Create a focused local rewrite for this item.";
}

function dedupeItems(items: ResumeCriticReviewItem[]): ResumeCriticReviewItem[] {
  const seen = new Set<string>();
  const result: ResumeCriticReviewItem[] = [];
  for (const item of items) {
    const key = [
      item.category,
      item.target.sectionId,
      item.target.itemId,
      item.target.bulletId,
      normalizeText(item.explanation),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function sameTarget(left: ResumeOptimizationTarget, right: ResumeOptimizationTarget | undefined): boolean {
  if (!right) return false;
  return Boolean(
    (right.bulletId && left.bulletId === right.bulletId)
    || (right.itemId && left.itemId === right.itemId)
    || (right.sourceExperienceId && left.sourceExperienceId === right.sourceExperienceId)
    || (right.requirementId && left.requirementId === right.requirementId),
  );
}

function severityRank(value: ResumeOptimizationFindingSeverity): number {
  if (value === "critical") return 4;
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

function stableId(prefix: string, parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 16);
  return `${prefix}-${hash}`;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
