import { createHash } from "node:crypto";
import type {
  ProductExperienceSummary,
  ProductGeneratedVariant,
  ProductGeneration,
  ResumeDocument,
  ResumeDocumentBullet,
  ResumeDocumentItem,
  ResumeDocumentSection,
} from "../types.js";
import type {
  JDResumeAnalysisReport,
  ResumeChange,
  ResumeChangeRiskLevel,
  ResumeChangeSet,
  ResumeChangeType,
  ResumeOptimizationRubricDimension,
} from "./types.js";

export class ResumeChangePlanner {
  public plan(input: {
    generation: ProductGeneration;
    variant: ProductGeneratedVariant;
    analysisReport: JDResumeAnalysisReport;
    sourceExperiences: ProductExperienceSummary[];
  }): ResumeChangeSet {
    const now = new Date().toISOString();
    const proposedDraft = cloneDocument(input.variant.resumeDocument ?? buildFallbackProposedDraft(input.variant));
    const originalDraft = buildOriginalDraft(proposedDraft, input.sourceExperiences);
    const changeSetId = stableId("rcs", [input.generation.id, input.variant.id, input.analysisReport.rubricVersion]);
    const changes = dedupeChanges(buildChanges({
      changeSetId,
      proposedDraft,
      originalDraft,
      analysisReport: input.analysisReport,
      variant: input.variant,
    }));

    return {
      schemaVersion: 1,
      changeSetId,
      generationId: input.generation.id,
      variantId: input.variant.id,
      status: "pending",
      summary: summarizeChanges(changes),
      originalDraft,
      currentDraft: cloneDocument(originalDraft),
      proposedDraft,
      changes,
      createdAt: now,
      updatedAt: now,
    };
  }
}

function buildFallbackProposedDraft(variant: ProductGeneratedVariant): ResumeDocument {
  const lines = variant.content
    .split(/\r?\n/u)
    .map((line) => line.replace(/^[-*\d.\s]+/u, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 12);
  return {
    schemaVersion: 1,
    sections: [{
      id: "section-generated-summary",
      type: "summary",
      title: "Generated resume draft",
      order: 0,
      items: [{
        id: "item-generated-summary",
        title: variant.variantName ?? "Generated draft",
        bullets: lines.map((text, index) => ({
          id: `bullet-generated-${index + 1}`,
          text,
          evidenceIds: variant.sourceEvidenceIds ?? [],
        })),
      }],
    }],
  };
}

function buildOriginalDraft(
  proposedDraft: ResumeDocument,
  sourceExperiences: ProductExperienceSummary[],
): ResumeDocument {
  const sourcesById = new Map(sourceExperiences.map((source) => [source.id, source]));
  return {
    schemaVersion: 1,
    sections: proposedDraft.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => {
        const source = item.sourceExperienceId ? sourcesById.get(item.sourceExperienceId) : undefined;
        const sourceBullets = source ? splitSourceBullets(source.content ?? "") : [];
        return {
          ...item,
          bullets: item.bullets.map((bullet, index) => ({
            ...bullet,
            text: sourceBullets[index] ?? source?.content?.replace(/\s+/g, " ").trim().slice(0, 260) ?? "",
          })),
        };
      }),
    })),
  };
}

function buildChanges(input: {
  changeSetId: string;
  proposedDraft: ResumeDocument;
  originalDraft: ResumeDocument;
  analysisReport: JDResumeAnalysisReport;
  variant: ProductGeneratedVariant;
}): ResumeChange[] {
  const changes: ResumeChange[] = [];
  const originalBullets = indexBullets(input.originalDraft);
  for (const section of input.proposedDraft.sections) {
    for (const item of section.items) {
      const requirement = bestRequirementForItem(input.analysisReport, item);
      for (const bullet of item.bullets) {
        const before = originalBullets.get(bullet.id)?.text ?? "";
        const after = bullet.text.trim();
        if (!after || normalizeText(before) === normalizeText(after)) continue;
        const changeType = classifyChangeType(section, item, before, after);
        const sourceExperienceId = item.sourceExperienceId ?? requirement?.sourceExperienceIds[0];
        const evidenceIds = unique([
          ...(bullet.evidenceIds ?? []),
          ...(requirement?.evidenceIds ?? []),
          ...(sourceExperienceId ? [`source-card-${sourceExperienceId}`] : []),
        ]);
        const target = {
          requirementId: requirement?.requirementId,
          sourceExperienceId,
          sectionId: section.id,
          itemId: item.id,
          bulletId: bullet.id,
          path: `sections.${section.id}.items.${item.id}.bullets.${bullet.id}`,
        };
        const changeId = stableId("rch", [
          input.changeSetId,
          changeType,
          target.path,
          before,
          after,
        ]);
        changes.push({
          changeId,
          type: changeType,
          target,
          before,
          after,
          reason: reasonForChange(requirement, section, item, changeType),
          evidenceIds,
          sourceExperienceId,
          riskLevel: riskForRequirement(requirement, input.analysisReport),
          rubricDimensions: dimensionsForRequirement(requirement, input.analysisReport),
          status: "pending",
          acceptAction: {
            type: "accept_resume_change",
            label: "Accept this change",
            payload: { changeSetId: input.changeSetId, changeId },
          },
          rejectAction: {
            type: "reject_resume_change",
            label: "Reject this change",
            payload: { changeSetId: input.changeSetId, changeId },
          },
        });
      }
    }
  }
  return changes;
}

function classifyChangeType(
  section: ResumeDocumentSection,
  item: ResumeDocumentItem,
  before: string,
  after: string,
): ResumeChangeType {
  if (section.type === "summary") return before ? "rewrite_summary" : "rewrite_headline";
  if (section.type === "skill") return before ? "replace_bullet" : "add_skill_keyword";
  if (!before) return "add_bullet";
  if (after.length < before.length * 0.72) return "layout_compact";
  if (item.title.toLowerCase().includes("cert")) return "tighten_certificate";
  return "replace_bullet";
}

function bestRequirementForItem(
  report: JDResumeAnalysisReport,
  item: ResumeDocumentItem,
): JDResumeAnalysisReport["requirements"][number] | undefined {
  const bySource = item.sourceExperienceId
    ? report.requirements.find((requirement) => requirement.sourceExperienceIds.includes(item.sourceExperienceId!))
    : undefined;
  if (bySource) return bySource;
  const itemText = [
    item.title,
    item.subtitle,
    ...item.bullets.map((bullet) => bullet.text),
  ].join(" ").toLowerCase();
  return report.requirements.find((requirement) =>
    requirement.keywordHits.some((keyword) => itemText.includes(keyword.toLowerCase())),
  ) ?? report.requirements.find((requirement) =>
    report.phase3Inputs.prioritizedRequirementIds.includes(requirement.requirementId),
  );
}

function reasonForChange(
  requirement: JDResumeAnalysisReport["requirements"][number] | undefined,
  section: ResumeDocumentSection,
  item: ResumeDocumentItem,
  type: ResumeChangeType,
): string {
  if (requirement) {
    return `Improve ${requirement.category} coverage for "${requirement.text}" using the ${section.title || item.title} draft.`;
  }
  if (type === "layout_compact") return "Compact wording to reduce layout risk while preserving the same source item.";
  return `Make the ${section.title || item.title} draft reviewable as a local resume change.`;
}

function dimensionsForRequirement(
  requirement: JDResumeAnalysisReport["requirements"][number] | undefined,
  report: JDResumeAnalysisReport,
): ResumeOptimizationRubricDimension[] {
  const related = requirement
    ? report.findings
        .filter((finding) => finding.requirementIds.includes(requirement.requirementId))
        .map((finding) => finding.dimension)
    : [];
  return unique([
    ...related,
    ...report.phase3Inputs.rewriteFocusDimensions,
    "jd_alignment",
  ]).slice(0, 4) as ResumeOptimizationRubricDimension[];
}

function riskForRequirement(
  requirement: JDResumeAnalysisReport["requirements"][number] | undefined,
  report: JDResumeAnalysisReport,
): ResumeChangeRiskLevel {
  if (!requirement) return "medium";
  if (requirement.evidenceCoverage === "no_evidence") return "high";
  if (requirement.evidenceCoverage === "partially_covered") return "medium";
  const highRiskFinding = report.findings.find((finding) =>
    finding.requirementIds.includes(requirement.requirementId)
    && (finding.severity === "critical" || finding.severity === "high")
  );
  return highRiskFinding ? highRiskFinding.severity : "low";
}

function dedupeChanges(changes: ResumeChange[]): ResumeChange[] {
  const seen = new Set<string>();
  const result: ResumeChange[] = [];
  for (const change of changes) {
    const key = [
      change.type,
      change.target.sourceExperienceId,
      change.target.requirementId,
      normalizeText(change.after),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(change);
  }
  return result;
}

export function summarizeChanges(changes: ResumeChange[]): ResumeChangeSet["summary"] {
  const acceptedCount = changes.filter((change) => change.status === "accepted").length;
  const rejectedCount = changes.filter((change) => change.status === "rejected").length;
  const pendingCount = changes.filter((change) => change.status === "pending").length;
  return {
    totalChanges: changes.length,
    pendingCount,
    acceptedCount,
    rejectedCount,
    label: `${pendingCount} change${pendingCount === 1 ? "" : "s"} waiting for review`,
  };
}

function indexBullets(document: ResumeDocument): Map<string, ResumeDocumentBullet> {
  const result = new Map<string, ResumeDocumentBullet>();
  for (const section of document.sections) {
    for (const item of section.items) {
      for (const bullet of item.bullets) result.set(bullet.id, bullet);
    }
  }
  return result;
}

function splitSourceBullets(content: string): string[] {
  return content
    .split(/\r?\n|[。；;]\s*/u)
    .map((line) => line.replace(/^[-*•·\d.\s]+/u, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 12);
}

function stableId(prefix: string, parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 16);
  return `${prefix}-${hash}`;
}

function cloneDocument(document: ResumeDocument): ResumeDocument {
  return {
    schemaVersion: 1,
    sections: document.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({
        ...item,
        bullets: item.bullets.map((bullet) => ({ ...bullet, evidenceIds: bullet.evidenceIds ? [...bullet.evidenceIds] : undefined })),
      })),
    })),
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items.filter((item): item is NonNullable<T> => item != null)));
}
