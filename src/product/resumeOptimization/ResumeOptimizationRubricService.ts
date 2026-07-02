import type { EvidencePack, JDRequirement } from "../../rag/evidence/index.js";
import type { ProductExperienceSummary } from "../types.js";
import type {
  ATSKeywordCoverageReport,
  JDResumeRequirementAnalysis,
  ResumeOptimizationDimensionScore,
  ResumeOptimizationFindingSeverity,
  ResumeOptimizationReportFinding,
  ResumeOptimizationRubricDimension,
  ResumeOptimizationScoreBand,
} from "./types.js";
import { searchableExperienceText } from "./ATSKeywordCoverageService.js";

export class ResumeOptimizationRubricService {
  public evaluate(input: {
    requirements: JDRequirement[];
    requirementAnalysis: JDResumeRequirementAnalysis[];
    atsKeywordCoverage: ATSKeywordCoverageReport;
    sourceExperiences: ProductExperienceSummary[];
    evidencePack?: EvidencePack;
  }): {
    dimensions: ResumeOptimizationDimensionScore[];
    findings: ResumeOptimizationReportFinding[];
    overallScore: number;
    readiness: ResumeOptimizationScoreBand;
  } {
    const findings: ResumeOptimizationReportFinding[] = [];
    const dimensionInputs: Array<{ dimension: ResumeOptimizationRubricDimension; score: number }> = [
      { dimension: "ats_keyword_coverage", score: input.atsKeywordCoverage.coverageRatio * 100 },
      { dimension: "jd_alignment", score: scoreRequirementAlignment(input.requirementAnalysis) },
      { dimension: "evidence_strength", score: scoreEvidenceStrength(input.evidencePack, input.requirementAnalysis) },
      { dimension: "metric_quantification_quality", score: scoreMetricQuality(input.sourceExperiences) },
      { dimension: "star_closure", score: scoreStarClosure(input.sourceExperiences) },
      { dimension: "professional_expression_quality", score: scoreExpressionQuality(input.sourceExperiences) },
      { dimension: "structure_completeness", score: scoreStructureCompleteness(input.sourceExperiences) },
      { dimension: "layout_risk", score: scoreLayoutRisk(input.sourceExperiences) },
      { dimension: "fabrication_exaggeration_risk", score: scoreFabricationRisk(input.evidencePack, input.requirementAnalysis) },
      { dimension: "application_readiness", score: 0 },
    ];

    addCoverageFindings(findings, input.atsKeywordCoverage, input.requirements);
    addRequirementFindings(findings, input.requirementAnalysis);
    addEvidenceFindings(findings, input.evidencePack, input.requirementAnalysis);
    addMetricFindings(findings, input.sourceExperiences);
    addStructureFindings(findings, input.sourceExperiences);
    addLayoutFindings(findings, input.sourceExperiences);

    const readinessBase = weightedAverage(dimensionInputs.filter((item) => item.dimension !== "application_readiness"));
    const applicationReadiness = Math.round(readinessBase);
    const withReadiness = dimensionInputs.map((item) =>
      item.dimension === "application_readiness" ? { ...item, score: applicationReadiness } : item,
    );
    const dimensions = withReadiness.map((item) => ({
      dimension: item.dimension,
      score: roundScore(item.score),
      band: scoreBand(item.score),
      findingIds: findings
        .filter((finding) => finding.dimension === item.dimension)
        .map((finding) => finding.id),
    }));
    const overallScore = roundScore(weightedAverage(withReadiness));
    return {
      dimensions,
      findings: findings.sort(compareFindings),
      overallScore,
      readiness: scoreBand(overallScore),
    };
  }
}

function scoreRequirementAlignment(requirements: JDResumeRequirementAnalysis[]): number {
  if (requirements.length === 0) return 60;
  const total = requirements.reduce((sum, item) => sum + importanceWeight(item.importance), 0);
  const earned = requirements.reduce((sum, item) => sum + item.score * importanceWeight(item.importance), 0);
  return total > 0 ? earned / total : 60;
}

function scoreEvidenceStrength(evidencePack: EvidencePack | undefined, requirements: JDResumeRequirementAnalysis[]): number {
  if (!evidencePack) return requirements.some((item) => item.evidenceCoverage !== "no_evidence") ? 55 : 35;
  if (requirements.length === 0) return evidencePack.allowedClaims.length > 0 ? 70 : 40;
  const covered = requirements.filter((item) => item.evidenceCoverage === "covered").length;
  const partial = requirements.filter((item) => item.evidenceCoverage === "partially_covered").length;
  const highRiskClaims = evidencePack.allowedClaims.filter((claim) => claim.riskLevel === "high").length;
  const base = ((covered + partial * 0.55) / requirements.length) * 100;
  return Math.max(0, base - highRiskClaims * 5);
}

function scoreMetricQuality(experiences: ProductExperienceSummary[]): number {
  const texts = experienceTexts(experiences);
  if (texts.length === 0) return 45;
  const withMetrics = texts.filter((text) => METRIC_PATTERN.test(text)).length;
  return 35 + (withMetrics / texts.length) * 65;
}

function scoreStarClosure(experiences: ProductExperienceSummary[]): number {
  const texts = experienceTexts(experiences);
  if (texts.length === 0) return 45;
  const complete = texts.filter((text) => ACTION_PATTERN.test(text) && RESULT_PATTERN.test(text)).length;
  return 40 + (complete / texts.length) * 60;
}

function scoreExpressionQuality(experiences: ProductExperienceSummary[]): number {
  const texts = experienceTexts(experiences);
  if (texts.length === 0) return 55;
  const clean = texts.filter((text) => {
    const trimmed = text.trim();
    return trimmed.length >= 40 && trimmed.length <= 1400 && !/\b(todo|tbd|placeholder)\b/i.test(trimmed);
  }).length;
  return 45 + (clean / texts.length) * 55;
}

function scoreStructureCompleteness(experiences: ProductExperienceSummary[]): number {
  const categories = new Set(experiences.map((item) => item.category));
  let score = 30;
  if (categories.has("education")) score += 18;
  if (categories.has("skill")) score += 14;
  if (categories.has("work") || categories.has("internship")) score += 22;
  if (categories.has("project")) score += 12;
  if (categories.has("award")) score += 4;
  return score;
}

function scoreLayoutRisk(experiences: ProductExperienceSummary[]): number {
  const totalChars = experienceTexts(experiences).join("\n").length;
  if (totalChars < 450) return 55;
  if (totalChars > 5200) return 60;
  if (totalChars > 3900) return 78;
  return 88;
}

function scoreFabricationRisk(evidencePack: EvidencePack | undefined, requirements: JDResumeRequirementAnalysis[]): number {
  const missingCritical = requirements.filter((item) =>
    item.evidenceCoverage === "no_evidence" && (item.importance === "critical" || item.importance === "high")
  ).length;
  const highRiskClaims = evidencePack?.allowedClaims.filter((claim) => claim.riskLevel === "high").length ?? 0;
  return Math.max(10, 95 - missingCritical * 12 - highRiskClaims * 10);
}

function addCoverageFindings(
  findings: ResumeOptimizationReportFinding[],
  coverage: ATSKeywordCoverageReport,
  requirements: JDRequirement[],
): void {
  const requirementById = new Map(requirements.map((item) => [item.id, item]));
  for (const item of coverage.items.filter((entry) => !entry.matched).slice(0, 12)) {
    const important = item.requirementIds.some((id) => {
      const importance = requirementById.get(id)?.importance;
      return importance === "critical" || importance === "high";
    });
    findings.push({
      id: `ats_keyword_coverage:missing:${stableIdPart(item.keyword)}`,
      dimension: "ats_keyword_coverage",
      severity: important ? "high" : "medium",
      message: `JD keyword "${item.keyword}" is not supported by the selected source evidence.`,
      target: { requirementId: item.requirementIds[0], path: `jd.keywords.${item.keyword}` },
      requirementIds: item.requirementIds,
      sourceExperienceIds: [],
      evidenceIds: [],
      recommendedAction: "ask_user",
    });
  }
}

function addRequirementFindings(
  findings: ResumeOptimizationReportFinding[],
  requirements: JDResumeRequirementAnalysis[],
): void {
  for (const item of requirements.filter((entry) => entry.evidenceCoverage !== "covered").slice(0, 16)) {
    findings.push({
      id: `jd_alignment:${item.evidenceCoverage}:${item.requirementId}`,
      dimension: "jd_alignment",
      severity: item.importance === "critical" ? "critical" : item.importance === "high" ? "high" : "medium",
      message: item.evidenceCoverage === "no_evidence"
        ? `No direct evidence was found for JD requirement: ${item.text}`
        : `Only partial evidence was found for JD requirement: ${item.text}`,
      target: item.target,
      requirementIds: [item.requirementId],
      sourceExperienceIds: item.sourceExperienceIds,
      evidenceIds: item.evidenceIds,
      recommendedAction: item.evidenceCoverage === "no_evidence" ? "ask_user" : "rewrite",
    });
  }
}

function addEvidenceFindings(
  findings: ResumeOptimizationReportFinding[],
  evidencePack: EvidencePack | undefined,
  requirements: JDResumeRequirementAnalysis[],
): void {
  if (!evidencePack || evidencePack.allowedClaims.length === 0) {
    findings.push({
      id: "evidence_strength:no_allowed_claims",
      dimension: "evidence_strength",
      severity: "high",
      message: "No claim-level evidence is available; generated changes must stay conservative.",
      requirementIds: requirements.map((item) => item.requirementId).slice(0, 8),
      sourceExperienceIds: [],
      evidenceIds: [],
      recommendedAction: "ask_user",
    });
    return;
  }
  for (const claim of evidencePack.allowedClaims.filter((item) => item.riskLevel === "high").slice(0, 8)) {
    findings.push({
      id: `fabrication_exaggeration_risk:high_risk_claim:${claim.claimId ?? claim.id}`,
      dimension: "fabrication_exaggeration_risk",
      severity: "high",
      message: `Evidence claim needs verification before use: ${claim.claim}`,
      target: { sourceExperienceId: claim.experienceId },
      requirementIds: claim.requirementIds,
      sourceExperienceIds: [claim.experienceId],
      evidenceIds: [claim.claimId ?? claim.id],
      recommendedAction: "verify",
    });
  }
}

function addMetricFindings(findings: ResumeOptimizationReportFinding[], experiences: ProductExperienceSummary[]): void {
  const texts = experienceTexts(experiences);
  if (texts.length === 0) return;
  const withMetrics = texts.filter((text) => METRIC_PATTERN.test(text)).length;
  if (withMetrics / texts.length >= 0.35) return;
  findings.push({
    id: "metric_quantification_quality:low_metric_density",
    dimension: "metric_quantification_quality",
    severity: "medium",
    message: `Only ${withMetrics}/${texts.length} source experience item(s) include quantified outcomes.`,
    requirementIds: [],
    sourceExperienceIds: experiences.map((item) => item.id),
    evidenceIds: [],
    recommendedAction: "ask_user",
  });
}

function addStructureFindings(findings: ResumeOptimizationReportFinding[], experiences: ProductExperienceSummary[]): void {
  const categories = new Set(experiences.map((item) => item.category));
  const missing: string[] = [];
  if (!categories.has("education")) missing.push("education");
  if (!categories.has("skill")) missing.push("skill");
  if (!categories.has("work") && !categories.has("internship")) missing.push("work_or_internship");
  if (missing.length === 0) return;
  findings.push({
    id: "structure_completeness:missing_foundation_sections",
    dimension: "structure_completeness",
    severity: missing.includes("work_or_internship") ? "high" : "medium",
    message: `Resume source set is missing expected section(s): ${missing.join(", ")}.`,
    requirementIds: [],
    sourceExperienceIds: experiences.map((item) => item.id),
    evidenceIds: [],
    recommendedAction: "ask_user",
  });
}

function addLayoutFindings(findings: ResumeOptimizationReportFinding[], experiences: ProductExperienceSummary[]): void {
  const totalChars = experienceTexts(experiences).join("\n").length;
  if (totalChars >= 450 && totalChars <= 5200) return;
  findings.push({
    id: totalChars < 450 ? "layout_risk:likely_underfill" : "layout_risk:likely_overflow",
    dimension: "layout_risk",
    severity: "medium",
    message: totalChars < 450
      ? "Source material appears too thin for a complete one-page resume."
      : "Source material appears long enough to create one-page layout risk.",
    requirementIds: [],
    sourceExperienceIds: experiences.map((item) => item.id),
    evidenceIds: [],
    recommendedAction: "layout_review",
  });
}

function experienceTexts(experiences: ProductExperienceSummary[]): string[] {
  return experiences.map((item) => searchableExperienceText(item)).filter((text) => text.trim().length > 0);
}

function weightedAverage(items: Array<{ dimension: ResumeOptimizationRubricDimension; score: number }>): number {
  let total = 0;
  let weightSum = 0;
  for (const item of items) {
    const weight = DIMENSION_WEIGHTS[item.dimension] ?? 1;
    total += item.score * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? total / weightSum : 0;
}

function scoreBand(score: number): ResumeOptimizationScoreBand {
  if (score >= 80) return "strong";
  if (score >= 55) return "partial";
  return "weak";
}

function roundScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function importanceWeight(value: string): number {
  if (value === "critical") return 1.4;
  if (value === "high") return 1.2;
  if (value === "low") return 0.75;
  return 1;
}

function stableIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "keyword";
}

function compareFindings(a: ResumeOptimizationReportFinding, b: ResumeOptimizationReportFinding): number {
  return severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id);
}

function severityRank(value: ResumeOptimizationFindingSeverity): number {
  if (value === "critical") return 4;
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

const DIMENSION_WEIGHTS: Record<ResumeOptimizationRubricDimension, number> = {
  ats_keyword_coverage: 1.1,
  jd_alignment: 1.35,
  evidence_strength: 1.25,
  metric_quantification_quality: 0.8,
  star_closure: 0.8,
  professional_expression_quality: 0.7,
  structure_completeness: 0.8,
  layout_risk: 0.75,
  fabrication_exaggeration_risk: 1.1,
  application_readiness: 1,
};

const METRIC_PATTERN = /(\d+(?:[\.,]\d+)?\s*(?:%|x|times|倍|万|k|m|ms|s|hours?|days?|weeks?|months?))|\d{2,}/i;
const ACTION_PATTERN = /\b(built|led|drove|launched|shipped|designed|implemented|optimized|reduced|improved|created|delivered|migrated|automated|owned|developed|coordinated|managed)\b|负责|主导|搭建|设计|实现|交付|优化|提升|降低|完成|推动|开发/iu;
const RESULT_PATTERN = /\b(result|impact|reduced|improved|increased|saved|grew|delivered|launched)\b|提升|降低|减少|节省|交付|上线|增长|转化|效率|准确率|覆盖/iu;
