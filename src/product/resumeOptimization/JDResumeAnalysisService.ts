import {
  JDRequirementParser,
  type EvidenceCoverage,
  type EvidencePack,
  type EvidenceRecommendedAction,
  type JDRequirement,
} from "../../rag/evidence/index.js";
import type { ProductExperienceSummary, ProductJDRecord } from "../types.js";
import { ATSKeywordCoverageService, searchableExperienceText } from "./ATSKeywordCoverageService.js";
import { ResumeOptimizationRubricService } from "./ResumeOptimizationRubricService.js";
import type {
  ATSKeywordCoverageReport,
  JDResumeAnalysisReport,
  JDResumeRequirementAnalysis,
  ResumeOptimizationRubricDimension,
} from "./types.js";

export class JDResumeAnalysisService {
  private readonly requirementParser = new JDRequirementParser();
  private readonly keywordCoverageService = new ATSKeywordCoverageService();
  private readonly rubricService = new ResumeOptimizationRubricService();

  public async analyze(input: {
    jd: ProductJDRecord;
    targetRole?: string;
    sourceExperiences: ProductExperienceSummary[];
    evidencePack?: EvidencePack;
  }): Promise<JDResumeAnalysisReport> {
    const requirements = input.evidencePack?.jdRequirements.length
      ? input.evidencePack.jdRequirements
      : await this.requirementParser.parse({
          jdText: input.jd.rawText,
          targetRole: input.targetRole ?? input.jd.targetRole,
        });
    const atsKeywordCoverage = this.keywordCoverageService.analyze({
      requirements,
      sourceExperiences: input.sourceExperiences,
      evidencePack: input.evidencePack,
    });
    const requirementAnalysis = buildRequirementAnalysis({
      requirements,
      sourceExperiences: input.sourceExperiences,
      evidencePack: input.evidencePack,
      atsKeywordCoverage,
    });
    const rubric = this.rubricService.evaluate({
      requirements,
      requirementAnalysis,
      atsKeywordCoverage,
      sourceExperiences: input.sourceExperiences,
      evidencePack: input.evidencePack,
    });

    return {
      schemaVersion: 1,
      reportVersion: "resume-optimization-analysis-v1",
      rubricVersion: "resume-optimization-rubric-v1",
      jdId: input.jd.id,
      targetRole: input.targetRole ?? input.jd.targetRole,
      generatedAt: new Date().toISOString(),
      summary: {
        overallScore: rubric.overallScore,
        readiness: rubric.readiness,
        strongDimensions: rubric.dimensions
          .filter((item) => item.band === "strong")
          .map((item) => item.dimension),
        weakDimensions: rubric.dimensions
          .filter((item) => item.band === "weak")
          .map((item) => item.dimension),
        topFindingIds: rubric.findings.slice(0, 5).map((item) => item.id),
      },
      dimensions: rubric.dimensions,
      requirements: requirementAnalysis,
      atsKeywordCoverage,
      findings: rubric.findings,
      phase3Inputs: {
        prioritizedRequirementIds: prioritizeRequirements(requirementAnalysis),
        evidenceBackedSourceExperienceIds: evidenceBackedSourceExperienceIds(requirementAnalysis),
        missingRequirementIds: requirementAnalysis
          .filter((item) => item.evidenceCoverage === "no_evidence")
          .map((item) => item.requirementId),
        riskyEvidenceIds: input.evidencePack?.allowedClaims
          .filter((claim) => claim.riskLevel === "high")
          .map((claim) => claim.claimId ?? claim.id) ?? [],
        rewriteFocusDimensions: rewriteFocusDimensions(rubric.dimensions),
      },
    };
  }
}

function buildRequirementAnalysis(input: {
  requirements: JDRequirement[];
  sourceExperiences: ProductExperienceSummary[];
  evidencePack?: EvidencePack;
  atsKeywordCoverage: ATSKeywordCoverageReport;
}): JDResumeRequirementAnalysis[] {
  const sourceTexts = input.sourceExperiences.map((experience) => ({
    experience,
    text: searchableExperienceText(experience),
  }));
  return input.requirements.map((requirement) => {
    const evidenceMatch = input.evidencePack?.matchedEvidence.find((item) => item.requirementId === requirement.id);
    const keywordItems = input.atsKeywordCoverage.items.filter((item) => item.requirementIds.includes(requirement.id));
    const keywordHits = keywordItems.filter((item) => item.matched).map((item) => item.keyword);
    const fallbackSourceIds = sourceTexts
      .filter((item) => requirementTerms(requirement).some((term) => item.text.includes(term)))
      .map((item) => item.experience.id);
    const evidenceIds = evidenceMatch?.evidenceItems
      .map((item) => item.claimId ?? item.id)
      .filter((id, index, all) => id && all.indexOf(id) === index) ?? [];
    const evidenceSourceIds = evidenceMatch?.evidenceItems
      .map((item) => item.experienceId)
      .filter((id, index, all) => id && all.indexOf(id) === index) ?? [];
    const sourceExperienceIds = evidenceSourceIds.length > 0
      ? evidenceSourceIds
      : Array.from(new Set([...fallbackSourceIds, ...keywordItems.flatMap((item) => item.matchedSourceExperienceIds)]));
    const evidenceCoverage = evidenceMatch?.coverage ?? fallbackCoverage(requirement, keywordHits, sourceExperienceIds);
    const recommendedAction = evidenceMatch?.recommendedAction ?? fallbackAction(evidenceCoverage);
    return {
      requirementId: requirement.id,
      text: requirement.text,
      category: requirement.category,
      importance: requirement.importance,
      evidenceCoverage,
      recommendedAction,
      score: scoreRequirement(requirement, evidenceCoverage, keywordHits),
      keywordHits,
      evidenceIds,
      sourceExperienceIds,
      target: {
        requirementId: requirement.id,
        sourceExperienceId: sourceExperienceIds[0],
        itemId: sourceExperienceIds[0],
        path: `requirements.${requirement.id}`,
      },
    };
  });
}

function requirementTerms(requirement: JDRequirement): string[] {
  return Array.from(new Set([
    ...requirement.keywords,
    ...requirement.coreTerms,
    ...requirement.queryVariants,
  ]
    .map((item) => item.toLowerCase().trim())
    .filter((item) => item.length >= 2)));
}

function fallbackCoverage(
  requirement: JDRequirement,
  keywordHits: string[],
  sourceExperienceIds: string[],
): EvidenceCoverage {
  if (sourceExperienceIds.length === 0 && keywordHits.length === 0) return "no_evidence";
  const termCount = Math.max(1, requirementTerms(requirement).length);
  const hitRatio = keywordHits.length / termCount;
  if (hitRatio >= 0.45 || sourceExperienceIds.length >= 2) return "covered";
  return "partially_covered";
}

function fallbackAction(coverage: EvidenceCoverage): EvidenceRecommendedAction {
  if (coverage === "covered") return "use";
  if (coverage === "partially_covered") return "alternative_angle";
  return "ask_user";
}

function scoreRequirement(
  requirement: JDRequirement,
  coverage: EvidenceCoverage,
  keywordHits: string[],
): number {
  const base = coverage === "covered" ? 88 : coverage === "partially_covered" ? 58 : 22;
  const keywordBonus = Math.min(10, keywordHits.length * 2);
  const importancePenalty = coverage === "no_evidence" && (requirement.importance === "critical" || requirement.importance === "high")
    ? 8
    : 0;
  return Math.max(0, Math.min(100, base + keywordBonus - importancePenalty));
}

function prioritizeRequirements(requirements: JDResumeRequirementAnalysis[]): string[] {
  const sorted = [...requirements]
    .sort((a, b) =>
      importanceRank(b.importance) - importanceRank(a.importance)
      || a.score - b.score
      || a.requirementId.localeCompare(b.requirementId)
    )
    .map((item) => item.requirementId);
  return Array.from(new Set(sorted));
}

function evidenceBackedSourceExperienceIds(requirements: JDResumeRequirementAnalysis[]): string[] {
  const ids = new Set<string>();
  for (const requirement of requirements) {
    if (requirement.evidenceCoverage === "no_evidence") continue;
    for (const id of requirement.sourceExperienceIds) ids.add(id);
  }
  return [...ids].sort();
}

function rewriteFocusDimensions(
  dimensions: Array<{ dimension: ResumeOptimizationRubricDimension; band: string; score: number }>,
): ResumeOptimizationRubricDimension[] {
  return dimensions
    .filter((item) => item.dimension !== "application_readiness" && item.band !== "strong")
    .sort((a, b) => a.score - b.score || a.dimension.localeCompare(b.dimension))
    .map((item) => item.dimension)
    .slice(0, 5);
}

function importanceRank(value: string): number {
  if (value === "critical") return 4;
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}
